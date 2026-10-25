import type { Board, BoardObjectId, Card, CardId, RelationLevel } from '../domain/board';
import { createBoard, createSample, getCard, isEmpty, objectKey, removeObjects, sameObjectId, TIMER_DURATION_MS } from '../domain/board.ts';
import type { BoardCommand, BoardEvent, CardChange, ClientIdentity, EditCommand, GenerationState, SnapshotData } from '../domain/board-protocol';
import { canonical, commandFingerprint } from '../domain/board-protocol.ts';
import { arrowConnectionKey, validBoard, validCard, validCommand, validId } from '../domain/board-validation.ts';
import { generateWordSuggestions } from './ai-service.ts';
import { EDIT_LOCK_TTL_MS, EDIT_REPLY_TIMEOUT_MS, WORD_ADDITION_DELAY_MS, WORD_ADDITION_COUNT, scheduleTimeout, type Schedule } from './edit-lifecycle.ts';
import { suggestionCards } from './word-addition.ts';
import { onTimerFinished } from './board-timer.ts';

export type EditResult = { status: number; body: BoardEvent | { error: string } };
export type UpdateKind = 'edit-requested' | 'edit-committed' | 'edit-cancelled' | 'edit-saved' | 'edit-released' |
  'card-created' | 'objects-deleted' | 'sample-restored' | 'reaction-changed' | 'arrow-created' | 'auto-generated' | 'timer';
export type BoardUpdate = Readonly<{ boardId: string; objectIds: readonly BoardObjectId[]; kind: UpdateKind; revision: number }>;
type Lock = {
  cardIds: readonly CardId[]; userId: string; clientId: string; lockId: string; expiresAt: number; generation: number;
  cancelDeadline?: () => void; check?: { checkId: string; cancelTimeout: () => void };
};
type Subscriber = { identity: ClientIdentity; receive: (event: BoardEvent) => void };
type Entry = {
  board: Board; revision: number; locks: Map<string, Lock>; cardLocks: Map<string, string>; subscribers: Set<Subscriber>;
  lastUpdate?: { kind: UpdateKind; at: number }; cardVersion: number; cancelAddition?: () => void;
  generation: GenerationState; generationSequence: number; generating?: string;
  timerVersion: number; cancelTimer?: () => void;
  results: Map<string, { fingerprint: string; result?: EditResult }>;
};
type Detail = BoardEvent extends infer E ? E extends BoardEvent ? Omit<E, keyof SnapshotData> : never : never;

