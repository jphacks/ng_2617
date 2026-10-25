import type { Board, BoardObjectId, Card, CardId, RelationLevel } from '../domain/board';
import { createBoard, createSample, getCard, isEmpty, objectKey, removeObjects, sameObjectId, newCardId, newArrowId, TIMER_DURATION_MS } from '../domain/board.ts';
import type { BoardCommand, BoardEvent, CardChange, ClientIdentity, EditCommand, GenerationState, SnapshotData } from '../domain/board-protocol';
import { canonical, commandFingerprint } from '../domain/board-protocol.ts';
import { arrowConnectionKey, validBoard, validCard, validCommand, validId } from '../domain/board-validation.ts';
import { generateWordSuggestions } from './ai-service.ts';
import { GeminiApiError } from './AIapi.ts';
import { EDIT_LOCK_TTL_MS, EDIT_REPLY_TIMEOUT_MS, WORD_ADDITION_DELAY_MS, WORD_ADDITION_COUNT, scheduleTimeout, type Schedule } from './edit-lifecycle.ts';
import { suggestionCards, placeAddedCards } from './word-addition.ts';
import { onTimerFinished } from './board-timer.ts';
import { MATCHING_DURATION_MS, MATCHING_FINALIZE_MS } from '../domain/matching.ts';
import { newMatchingGame, newMatchingDraft, consumeSelected } from './matching-game.ts';

