import type { Board, Card } from '../domain/board';
import type { BoardCommand, BoardEvent, CardContent, ClientIdentity } from '../domain/board-protocol';
import { cardContent, sameCardContent } from '../domain/board-protocol.ts';
import { generateWordSuggestions } from './ai-service.ts';
import {
  EDIT_LOCK_TTL_MS, EDIT_REPLY_TIMEOUT_MS, WORD_ADDITION_DELAY_MS, WORD_ADDITION_COUNT,
  scheduleTimeout, type Schedule,
} from './edit-lifecycle.ts';
import { suggestionCards } from './word-addition.ts';

type EditCommand = Exclude<BoardCommand, { type: 'board.get' }>;
type Snapshot = Extract<BoardEvent, { type: 'board.snapshot' }>;
export type EditResult = { status: number; body: BoardEvent | { error: string } };
type UpdateKind = 'edit-requested' | 'edit-committed' | 'edit-cancelled' | 'edit-saved' | 'edit-released' | 'auto-generated';
type Lock = {
  userId: string; clientId: string; lockId: string; generation: number;
  cancelDeadline?: () => void;
  check?: { checkId: string; cancelTimeout: () => void };
};
type Subscriber = { identity: ClientIdentity; receive: (event: BoardEvent) => void };
type Entry = {
  board: Board; revision: number; locks: Map<string, Lock>; subscribers: Set<Subscriber>;
  lastUpdate?: { kind: UpdateKind; at: number; revision: number };
  generation: number; cancelAddition?: () => void; generating?: number;
};
type Context = {
  entry: Entry; card: Card; command: EditCommand;
  reply: { clientId: string; requestId: string; cardId: string };
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}
function content(value: unknown): value is CardContent {
  return record(value) && Object.keys(value).every(key =>
    ['shape', 'position', 'color', 'text', 'font'].includes(key)) &&
    typeof value.shape === 'string' && value.shape.length <= 128 &&
    typeof value.color === 'string' && value.color.length <= 128 &&
    typeof value.font === 'string' && value.font.length <= 256 &&
    typeof value.text === 'string' && value.text.length <= 100_000 &&
    record(value.position) && Object.keys(value.position).every(key => ['x', 'y', 'z'].includes(key)) &&
    [value.position.x, value.position.y, value.position.z].every(n => typeof n === 'number' && Number.isFinite(n));
}
function editCommand(value: unknown): value is EditCommand {
  if (!record(value) || ![value.boardId, value.userId, value.clientId, value.requestId, value.cardId].every(id)) return false;
  return value.type === 'edit.request' ||
    (value.type === 'edit.cancel' && id(value.lockId)) ||
    (value.type === 'edit.commit' && id(value.lockId) && content(value.content)) ||
    (value.type === 'edit.check.reply' && id(value.lockId) && id(value.checkId) &&
      ((value.changed === true && content(value.content)) || (value.changed === false && value.content === undefined)));
}