/** 単一プロセス用。検証・一括変更・更新確定の間にawaitを挟まない。 */
export function createBoardService(initialBoards: readonly Board[], options: {
  now?: () => number; schedule?: Schedule; createLockId?: () => string; createCheckId?: () => string;
  lockTtlMs?: number; replyTimeoutMs?: number; additionDelayMs?: number;
  generateSuggestions?: (board: Board, level: RelationLevel) => Promise<readonly string[]>;
  onGenerationError?: (error: unknown) => void; onBoardUpdated?: (update: BoardUpdate) => void;
  onTimerFinished?: (board: Board) => void;
} = {}) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? scheduleTimeout;
  const lockTtlMs = options.lockTtlMs ?? EDIT_LOCK_TTL_MS;
  const replyTimeoutMs = options.replyTimeoutMs ?? EDIT_REPLY_TIMEOUT_MS;
  const additionDelayMs = options.additionDelayMs ?? WORD_ADDITION_DELAY_MS;
  for (const duration of [lockTtlMs, replyTimeoutMs, additionDelayMs]) {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid lifecycle timeout');
  }
  const generate = options.generateSuggestions ?? generateWordSuggestions;
  let disposed = false;
  const boards = new Map<string, Entry>();
  const withoutEditor = (card: Card): Card => {
    const copy = { ...card }; delete copy.editingUser; return copy;
  };
  function addBoard(board: Board) {
    if (!validBoard(board)) throw new Error('Invalid initial board');
    if (boards.has(board.boardId)) throw new Error('Duplicate board');
    const entry: Entry = {
      board: { ...structuredClone(board), cards: board.cards.map(card => withoutEditor(structuredClone(card))) },
      revision: 0, locks: new Map(), cardLocks: new Map(), subscribers: new Set(), cardVersion: 0,
      generation: { status: 'idle' }, generationSequence: 0, timerVersion: 0, results: new Map(),
    };
    boards.set(board.boardId, entry);
    armTimer(entry);
    return entry;
  }
  function snapshot(entry: Entry): SnapshotData & { type: 'board.snapshot' } {
    return structuredClone({ type: 'board.snapshot', board: entry.board, revision: entry.revision,
      serverNow: now(), generation: entry.generation, generationSequence: entry.generationSequence });
  }
  function event(entry: Entry, detail: Detail): BoardEvent { return { ...snapshot(entry), ...detail } as BoardEvent; }
  function deliver(entry: Entry, subscriber: Subscriber, value: BoardEvent) {
    try { subscriber.receive(structuredClone(value)); } catch { entry.subscribers.delete(subscriber); }
  }
  function notify(entry: Entry, value: BoardEvent, userId?: string) {
    for (const subscriber of entry.subscribers) {
      const targeted = 'clientId' in value;
      const own = targeted && value.clientId === subscriber.identity.clientId && userId === subscriber.identity.userId;
      deliver(entry, subscriber, targeted && !own ? snapshot(entry) : value);
    }
  }
  function stopLockTimers(lock: Lock) {
    lock.generation++;
    lock.cancelDeadline?.(); lock.cancelDeadline = undefined;
    lock.check?.cancelTimeout(); lock.check = undefined;
  }
  function onLockReleased(entry: Entry, lock: Lock) {
    stopLockTimers(lock);
    entry.locks.delete(lock.lockId);
    for (const id of lock.cardIds) entry.cardLocks.delete(objectKey(id));
    const ids = new Set(lock.cardIds.map(objectKey));
    entry.board = { ...entry.board, cards: entry.board.cards.map(card => ids.has(objectKey(card.cardId)) ? withoutEditor(card) : card) };
  }
  function query(entry: Entry, lock: Lock) {
    if (!lock.check) return;
    const value = event(entry, { type: 'edit.check', cardIds: lock.cardIds, lockId: lock.lockId,
      checkId: lock.check.checkId, userId: lock.userId, clientId: lock.clientId });
    for (const subscriber of entry.subscribers) {
      if (subscriber.identity.userId === lock.userId && subscriber.identity.clientId === lock.clientId) deliver(entry, subscriber, value);
    }
  }
  function onLockAcquired(entry: Entry, lock: Lock) {
    stopLockTimers(lock);
    const generation = lock.generation;
    lock.expiresAt = now() + lockTtlMs;
    lock.cancelDeadline = schedule(() => {
      if (disposed || entry.locks.get(lock.lockId) !== lock || lock.generation !== generation) return;
      lock.cancelDeadline = undefined;
      const checkId = options.createCheckId?.() ?? crypto.randomUUID();
      lock.check = { checkId, cancelTimeout: schedule(() => {
        if (disposed || entry.locks.get(lock.lockId) !== lock || lock.generation !== generation || lock.check?.checkId !== checkId) return;
        onLockReleased(entry, lock);
        onBoardUpdated(entry, 'edit-released', lock.cardIds, {
          type: 'edit.released', cardIds: lock.cardIds, lockId: lock.lockId, userId: lock.userId, clientId: lock.clientId, reason: 'timeout',
        }, lock.userId);
      }, replyTimeoutMs) };
      query(entry, lock);
    }, lockTtlMs);
  }
  function waitForAddition(entry: Entry) {
    if (disposed || entry.locks.size || !entry.lastUpdate) return;
    const version = entry.cardVersion;
    entry.cancelAddition = schedule(() => {
      if (disposed || entry.cardVersion !== version) return;
      entry.cancelAddition = undefined;
      if (entry.locks.size || isEmpty(entry.board) || entry.lastUpdate?.kind === 'auto-generated' || entry.generating) return;
      startGeneration(entry, 'mid', 'automatic');
    }, Math.max(0, entry.lastUpdate.at + additionDelayMs - now()));
  }
  function onBoardUpdated(entry: Entry, kind: UpdateKind, ids: readonly BoardObjectId[], detail?: Detail, userId?: string): BoardEvent {
    entry.revision++;
    if (kind !== 'timer') {
      entry.cardVersion++;
      entry.lastUpdate = { kind, at: now() };
      entry.cancelAddition?.(); entry.cancelAddition = undefined;
      waitForAddition(entry);
    }
    const unique = [...new Map(ids.map(id => [objectKey(id), id])).values()];
    options.onBoardUpdated?.(structuredClone({ boardId: entry.board.boardId, objectIds: unique, kind, revision: entry.revision }));
    const value = event(entry, detail ?? { type: 'board.snapshot' });
    notify(entry, value, userId);
    return value;
  }
  function setGeneration(entry: Entry, generation: GenerationState) {
    entry.generation = generation; entry.generationSequence++;
    notify(entry, event(entry, { type: 'generation.updated' }));
  }
  function startGeneration(entry: Entry, level: RelationLevel, source: 'manual' | 'automatic') {
    const generationId = crypto.randomUUID();
    const version = entry.cardVersion;
    const input = structuredClone(entry.board);
    entry.cancelAddition?.(); entry.cancelAddition = undefined;
    entry.generating = generationId;
    setGeneration(entry, { status: 'running', generationId, level, source });
    const current = () => !disposed && entry.cardVersion === version && !entry.locks.size;
    // HTTPの受付を確定してから非同期の生成を進める。
    void Promise.resolve().then(async () => {
      try {
        const words = await generate(input, level);
        if (disposed) return;
        if (!current()) {
          setGeneration(entry, { status: 'discarded', generationId, level, source, message: 'ボードが更新されたため、今回の候補は追加されませんでした。' });
          return;
        }
        const cards = suggestionCards(entry.board, words, WORD_ADDITION_COUNT);
        if (!cards.length) {
          setGeneration(entry, { status: 'completed', generationId, level, source, message: '新しい候補はありませんでした。' });
          return;
        }
        // 最新Boardへ追加し、生成中の共有タイマー更新を維持する。
        entry.board = { ...entry.board, cards: [...entry.board.cards, ...cards] };
        entry.generation = { status: 'completed', generationId, level, source, message: `${cards.length}枚の候補を追加しました。` };
        entry.generationSequence++;
        onBoardUpdated(entry, 'auto-generated', cards.map(card => card.cardId), {
          type: 'board.cards-generated', eventId: crypto.randomUUID(), generationId, generatedCardIds: cards.map(card => card.cardId),
        });
      } catch (error) {
        if (!disposed) {
          setGeneration(entry, { status: current() ? 'failed' : 'discarded', generationId, level, source,
            message: current() ? '候補の生成に失敗しました。もう一度お試しください。' : 'ボードが更新されたため、今回の候補は追加されませんでした。' });
          if (options.onGenerationError) options.onGenerationError(error);
          else console.error('Word generation failed:', error);
        }
      } finally {
        entry.generating = undefined;
        // 古い生成中に次の待機まで満了していた場合も、更新後の機会を取りこぼさない。
        if (!disposed && entry.cardVersion !== version && entry.lastUpdate?.kind !== 'auto-generated' && !entry.cancelAddition) waitForAddition(entry);
      }
    });
    return generationId;
  }
  function armTimer(entry: Entry) {
    entry.cancelTimer?.(); entry.cancelTimer = undefined;
    const version = ++entry.timerVersion;
    const timer = entry.board.timer;
    if (timer.state !== 'running') return;
    entry.cancelTimer = schedule(() => {
      if (disposed || entry.timerVersion !== version || entry.board.timer.state !== 'running') return;
      entry.cancelTimer = undefined;
      entry.board = { ...entry.board, timer: { durationMs: TIMER_DURATION_MS, state: 'stopped', remainingMs: 0 } };
      onBoardUpdated(entry, 'timer', []);
      (options.onTimerFinished ?? onTimerFinished)(structuredClone(entry.board));
    }, Math.max(0, timer.endsAt - now()));
  }
  function reject(entry: Entry, command: BoardCommand, status: number, reason: string): EditResult {
    return { status, body: event(entry, { type: 'command.rejected', clientId: command.clientId,
      requestId: command.requestId, commandType: command.type, reason }) };
  }
  function accepted(entry: Entry, command: BoardCommand, changed = false): EditResult {
    return { status: 200, body: event(entry, { type: 'command.accepted', clientId: command.clientId,
      requestId: command.requestId, commandType: command.type, changed }) };
  }
  function sameIds(a: readonly CardId[], b: readonly CardId[]) {
    return a.length === b.length && a.every(id => b.some(other => sameObjectId(id, other)));
  }
  /** 全変更を検証してから一括適用する。最新リアクションは常に維持。 */
  function changedCards(entry: Entry, lock: Lock, changes: readonly CardChange[]): Card[] | string {
    if (!sameIds(lock.cardIds, changes.map(change => change.cardId))) return '貸し出し対象と保存対象が一致しません。';
    const updated: Card[] = [];
    for (const change of changes) {
      const saved = getCard(entry.board, change.cardId);
      if (!saved) return 'カードが見つかりません。';
      if (saved.cardKind === 'word' && change.patch.relatedIds !== undefined) return '通常付箋には関連先を設定できません。';
      let card = { ...saved, ...change.patch } as Card;
      if (card.cardKind === 'block') {
        if (card.relatedIds.some(id => sameObjectId(id, card.cardId))) return '自分自身は関連付けできません。';
        card = { ...card, reactions: saved.cardKind === 'block' ? saved.reactions : [],
          relatedIds: card.relatedIds.filter(id => getCard(entry.board, id)) };
      }
      if (!validCard(card)) return 'カードの内容・寸法が不正です。';
      updated.push(card);
    }
    return updated;
  }
  function applyCards(entry: Entry, cards: readonly Card[]) {
    const changed = new Map(cards.map(card => [objectKey(card.cardId), card]));
    entry.board = { ...entry.board, cards: entry.board.cards.map(card => changed.get(objectKey(card.cardId)) ?? card) };
  }
  function finishEdit(entry: Entry, lock: Lock, command: EditCommand, cards?: readonly Card[], checkId?: string): EditResult {
    if (cards) applyCards(entry, cards);
    onLockReleased(entry, lock);
    const reply = { clientId: command.clientId, requestId: command.requestId, lockId: lock.lockId, cardIds: lock.cardIds };
    const detail: Detail = checkId
      ? { ...reply, type: 'edit.checked', checkId, outcome: cards ? 'committed' : 'cancelled' }
      : { ...reply, type: cards ? 'edit.committed' : 'edit.cancelled' };
    return { status: 200, body: onBoardUpdated(entry, cards ? 'edit-committed' : 'edit-cancelled', lock.cardIds, detail, command.userId) };
  }
  function handleEdit(entry: Entry, command: EditCommand): EditResult {
    if (command.type === 'edit.request') {
      const cards = command.cardIds.map(id => getCard(entry.board, id));
      if (cards.some(card => !card)) return reject(entry, command, 404, 'カードが見つかりません。');
      if (command.cardIds.some(id => entry.cardLocks.has(objectKey(id)))) return reject(entry, command, 409, '対象に編集中のカードがあります。');
      const lock: Lock = { cardIds: command.cardIds, userId: command.userId, clientId: command.clientId,
        lockId: options.createLockId?.() ?? crypto.randomUUID(), expiresAt: 0, generation: 0 };
      if (entry.locks.has(lock.lockId)) return reject(entry, command, 409, '編集権IDが重複しています。');
      entry.locks.set(lock.lockId, lock);
      for (const id of lock.cardIds) entry.cardLocks.set(objectKey(id), lock.lockId);
      applyCards(entry, cards.map(card => ({ ...card!, editingUser: { userId: lock.userId } })));
      onLockAcquired(entry, lock);
      return { status: 200, body: onBoardUpdated(entry, 'edit-requested', lock.cardIds, {
        type: 'edit.granted', clientId: command.clientId, requestId: command.requestId, lockId: lock.lockId, cardIds: lock.cardIds,
      }, command.userId) };
    }
    const lock = entry.locks.get(command.lockId);
    if (!lock || lock.userId !== command.userId || lock.clientId !== command.clientId) return reject(entry, command, 403, '有効な編集権がありません。');
    switch (command.type) {
      case 'edit.cancel': return finishEdit(entry, lock, command);
      case 'edit.commit': {
        const cards = changedCards(entry, lock, command.changes);
        return typeof cards === 'string' ? reject(entry, command, 400, cards) : finishEdit(entry, lock, command, cards);
      }
      case 'edit.check.reply': {
        if (lock.check?.checkId !== command.checkId) return reject(entry, command, 409, 'この期限確認は既に終了しています。');
        if (command.state === 'cancelling') return finishEdit(entry, lock, command, undefined, command.checkId);
        const cards = changedCards(entry, lock, command.changes);
        if (typeof cards === 'string') return reject(entry, command, 400, cards);
        if (command.state === 'committing') return finishEdit(entry, lock, command, cards, command.checkId);
        const changed = cards.some(card => canonical(card) !== canonical(getCard(entry.board, card.cardId)));
        if (changed) { applyCards(entry, cards); onLockAcquired(entry, lock); }
        else onLockReleased(entry, lock);
        return { status: 200, body: onBoardUpdated(entry, changed ? 'edit-saved' : 'edit-released', lock.cardIds, {
          type: 'edit.checked', clientId: command.clientId, requestId: command.requestId, cardIds: lock.cardIds,
          lockId: lock.lockId, checkId: command.checkId, outcome: changed ? 'saved' : 'released',
        }, command.userId) };
      }
    }
  }
  function deleteObjects(entry: Entry, command: BoardCommand, ids: readonly BoardObjectId[]): EditResult {
    if (ids.some(id => id.type === 'card' && entry.cardLocks.has(objectKey(id)))) return reject(entry, command, 409, '編集中のカードは削除できません。先に確定または取消してください。');
    const before = entry.board;
    const after = removeObjects(before, ids);
    const affected: BoardObjectId[] = [];
    for (const card of before.cards) if (canonical(card) !== canonical(getCard(after, card.cardId))) affected.push(card.cardId);
    for (const arrow of before.arrows) if (!after.arrows.some(a => sameObjectId(a.arrowId, arrow.arrowId))) affected.push(arrow.arrowId);
    if (!affected.length) return accepted(entry, command);
    entry.board = after;
    onBoardUpdated(entry, 'objects-deleted', affected);
    return accepted(entry, command, true);
  }
  function handleImmediate(entry: Entry, command: Exclude<BoardCommand, EditCommand | { type: 'board.get' }>): EditResult {
    switch (command.type) {
      case 'card.create': {
        const existing = getCard(entry.board, command.card.cardId);
        if (existing) return reject(entry, command, 409, '同じIDのカードが既に存在します。');
        entry.board = { ...entry.board, cards: [...entry.board.cards, command.card] };
        onBoardUpdated(entry, 'card-created', [command.card.cardId]);
        return accepted(entry, command, true);
      }
      case 'objects.delete': return deleteObjects(entry, command, command.objectIds);
      case 'arrow.delete': return deleteObjects(entry, command, [command.arrowId]);
      case 'board.clear': return deleteObjects(entry, command, [...entry.board.cards.map(c => c.cardId), ...entry.board.arrows.map(a => a.arrowId)]);
      case 'board.restore-sample': {
        if (entry.locks.size) return reject(entry, command, 409, '編集中のカードがあるため、サンプルへ戻せません。');
        const sample = createSample(entry.board.boardId);
        const ids = [...entry.board.cards.map(c => c.cardId), ...entry.board.arrows.map(a => a.arrowId), ...sample.cards.map(c => c.cardId), ...sample.arrows.map(a => a.arrowId)];
        entry.board = { ...sample, timer: entry.board.timer };
        onBoardUpdated(entry, 'sample-restored', ids);
        return accepted(entry, command, true);
      }
      case 'reaction.add': case 'reaction.remove': {
        const card = getCard(entry.board, command.cardId);
        if (!card) return reject(entry, command, 404, 'カードが見つかりません。');
        if (card.cardKind !== 'block') return reject(entry, command, 400, 'リアクションは関連カードだけに付けられます。');
        const has = card.reactions.some(r => r.userId === command.userId && r.reactionId === command.reactionId);
        if (has === (command.type === 'reaction.add')) return accepted(entry, command);
        const reactions = command.type === 'reaction.add' ? [...card.reactions, { reactionId: command.reactionId, userId: command.userId }]
          : card.reactions.filter(r => r.userId !== command.userId || r.reactionId !== command.reactionId);
        applyCards(entry, [{ ...card, reactions }]);
        onBoardUpdated(entry, 'reaction-changed', [card.cardId]);
        return accepted(entry, command, true);
      }
      case 'arrow.create': {
        const arrow = command.arrow;
        if (!getCard(entry.board, arrow.sourceCardId) || !getCard(entry.board, arrow.targetCardId)) return reject(entry, command, 404, '矢印の接続先が見つかりません。');
        const existing = entry.board.arrows.find(a => sameObjectId(a.arrowId, arrow.arrowId));
        if (existing) return canonical(existing) === canonical(arrow) ? accepted(entry, command) : reject(entry, command, 409, '同じ矢印IDで異なる接続は作成できません。');
        if (entry.board.arrows.some(a => arrowConnectionKey(a) === arrowConnectionKey(arrow))) return reject(entry, command, 409, '同じ接続の矢印が既に存在します。');
        entry.board = { ...entry.board, arrows: [...entry.board.arrows, arrow] };
        onBoardUpdated(entry, 'arrow-created', [arrow.arrowId]);
        return accepted(entry, command, true);
      }
      case 'generation.request': {
        if (entry.generating) return reject(entry, command, 409, '既に候補を生成しています。');
        if (entry.locks.size) return reject(entry, command, 409, 'カードの編集が完了してから生成してください。');
        if (isEmpty(entry.board)) return reject(entry, command, 409, 'カードに本文を入力してから生成してください。');
        startGeneration(entry, command.level, 'manual');
        return accepted(entry, command);
      }
      case 'timer.start': case 'timer.stop': case 'timer.reset': {
        const timer = entry.board.timer;
        if (command.type === 'timer.start' && (timer.state === 'running' || !timer.remainingMs)) return accepted(entry, command);
        if (command.type === 'timer.stop' && timer.state === 'stopped') return accepted(entry, command);
        if (command.type === 'timer.reset' && timer.state === 'stopped' && timer.remainingMs === TIMER_DURATION_MS) return accepted(entry, command);
        entry.board = { ...entry.board, timer: command.type === 'timer.start' && timer.state === 'stopped'
          ? { durationMs: TIMER_DURATION_MS, state: 'running', endsAt: now() + timer.remainingMs }
          : { durationMs: TIMER_DURATION_MS, state: 'stopped', remainingMs: command.type === 'timer.reset' ? TIMER_DURATION_MS
            : timer.state === 'running' ? Math.max(0, timer.endsAt - now()) : timer.remainingMs } };
        armTimer(entry);
        onBoardUpdated(entry, 'timer', []);
        return accepted(entry, command, true);
      }
    }
  }
  function executeCommand(input: unknown, expectedBoardId?: string): EditResult {
    if (disposed) return { status: 503, body: { error: 'ボードサービスは停止しています。' } };
    if (!validCommand(input) || (expectedBoardId !== undefined && input.boardId !== expectedBoardId)) return { status: 400, body: { error: '要求の形式またはボードIDが不正です。' } };
    const command = structuredClone(input);
    const entry = boards.get(command.boardId);
    if (!entry) return { status: 404, body: { error: 'ボードが見つかりません。' } };
    const key = JSON.stringify([command.clientId, command.requestId]);
    const fingerprint = commandFingerprint(command);
    const previous = entry.results.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        console.error('Request ID conflict:', { boardId: command.boardId, clientId: command.clientId, requestId: command.requestId, type: command.type });
        return reject(entry, command, 409, '同じ要求IDで異なる内容を送信できません。');
      }
      return structuredClone(previous.result ?? { ...accepted(entry, command), status: 202 });
    }
    const retained: { fingerprint: string; result?: EditResult } = { fingerprint };
    entry.results.set(key, retained);
    const result = command.type === 'board.get' ? { status: 200, body: snapshot(entry) }
      : command.type.startsWith('edit.') ? handleEdit(entry, command as EditCommand)
      : handleImmediate(entry, command as Exclude<BoardCommand, EditCommand | { type: 'board.get' }>);
    retained.result = structuredClone(result);
    return structuredClone(result);
  }
  initialBoards.forEach(addBoard);
  return {
    getBoardSnapshot(boardId: string) { const entry = boards.get(boardId); return entry && !disposed ? snapshot(entry) : undefined; },
    ensureBoard(boardId: string) {
      if (disposed || !validId(boardId)) return false;
      if (!boards.has(boardId)) addBoard(createBoard(boardId));
      return true;
    },
    subscribeBoard(identity: ClientIdentity, receive: (event: BoardEvent) => void): (() => void) | undefined {
      const entry = boards.get(identity.boardId);
      if (disposed || !entry || ![identity.boardId, identity.userId, identity.clientId].every(validId)) return undefined;
      const subscriber = { identity: { ...identity }, receive };
      // 登録と初期取得を同じ同期処理で行い、境界で更新を取り逃さない。
      entry.subscribers.add(subscriber); deliver(entry, subscriber, snapshot(entry));
      for (const lock of entry.locks.values()) if (lock.check && lock.userId === identity.userId && lock.clientId === identity.clientId) query(entry, lock);
      return () => { entry.subscribers.delete(subscriber); };
    },
    executeCommand,
    executeEdit: executeCommand,
    requestEdit: (command: Extract<EditCommand, { type: 'edit.request' }>) => executeCommand(command),
    commitEdit: (command: Extract<EditCommand, { type: 'edit.commit' }>) => executeCommand(command),
    cancelEdit: (command: Extract<EditCommand, { type: 'edit.cancel' }>) => executeCommand(command),
    replyToEditCheck: (command: Extract<EditCommand, { type: 'edit.check.reply' }>) => executeCommand(command),
    dispose() {
      disposed = true;
      for (const entry of boards.values()) {
        entry.cancelAddition?.(); entry.cancelTimer?.();
        entry.locks.forEach(stopLockTimers); entry.subscribers.clear();
      }
    },
  };
}
