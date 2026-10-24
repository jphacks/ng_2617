import type { Board, Card } from '../domain/board';
import type { BoardCommand, BoardEvent, CardContent } from '../domain/board-protocol';
import { generateWordSuggestions } from './ai-service';

type EditCommand = Exclude<BoardCommand, { type: 'board.get' } | { type: 'idle.heartbeat' }>;
type Snapshot = Extract<BoardEvent, { type: 'board.snapshot' }>;
export type EditResult = { status: number; body: BoardEvent | { error: string } };
type Lock = { userId: string; clientId: string; lockId: string; expiresAt: number };
type Entry = { board: Board; revision: number; locks: Map<string, Lock> };
type ClientIdleState = { isIdle: boolean; lastUpdated: number };

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
    (value.type === 'edit.commit' && id(value.lockId) && content(value.content));
}

/** 単一プロセスの同期処理。検証〜更新の間にawaitを入れず、競合確認と確定を一体にする。 */
export function createBoardService(
  initialBoards: readonly Board[],
  options: { now?: () => number; createLockId?: () => string; lockTtlMs?: number; idleThresholdMs?: number } = {},
) {
  const now = options.now ?? Date.now;
  const createLockId = options.createLockId ?? (() => crypto.randomUUID());
  const lockTtlMs = options.lockTtlMs ?? 5 * 60_000;
  const idleThresholdMs = options.idleThresholdMs ?? 10 * 60_000; // デフォルト10分
  if (!Number.isFinite(lockTtlMs) || lockTtlMs <= 0) throw new Error('Invalid lock TTL');
  if (!Number.isFinite(idleThresholdMs) || idleThresholdMs <= 0) throw new Error('Invalid idle threshold');
  const boards = new Map<string, Entry>(initialBoards.map(board => [board.boardId, {
    board: structuredClone(board), revision: 0, locks: new Map(),
  }]));
  const clientIdleStates = new Map<string, ClientIdleState>(); // clientId -> idle state

  function replace(entry: Entry, card: Card) {
    entry.board = { ...entry.board, cards: entry.board.cards.map(current => current.cardId === card.cardId ? card : current) };
    entry.revision += 1;
  }
  function withoutEditor(card: Card): Card {
    return { cardId: card.cardId, shape: card.shape, position: { ...card.position }, color: card.color, text: card.text, font: card.font };
  }
  function expire(entry: Entry) {
    const time = now();
    for (const [cardId, lock] of entry.locks) {
      if (lock.expiresAt <= time) {
        entry.locks.delete(cardId);
        const card = entry.board.cards.find(item => item.cardId === cardId);
        if (card) replace(entry, withoutEditor(card));
      }
    }
  }
  function snapshot(entry: Entry): Snapshot {
    return { type: 'board.snapshot', board: structuredClone(entry.board), revision: entry.revision };
  }

  function updateClientIdleState(clientId: string, isIdle: boolean) {
    clientIdleStates.set(clientId, { isIdle, lastUpdated: now() });
  }

  function areAllClientsIdle(): boolean {
    if (clientIdleStates.size === 0) return false;
    const time = now();
    for (const [clientId, state] of clientIdleStates) {
      // 最終更新からしきい値時間経過していないクライアントは考慮しない
      if (time - state.lastUpdated > idleThresholdMs) {
        clientIdleStates.delete(clientId);
        continue;
      }
      if (!state.isIdle) return false;
    }
    return clientIdleStates.size > 0;
  }

  function hasLockedCards(entry: Entry): boolean {
    return entry.locks.size > 0;
  }

  function shouldTriggerAiGeneration(entry: Entry): boolean {
    // 編集中のカードがある場合はAI生成をスキップ
    if (hasLockedCards(entry)) return false;
    // 全員がアイドル状態かチェック
    return areAllClientsIdle();
  }

  async function triggerAiGeneration(entry: Entry) {
    const suggestions = await generateWordSuggestions(entry.board);
    // 各単語を新しいカードとして追加
    for (const word of suggestions) {
      const newCard: Card = {
        cardId: crypto.randomUUID(),
        shape: 'rectangle',
        position: { 
          x: 250 + Math.random() * 200, 
          y: 150 + Math.random() * 200, 
          z: entry.board.cards.length 
        },
        color: '#f0f0f0',
        text: word,
        font: 'sans-serif',
      };
      entry.board = { ...entry.board, cards: [...entry.board.cards, newCard] };
      entry.revision += 1;
    }
  }
  function executeEdit(input: unknown, expectedBoardId?: string): EditResult {
    // idle.heartbeatコマンドの処理
    if (record(input) && input.type === 'idle.heartbeat' && id(input.boardId) && id(input.userId) && id(input.clientId) && id(input.requestId)) {
      const command = structuredClone(input) as { boardId: string; clientId: string; isIdle: boolean };
      updateClientIdleState(command.clientId, command.isIdle);
      
      const entry = boards.get(command.boardId);
      if (!entry) return { status: 404, body: { error: 'ボードが見つかりません。' } };
      
      // 全員がアイドル状態かつ編集中のカードがない場合、AI生成をトリガー
      if (shouldTriggerAiGeneration(entry)) {
        triggerAiGeneration(entry).catch(err => console.error('AI generation failed:', err));
      }
      
      return { status: 200, body: { ...snapshot(entry), type: 'board.snapshot' } };
    }

    if (!editCommand(input) || (expectedBoardId !== undefined && input.boardId !== expectedBoardId)) {
      return { status: 400, body: { error: '編集要求の形式またはボードIDが不正です。' } };
    }
    // 呼び出し側が保持するオブジェクトを保存領域へ持ち込まない。
    const command = structuredClone(input);
    const entry = boards.get(command.boardId);
    if (!entry) return { status: 404, body: { error: 'ボードが見つかりません。' } };
    expire(entry);
    const reply = { clientId: command.clientId, requestId: command.requestId, cardId: command.cardId };
    const reject = (status: number, reason: string): EditResult => ({
      status, body: { ...snapshot(entry), ...reply, type: 'edit.rejected', reason },
    });
    const card = entry.board.cards.find(item => item.cardId === command.cardId);
    if (!card) return reject(404, 'カードが見つかりません。');
    const lock = entry.locks.get(command.cardId);
    if (command.type === 'edit.request') {
      if (lock || card.editingUser) return reject(409, 'このカードは既に編集中です。');
      const lockId = createLockId();
      entry.locks.set(card.cardId, {
        userId: command.userId, clientId: command.clientId, lockId, expiresAt: now() + lockTtlMs,
      });
      replace(entry, { ...card, editingUser: { userId: command.userId } });
      return { status: 200, body: { ...snapshot(entry), ...reply, type: 'edit.granted', lockId } };
    }
    if (!lock || lock.userId !== command.userId || lock.clientId !== command.clientId || lock.lockId !== command.lockId) {
      return reject(403, '有効な編集権がありません。再度編集許可を取得してください。');
    }
    // 内容の確定とロック解除を、1回の更新として反映する。
    const nextCard = command.type === 'edit.commit'
      ? { ...command.content, cardId: card.cardId }
      : withoutEditor(card);
    replace(entry, nextCard);
    entry.locks.delete(card.cardId);
    
    // ロック解除後、全員がアイドル状態ならAI生成をトリガー
    if (shouldTriggerAiGeneration(entry)) {
      triggerAiGeneration(entry).catch(err => console.error('AI generation failed:', err));
    }
    
    return {
      status: 200,
      body: { ...snapshot(entry), ...reply, type: command.type === 'edit.commit' ? 'edit.committed' : 'edit.cancelled' },
    };
  }
  return {
    getBoardSnapshot(boardId: string): Snapshot | undefined {
      const entry = boards.get(boardId);
      if (!entry) return undefined;
      expire(entry);
      return snapshot(entry);
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
  };
}