/** 単一プロセス用。検証〜更新にawaitを挟まず、非同期生成の結果は世代とrevisionで再検証する。 */
export function createBoardService(
  initialBoards: readonly Board[],
  options: {
    now?: () => number; schedule?: Schedule; createLockId?: () => string; createCheckId?: () => string;
    lockTtlMs?: number; replyTimeoutMs?: number; additionDelayMs?: number;
    generateSuggestions?: (board: Board) => Promise<readonly string[]>;
    onGenerationError?: (error: unknown) => void;
  } = {},
) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? scheduleTimeout;
  const createLockId = options.createLockId ?? (() => crypto.randomUUID());
  const createCheckId = options.createCheckId ?? (() => crypto.randomUUID());
  const generate = options.generateSuggestions ?? generateWordSuggestions;
  const lockTtlMs = options.lockTtlMs ?? EDIT_LOCK_TTL_MS;
  const replyTimeoutMs = options.replyTimeoutMs ?? EDIT_REPLY_TIMEOUT_MS;
  const additionDelayMs = options.additionDelayMs ?? WORD_ADDITION_DELAY_MS;
  for (const duration of [lockTtlMs, replyTimeoutMs, additionDelayMs]) {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid lifecycle timeout');
  }
  let disposed = false;
  const boards = new Map<string, Entry>(initialBoards.map(board => [board.boardId, {
    // 永続ロックはないため、初期データの編集者は復元しない。初期取得だけでは生成を始めない。
    board: { ...structuredClone(board), cards: board.cards.map(withoutEditor) },
    revision: 0, locks: new Map(), subscribers: new Set(), generation: 0,
  }]));

  function replace(entry: Entry, card: Card) {
    entry.board = { ...entry.board, cards: entry.board.cards.map(current => current.cardId === card.cardId ? card : current) };
    entry.revision += 1;
  }
  function withoutEditor(card: Card): Card {
    return { cardId: card.cardId, ...cardContent(card) };
  }
  function snapshot(entry: Entry): Snapshot {
    return { type: 'board.snapshot', board: structuredClone(entry.board), revision: entry.revision };
  }
  function deliver(entry: Entry, subscriber: Subscriber, event: BoardEvent) {
    try { subscriber.receive(structuredClone(event)); }
    catch { entry.subscribers.delete(subscriber); }
  }
  function notify(entry: Entry, event: BoardEvent, userId?: string) {
    for (const subscriber of entry.subscribers) {
      const own = 'clientId' in event && event.clientId === subscriber.identity.clientId &&
        userId === subscriber.identity.userId;
      // 他端末には編集権ID・問い合わせIDを配信しない。
      deliver(entry, subscriber, own ? event : snapshot(entry));
    }
  }
  function query(entry: Entry, cardId: string, lock: Lock) {
    if (!lock.check) return;
    const event: BoardEvent = {
      ...snapshot(entry), type: 'edit.check', cardId, userId: lock.userId, clientId: lock.clientId,
      lockId: lock.lockId, checkId: lock.check.checkId,
    };
    for (const subscriber of entry.subscribers) {
      if (subscriber.identity.userId === lock.userId && subscriber.identity.clientId === lock.clientId) {
        deliver(entry, subscriber, event);
      }
    }
  }
  function stopLockTimers(lock: Lock) {
    lock.generation += 1;
    lock.cancelDeadline?.();
    lock.cancelDeadline = undefined;
    lock.check?.cancelTimeout();
    lock.check = undefined;
  }
  function armLock(entry: Entry, cardId: string, lock: Lock) {
    stopLockTimers(lock);
    const generation = lock.generation;
    lock.cancelDeadline = schedule(() => {
      if (disposed || entry.locks.get(cardId) !== lock || lock.generation !== generation) return;
      lock.cancelDeadline = undefined;
      const checkId = createCheckId();
      lock.check = { checkId, cancelTimeout: schedule(() => {
        if (disposed || entry.locks.get(cardId) !== lock || lock.generation !== generation ||
            lock.check?.checkId !== checkId) return;
        const card = entry.board.cards.find(card => card.cardId === cardId)!;
        replace(entry, withoutEditor(card));
        onLockReleased(entry, cardId, lock);
        onBoardUpdated(entry, 'edit-released', {
          ...snapshot(entry), type: 'edit.released', cardId, userId: lock.userId,
          clientId: lock.clientId, lockId: lock.lockId, reason: 'timeout',
        }, lock.userId);
      }, replyTimeoutMs) };
      query(entry, cardId, lock);
    }, lockTtlMs);
  }
  function onLockAcquired(entry: Entry, cardId: string, lock: Lock) {
    armLock(entry, cardId, lock);
  }
  function onLockReleased(entry: Entry, cardId: string, lock: Lock) {
    stopLockTimers(lock);
    entry.locks.delete(cardId);
  }
  function waitForAddition(entry: Entry) {
    if (disposed || entry.locks.size || !entry.lastUpdate) return;
    const generation = entry.generation;
    const revision = entry.revision;
    entry.cancelAddition = schedule(() => {
      if (disposed || generation !== entry.generation || revision !== entry.revision) return;
      entry.cancelAddition = undefined;
      if (entry.locks.size || !entry.lastUpdate || entry.lastUpdate.kind === 'auto-generated' ||
          entry.generating !== undefined) return;
      entry.generating = generation;
      void addSuggestions(entry, generation, revision);
    }, Math.max(0, entry.lastUpdate.at + additionDelayMs - now()));
  }
  function onBoardUpdated(entry: Entry, kind: UpdateKind, event: BoardEvent, userId?: string) {
    entry.lastUpdate = { kind, at: now(), revision: entry.revision };
    entry.generation += 1;
    entry.cancelAddition?.();
    entry.cancelAddition = undefined;
    // 自動生成後も予約する。再生成の抑止は満了時の最新の更新種別で判定する。
    waitForAddition(entry);
    notify(entry, event, userId);
  }
  async function addSuggestions(entry: Entry, generation: number, revision: number) {
    const current = () => !disposed && entry.generation === generation && entry.revision === revision && !entry.locks.size;
    try {
      const words = await generate(structuredClone(entry.board));
      if (!current()) return;
      const cards = suggestionCards(entry.board, words, WORD_ADDITION_COUNT);
      if (!cards.length) return;
      entry.board = { ...entry.board, cards: [...entry.board.cards, ...cards] };
      entry.revision += 1;
      onBoardUpdated(entry, 'auto-generated', snapshot(entry));
    } catch (error) {
      // 自動再試行しない。次の実際の更新で再度候補生成の機会を作る。
      if (current()) {
        if (options.onGenerationError) options.onGenerationError(error);
        else console.error('Word generation failed:', error);
      }
    } finally {
      entry.generating = undefined;
      // 古い生成中に次の編集が完了し、その待機まで満了した場合も取りこぼさない。
      if (!disposed && entry.generation !== generation && !entry.cancelAddition &&
          entry.lastUpdate?.kind !== 'auto-generated') waitForAddition(entry);
    }
  }
  function reject(entry: Entry, reply: Context['reply'], status: number, reason: string): EditResult {
    return { status, body: { ...snapshot(entry), ...reply, type: 'edit.rejected', reason } };
  }
  function handleRequest({ entry, card, command, reply }: Context): EditResult {
    if (entry.locks.has(card.cardId) || card.editingUser) return reject(entry, reply, 409, 'このカードは既に編集中です。');
    const lock: Lock = { userId: command.userId, clientId: command.clientId, lockId: createLockId(), generation: 0 };
    entry.locks.set(card.cardId, lock);
    replace(entry, { ...card, editingUser: { userId: command.userId } });
    onLockAcquired(entry, card.cardId, lock);
    const event: BoardEvent = { ...snapshot(entry), ...reply, type: 'edit.granted', lockId: lock.lockId };
    onBoardUpdated(entry, 'edit-requested', event, command.userId);
    return { status: 200, body: event };
  }
  function handleCommit(context: Context, lock: Lock): EditResult {
    const { entry, card, command, reply } = context;
    if (command.type !== 'edit.commit') throw new Error('Expected commit');
    replace(entry, { ...command.content, cardId: card.cardId });
    onLockReleased(entry, card.cardId, lock);
    const event: BoardEvent = { ...snapshot(entry), ...reply, type: 'edit.committed' };
    onBoardUpdated(entry, 'edit-committed', event, command.userId);
    return { status: 200, body: event };
  }
  function handleCancel({ entry, card, command, reply }: Context, lock: Lock): EditResult {
    replace(entry, withoutEditor(card));
    onLockReleased(entry, card.cardId, lock);
    const event: BoardEvent = { ...snapshot(entry), ...reply, type: 'edit.cancelled' };
    onBoardUpdated(entry, 'edit-cancelled', event, command.userId);
    return { status: 200, body: event };
  }
  function handleCheckReply({ entry, card, command, reply }: Context, lock: Lock): EditResult {
    if (command.type !== 'edit.check.reply') throw new Error('Expected check reply');
    if (lock.check?.checkId !== command.checkId) return reject(entry, reply, 409, 'この期限確認は既に終了しています。');
    const changed = command.changed && !sameCardContent(card, command.content);
    if (changed && command.changed) {
      replace(entry, { ...command.content, cardId: card.cardId, editingUser: { userId: lock.userId } });
      armLock(entry, card.cardId, lock);
    } else {
      replace(entry, withoutEditor(card));
      onLockReleased(entry, card.cardId, lock);
    }
    const event: BoardEvent = {
      ...snapshot(entry), ...reply, type: 'edit.checked', lockId: lock.lockId,
      checkId: command.checkId, outcome: changed ? 'saved' : 'released',
    };
    onBoardUpdated(entry, changed ? 'edit-saved' : 'edit-released', event, command.userId);
    return { status: 200, body: event };
  }
  function executeEdit(input: unknown, expectedBoardId?: string): EditResult {
    if (disposed) return { status: 503, body: { error: 'ボードサービスは停止しています。' } };
    if (!editCommand(input) || (expectedBoardId !== undefined && input.boardId !== expectedBoardId)) {
      return { status: 400, body: { error: '編集要求の形式またはボードIDが不正です。' } };
    }
    const command = structuredClone(input);
    const entry = boards.get(command.boardId);
    if (!entry) return { status: 404, body: { error: 'ボードが見つかりません。' } };
    const reply = { clientId: command.clientId, requestId: command.requestId, cardId: command.cardId };
    const card = entry.board.cards.find(item => item.cardId === command.cardId);
    if (!card) return reject(entry, reply, 404, 'カードが見つかりません。');
    const context = { entry, card, command, reply };
    if (command.type === 'edit.request') return handleRequest(context);
    const lock = entry.locks.get(command.cardId);
    if (!lock || lock.userId !== command.userId || lock.clientId !== command.clientId || lock.lockId !== command.lockId) {
      return reject(entry, reply, 403, '有効な編集権がありません。再度編集許可を取得してください。');
    }
    switch (command.type) {
      case 'edit.commit': return handleCommit(context, lock);
      case 'edit.cancel': return handleCancel(context, lock);
      case 'edit.check.reply': return handleCheckReply(context, lock);
    }
  }
  return {
    getBoardSnapshot(boardId: string): Snapshot | undefined {
      const entry = boards.get(boardId);
      return entry && !disposed ? snapshot(entry) : undefined;
    },
    subscribeBoard(identity: ClientIdentity, receive: (event: BoardEvent) => void): (() => void) | undefined {
      const entry = boards.get(identity.boardId);
      if (disposed || !entry || ![identity.userId, identity.clientId, identity.boardId].every(id)) return undefined;
      const subscriber = { identity: { ...identity }, receive };
      entry.subscribers.add(subscriber);
      deliver(entry, subscriber, snapshot(entry));
      // 再購読はタイマーを更新しない。応答待ちなら同じ問い合わせを再配信する。
      for (const [cardId, lock] of entry.locks) {
        if (lock.check && lock.userId === identity.userId && lock.clientId === identity.clientId) {
          deliver(entry, subscriber, {
            ...snapshot(entry), type: 'edit.check', cardId, userId: lock.userId,
            clientId: lock.clientId, lockId: lock.lockId, checkId: lock.check.checkId,
          });
        }
      }
      return () => { entry.subscribers.delete(subscriber); };
    },
    createBoard(boardId: string): Snapshot {
      if (boards.has(boardId)) {
        const entry = boards.get(boardId)!;
        return snapshot(entry);
      }
      const newBoard: Board = {
        boardId,
        cards: [{
          cardId: crypto.randomUUID(),
          shape: 'rectangle',
          position: { x: 250, y: 150, z: 0 },
          color: '#ffffff',
          text: '💡 ブレインストーミング起点',
          font: 'sans-serif',
        }],
      };
      boards.set(boardId, {
        board: newBoard,
        revision: 0,
        locks: new Map(),
      });
      return snapshot(boards.get(boardId)!);
    },
    executeEdit,
    requestEdit(command: Extract<EditCommand, { type: 'edit.request' }>) { return executeEdit(command); },
    commitEdit(command: Extract<EditCommand, { type: 'edit.commit' }>) { return executeEdit(command); },
    cancelEdit(command: Extract<EditCommand, { type: 'edit.cancel' }>) { return executeEdit(command); },
    replyToEditCheck(command: Extract<EditCommand, { type: 'edit.check.reply' }>) { return executeEdit(command); },
    dispose() {
      disposed = true;
      for (const entry of boards.values()) {
        entry.generation += 1;
        entry.cancelAddition?.();
        entry.locks.forEach(stopLockTimers);
        entry.subscribers.clear();
      }
    },
  };
}