export type EditResult = { status: number; body: BoardEvent | { error: string } };
export type UpdateKind = 'edit-requested' | 'edit-committed' | 'edit-cancelled' | 'edit-saved' | 'edit-released' |
  'card-created' | 'objects-deleted' | 'sample-restored' | 'reaction-changed' | 'arrow-created' | 'auto-generated' | 'board-imported' | 'timer' | 'matching' | 'settings';
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
  cancelMatchingClose?: () => void;
  // 設定変更は本文版数と分け、手動生成を巻き込まず古い自動生成だけを無効化する。
  automaticVersion: number; additionNotBefore?: number; departed: Set<string>;
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
  random?: () => number;
} = {}) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? scheduleTimeout;
  const random = options.random ?? Math.random;
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
      board: { ...structuredClone(board), settings: { autoGenerationEnabled: board.settings?.autoGenerationEnabled ?? true },
        cards: board.cards.map(card => withoutEditor(structuredClone(card))) },
      revision: 0, locks: new Map(), cardLocks: new Map(), subscribers: new Set(), cardVersion: 0,
      generation: { status: 'idle' }, generationSequence: 0, timerVersion: 0, results: new Map(), automaticVersion: 0, departed: new Set(),
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
    try { subscriber.receive(structuredClone(value)); } catch {
      entry.subscribers.delete(subscriber);
      queueMicrotask(() => { if (!disposed) matchingPresenceChanged(entry); });
    }
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
    if (disposed || !entry.board.settings.autoGenerationEnabled || entry.board.matching || entry.locks.size ||
      (entry.additionNotBefore === undefined && (!entry.lastUpdate || ['board-imported', 'matching'].includes(entry.lastUpdate.kind)))) return;
    const version = entry.cardVersion;
    const automaticVersion = entry.automaticVersion;
    entry.cancelAddition = schedule(() => {
      if (disposed || entry.cardVersion !== version || entry.automaticVersion !== automaticVersion) return;
      entry.cancelAddition = undefined;
      if (!entry.board.settings.autoGenerationEnabled || entry.board.matching || entry.locks.size || isEmpty(entry.board) ||
        (entry.additionNotBefore === undefined && ['auto-generated', 'board-imported', 'matching'].includes(entry.lastUpdate?.kind ?? '')) || entry.generating) return;
      entry.additionNotBefore = undefined;
      startGeneration(entry, 'mid', 'automatic');
    }, Math.max(0, (entry.additionNotBefore ?? entry.lastUpdate!.at + additionDelayMs) - now()));
  }
  function onBoardUpdated(entry: Entry, kind: UpdateKind, ids: readonly BoardObjectId[], detail?: Detail, userId?: string): BoardEvent {
    entry.revision++;
    if (kind !== 'timer' && kind !== 'settings') {
      entry.cardVersion++;
      entry.additionNotBefore = undefined;
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
    const automaticVersion = entry.automaticVersion;
    const input = structuredClone(entry.board);
    entry.cancelAddition?.(); entry.cancelAddition = undefined;
    entry.generating = generationId;
    setGeneration(entry, { status: 'running', generationId, level, source });
    const current = () => !disposed && !entry.board.matching && entry.cardVersion === version && !entry.locks.size &&
      (source === 'manual' || (entry.board.settings.autoGenerationEnabled && entry.automaticVersion === automaticVersion));
    // HTTPの受付を確定してから非同期の生成を進める。
    void Promise.resolve().then(async () => {
      try {
        const words = await generate(input, level);
        if (disposed) return;
        if (!current()) {
          setGeneration(entry, { status: 'discarded', generationId, level, source, message: source === 'automatic' && entry.automaticVersion !== automaticVersion
            ? '自動生成の設定が変更されたため、今回の候補は追加されませんでした。' : 'ボードが更新されたため、今回の候補は追加されませんでした。' });
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
            message: current() ? (error instanceof GeminiApiError ? error.message : '候補の生成に失敗しました。もう一度お試しください。')
              : 'ボードが更新されたため、今回の候補は追加されませんでした。' });
          if (options.onGenerationError) options.onGenerationError(error);
          else console.error('Word generation failed:', error);
        }
      } finally {
        entry.generating = undefined;
        // 古い生成中に次の待機まで満了していた場合も、更新後の機会を取りこぼさない。
        if (!disposed && !entry.cancelAddition && (entry.additionNotBefore !== undefined ||
          (entry.cardVersion !== version && entry.lastUpdate?.kind !== 'auto-generated'))) waitForAddition(entry);
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
      if (entry.board.matching) { matchingDeadline(entry); return; }
      entry.board = { ...entry.board, timer: { durationMs: TIMER_DURATION_MS, state: 'stopped', remainingMs: 0 } };
      onBoardUpdated(entry, 'timer', []);
      (options.onTimerFinished ?? onTimerFinished)(structuredClone(entry.board));
    }, Math.max(0, timer.endsAt - now()));
  }
  /** 同じユーザーの複数タブは1人。最後に接続した端末を入力元にする。 */
  function participants(entry: Entry): Map<string, string> {
    return new Map([...entry.subscribers].map(subscriber => [subscriber.identity.userId, subscriber.identity.clientId]));
  }
  function setMatchingTimer(entry: Entry) {
    entry.board = { ...entry.board, timer: { durationMs: MATCHING_DURATION_MS, state: 'running', endsAt: now() + MATCHING_DURATION_MS } };
    armTimer(entry);
  }
  function endMatching(entry: Entry) {
    entry.cancelMatchingClose?.(); entry.cancelMatchingClose = undefined;
    const board = { ...entry.board, timer: { durationMs: TIMER_DURATION_MS, state: 'stopped' as const, remainingMs: TIMER_DURATION_MS } };
    delete board.matching;
    entry.board = board; armTimer(entry);
  }
  function nextMatchingTurn(entry: Entry, notice: string) {
    const game = entry.board.matching!;
    const users = [...participants(entry).keys()];
    const remaining = game.slots.filter(Boolean).length + game.reserve.length;
    if (!users.length || remaining < 2) { endMatching(entry); return; }
    const candidates = users.length > 1 ? users.filter(user => user !== game.selectorUserId) : users;
    entry.board = { ...entry.board, matching: { ...game, step: 'selecting', turnId: crypto.randomUUID(),
      selectorUserId: candidates[Math.floor(random() * candidates.length)], selected: [], drafts: [], finishAfterClosing: undefined, notice } };
    setMatchingTimer(entry);
  }
  function finishMatchingInput(entry: Entry) {
    const game = entry.board.matching;
    if (!game || game.step !== 'closing') return;
    entry.cancelMatchingClose?.(); entry.cancelMatchingClose = undefined;
    // 本文重複の除外や作者属性の転記は行わない。
    const cards = placeAddedCards(entry.board, game.drafts.filter(draft => draft.card.text.trim()).map(draft => draft.card));
    let next = cards.length ? consumeSelected(game) : game;
    next = { ...next, addedCardIds: [...game.addedCardIds, ...cards.map(card => card.cardId)] };
    entry.board = { ...entry.board, cards: [...entry.board.cards, ...cards], matching: next };
    if (game.finishAfterClosing || !participants(entry).size) endMatching(entry);
    else nextMatchingTurn(entry, cards.length ? `${cards.length}件のアイデアを追加しました。` : '今回は追加なし。2枚を同じ枠で裏に戻しました。');
    onBoardUpdated(entry, 'matching', cards.map(card => card.cardId));
  }
  function closeMatchingInput(entry: Entry, finish = false) {
    const game = entry.board.matching;
    if (!game) return;
    if (game.step === 'selecting') {
      if (finish) endMatching(entry);
      else nextMatchingTurn(entry, '選択時間が終了しました。選びかけのカードを裏に戻しました。');
      onBoardUpdated(entry, 'matching', []); return;
    }
    if (game.step === 'closing') {
      if (finish) entry.board = { ...entry.board, matching: { ...game, finishAfterClosing: true } };
      if (!participants(entry).size) finishMatchingInput(entry);
      else if (finish) onBoardUpdated(entry, 'matching', []);
      return;
    }
    entry.board = { ...entry.board, matching: { ...game, step: 'closing', finishAfterClosing: finish },
      timer: { durationMs: MATCHING_DURATION_MS, state: 'stopped', remainingMs: 0 } };
    armTimer(entry);
    const { gameId, turnId } = game;
    entry.cancelMatchingClose = schedule(() => {
      if (!disposed && entry.board.matching?.gameId === gameId && entry.board.matching.turnId === turnId) finishMatchingInput(entry);
    }, MATCHING_FINALIZE_MS);
    if (!participants(entry).size) finishMatchingInput(entry);
    else onBoardUpdated(entry, 'matching', []);
  }
  function matchingDeadline(entry: Entry) { closeMatchingInput(entry); }
  function matchingPresenceChanged(entry: Entry) {
    const game = entry.board.matching;
    if (!game) return;
    const users = participants(entry);
    if (!users.size) { closeMatchingInput(entry, true); return; }
    if (game.step === 'selecting' && !users.has(game.selectorUserId)) {
      nextMatchingTurn(entry, '選択担当者が切断したため、担当を交代しました。');
      onBoardUpdated(entry, 'matching', []); return;
    }
    let changed = false;
    const drafts = game.drafts.map(draft => {
      const writer = users.get(draft.userId);
      if (!writer || writer === draft.writerClientId) return draft;
      changed = true;
      return { ...draft, writerClientId: writer, writerToken: crypto.randomUUID() };
    });
    if (changed) {
      entry.board = { ...entry.board, matching: { ...game, drafts } };
      onBoardUpdated(entry, 'matching', []);
    }
  }
  function handleMatching(entry: Entry, command: Extract<BoardCommand, { type: `matching.${string}` }>): EditResult {
    if (!entry.subscribers.size || ![...entry.subscribers].some(s => s.identity.userId === command.userId && s.identity.clientId === command.clientId))
      return reject(entry, command, 403, '接続中の端末から操作してください。');
    if (command.type === 'matching.start') {
      if (entry.board.matching) return reject(entry, command, 409, 'ゲームは既に開始しています。');
      if (entry.locks.size) return reject(entry, command, 409, '編集中のカードがあります。全員の編集完了後に開始してください。');
      if (entry.board.cards.filter(card => card.cardKind === 'word' && card.text.trim()).length < 2)
        return reject(entry, command, 409, '本文のある通常付箋が2枚以上必要です。');
      entry.board = { ...entry.board, matching: newMatchingGame(entry.board, command.userId, random) };
      setMatchingTimer(entry); onBoardUpdated(entry, 'matching', []);
      return accepted(entry, command, true);
    }
    let game = entry.board.matching;
    if (!game || game.gameId !== command.gameId) return reject(entry, command, 409, 'このゲームは終了しています。');
    // 時計のコールバックよりHTTPが先に処理されても期限を守る。
    if (entry.board.timer.state === 'running' && entry.board.timer.endsAt <= now()) {
      matchingDeadline(entry); game = entry.board.matching;
      if (!game || game.gameId !== command.gameId) return reject(entry, command, 409, 'このゲームは終了しています。');
    }
    switch (command.type) {
      case 'matching.select': {
        if (game.turnId !== command.turnId || game.step !== 'selecting') return reject(entry, command, 409, 'この選択時間は終了しています。');
        if (game.selectorUserId !== command.userId) return reject(entry, command, 403, '現在の担当者だけが単語を選べます。');
        if (!game.slots.includes(command.copyId) || game.selected.includes(command.copyId)) return reject(entry, command, 409, 'このカードは選べません。');
        game = { ...game, selected: [...game.selected, command.copyId] };
        if (game.selected.length === 2) {
          game = { ...game, step: 'writing', drafts: [...participants(entry)].map(([user, client]) => newMatchingDraft(game!, user, client)) };
          entry.board = { ...entry.board, matching: game }; setMatchingTimer(entry);
        } else entry.board = { ...entry.board, matching: game };
        onBoardUpdated(entry, 'matching', []); return accepted(entry, command, true);
      }
      case 'matching.draft': {
        if (game.turnId !== command.turnId || game.step === 'selecting' || (game.step === 'closing' && !command.final))
          return reject(entry, command, 409, 'この入力時間は終了しています。');
        const draft = game.drafts.find(draft => draft.userId === command.userId);
        if (!draft || draft.writerClientId !== command.clientId || draft.writerToken !== command.writerToken)
          return reject(entry, command, 403, 'この端末に入力権がありません。最新の接続で入力してください。');
        if (command.sequence <= draft.sequence) return accepted(entry, command);
        if (draft.finalized) return reject(entry, command, 409, '最終入力は既に受け取りました。');
        const drafts = game.drafts.map(item => item === draft ? { ...draft, sequence: command.sequence,
          finalized: command.final, card: { ...draft.card, text: command.text } } : item);
        entry.board = { ...entry.board, matching: { ...game, drafts } };
        onBoardUpdated(entry, 'matching', []); return accepted(entry, command, true);
      }
      case 'matching.abort.request':
        if (game.abortConfirmationId) return accepted(entry, command);
        entry.board = { ...entry.board, matching: { ...game, abortConfirmationId: crypto.randomUUID() } };
        onBoardUpdated(entry, 'matching', []); return accepted(entry, command, true);
      case 'matching.abort.cancel': case 'matching.abort.confirm':
        if (game.abortConfirmationId !== command.confirmationId) return reject(entry, command, 409, 'この中断確認は終了しています。');
        entry.board = { ...entry.board, matching: { ...game, abortConfirmationId: undefined } };
        if (command.type === 'matching.abort.confirm') closeMatchingInput(entry, true);
        else onBoardUpdated(entry, 'matching', []);
        return accepted(entry, command, true);
    }
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
      if (entry.departed.has(JSON.stringify([command.userId, command.clientId]))) return reject(entry, command, 403, 'この接続は退室済みです。ルームに入り直してください。');
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
  function handleImmediate(entry: Entry, command: Exclude<BoardCommand, EditCommand | { type: 'board.get' } | { type: `matching.${string}` }>): EditResult {
    switch (command.type) {
      case 'board.leave': {
        entry.departed.add(JSON.stringify([command.userId, command.clientId]));
        const locks = [...entry.locks.values()].filter(lock => lock.userId === command.userId && lock.clientId === command.clientId);
        for (const lock of locks) onLockReleased(entry, lock);
        if (locks.length) onBoardUpdated(entry, 'edit-cancelled', locks.flatMap(lock => lock.cardIds));
        return accepted(entry, command, locks.length > 0);
      }
      case 'board.settings.update': {
        if (entry.board.settings.autoGenerationEnabled === command.autoGenerationEnabled) return accepted(entry, command);
        entry.automaticVersion++;
        entry.board = { ...entry.board, settings: { autoGenerationEnabled: command.autoGenerationEnabled } };
        entry.cancelAddition?.(); entry.cancelAddition = undefined;
        entry.additionNotBefore = command.autoGenerationEnabled ? now() + additionDelayMs : undefined;
        if (command.autoGenerationEnabled) waitForAddition(entry);
        onBoardUpdated(entry, 'settings', []);
        return accepted(entry, command, true);
      }
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
      case 'board.import': {
        if (entry.locks.size) return reject(entry, command, 409, '編集中のカードがあるため読み込めません。全員の編集完了後にもう一度お試しください。');
        // 全体を検証済み。IDの再割り当てと参照の再接続を終えてから1回で公開する。
        const ids = new Map(command.file.cards.map(card => [objectKey(card.cardId), newCardId()]));
        const cards: Card[] = command.file.cards.map(card => ({ ...structuredClone(card),
          cardId: ids.get(objectKey(card.cardId))!,
          ...(card.cardKind === 'block' && { relatedIds: card.relatedIds.map(id => ids.get(objectKey(id))!) }),
        }));
        const arrows = command.file.arrows.map(arrow => ({ ...arrow, arrowId: newArrowId(),
          sourceCardId: ids.get(objectKey(arrow.sourceCardId))!, targetCardId: ids.get(objectKey(arrow.targetCardId))!,
        }));
        const affected = [...entry.board.cards.map(c => c.cardId), ...entry.board.arrows.map(a => a.arrowId),
          ...cards.map(c => c.cardId), ...arrows.map(a => a.arrowId)];
        entry.board = { ...entry.board, cards, arrows };
        // 生成中の古い結果はcardVersionで破棄し、読み込みを起点とする待機は作らない。
        onBoardUpdated(entry, 'board-imported', affected, { type: 'command.accepted', clientId: command.clientId,
          requestId: command.requestId, commandType: command.type, changed: true }, command.userId);
        return accepted(entry, command, true);
      }
      case 'board.restore-sample': {
        if (entry.locks.size) return reject(entry, command, 409, '編集中のカードがあるため、サンプルへ戻せません。');
        const sample = createSample(entry.board.boardId);
        const ids = [...entry.board.cards.map(c => c.cardId), ...entry.board.arrows.map(a => a.arrowId), ...sample.cards.map(c => c.cardId), ...sample.arrows.map(a => a.arrowId)];
        entry.board = { ...sample, timer: entry.board.timer, settings: entry.board.settings };
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
      : command.type === 'board.leave' || command.type === 'board.settings.update' ? handleImmediate(entry, command)
      : command.type.startsWith('matching.') ? handleMatching(entry, command as Extract<BoardCommand, { type: `matching.${string}` }>)
      : entry.board.matching ? reject(entry, command, 409, '神経衰弱中は通常のボード操作とタイマー操作を利用できません。')
      : command.type.startsWith('edit.') ? handleEdit(entry, command as EditCommand)
      : handleImmediate(entry, command as Parameters<typeof handleImmediate>[1]);
    retained.result = structuredClone(result);
    return structuredClone(result);
  }
  initialBoards.forEach(addBoard);
  return {
    supportsBoardImport: true,
    supportsMatching: true,
    supportsBoardSettings: true,
    supportsBoardLeave: true,
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
      entry.subscribers.add(subscriber); matchingPresenceChanged(entry); deliver(entry, subscriber, snapshot(entry));
      for (const lock of entry.locks.values()) if (lock.check && lock.userId === identity.userId && lock.clientId === identity.clientId) query(entry, lock);
      return () => { if (entry.subscribers.delete(subscriber)) matchingPresenceChanged(entry); };
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
        entry.cancelAddition?.(); entry.cancelTimer?.(); entry.cancelMatchingClose?.();
        entry.locks.forEach(stopLockTimers); entry.subscribers.clear();
      }
    },
  };
}
