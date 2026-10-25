import { randomUUID } from '../domain/uuid.ts';

import type { Board, CardId } from '../domain/board';
import { getCard, objectKey, sameObjectId } from '../domain/board.ts';
import type { BoardCommand, BoardEvent, CardChange, CardContent, CardPatch, ClientIdentity, GenerationState, ImmediateOperation } from '../domain/board-protocol';
import { cardContent, contentPatch } from '../domain/board-protocol.ts';
import { validPatch } from '../domain/board-validation.ts';
import { BoardRequestRejectedError } from './board-transport-error.ts';

export interface BoardTransport {
  send(command: BoardCommand): void | Promise<void>;
  subscribe(onEvent: (event: BoardEvent) => void, onDisconnect: (reason: string) => void): () => void;
}
type Session = Readonly<{
  phase: 'requesting' | 'editing' | 'saving' | 'cancelling';
  mode: 'text' | 'transform'; cardIds: readonly CardId[]; requestId: string; acquisitionRequestId: string;
  lockId?: string; intent: 'editing' | 'committing' | 'cancelling';
  bases: Readonly<Record<string, CardContent>>; drafts: Readonly<Record<string, CardContent>>;
  touched: Readonly<Record<string, readonly string[]>>;
  finalChanges?: readonly CardChange[];
}>;
export type EditState = Readonly<{ phase: 'idle' }> | Session;
export type ImportState = Readonly<{ status: 'idle' }> | Readonly<{ status: 'pending' | 'succeeded' | 'rejected'; requestId: string; message?: string }>;
export type BoardClientState = Readonly<{
  importState: ImportState; identity: ClientIdentity; status: 'offline' | 'loading' | 'ready'; board: Board | null; revision: number;
  edit: EditState; error: string | null; generation: GenerationState; generationSequence: number;
  generatedCardIds: readonly CardId[]; pendingCommands: readonly BoardCommand[]; serverOffsetMs: number;
}>;

/** 1端末の確定状態・許可待ちの仮表示・許可済み下書きを分離する。 */
export function createBoardClient(identity: ClientIdentity, transport: BoardTransport, createRequestId = () => randomUUID()) {
  let state: BoardClientState = {
    importState: { status: 'idle' }, identity: { ...identity }, status: 'offline', board: null, revision: -1, edit: { phase: 'idle' }, error: null,
    generation: { status: 'idle' }, generationSequence: -1, generatedCardIds: [], pendingCommands: [], serverOffsetMs: 0,
  };
  const listeners = new Set<() => void>();
  const pending = new Map<string, BoardCommand>();
  const answeredChecks = new Map<string, BoardCommand>();
  const seenGenerationEvents = new Set<string>();
  let unsubscribe: (() => void) | undefined;
  let connectionGeneration = 0;
  let active = false;
  let lastServerTime = -Infinity;
  const buffered: BoardEvent[] = [];
  const sameIds = (a: readonly CardId[], b: readonly CardId[]) => a.length === b.length && a.every(id => b.some(other => sameObjectId(id, other)));

  function publish(update: Partial<BoardClientState>) {
    state = { ...state, ...update, pendingCommands: [...pending.values()].map(command => structuredClone(command)) };
    listeners.forEach(listener => listener());
  }
  function retainImport() {
    for (const [id, command] of pending) if (command.type !== 'board.import') pending.delete(id);
  }
  function offline(reason: string | null) {
    active = false; connectionGeneration++;
    unsubscribe?.(); unsubscribe = undefined;
    retainImport(); answeredChecks.clear(); buffered.length = 0;
    publish({ status: 'offline', edit: { phase: 'idle' }, error: reason, generatedCardIds: [] });
  }
  function send(command: BoardCommand) {
    const generation = connectionGeneration;
    if (command.type !== 'board.get') pending.set(command.requestId, structuredClone(command));
    const failed = (error: unknown) => {
      if (!active || connectionGeneration !== generation || (command.type !== 'board.get' && !pending.has(command.requestId))) return;
      if (command.type === 'board.import' && error instanceof BoardRequestRejectedError) {
        pending.delete(command.requestId);
        publish({ importState: { status: 'rejected', requestId: command.requestId, message: error.message }, error: error.message });
        return;
      }
      // HTTP失敗は拒否・切断ではない。SSEと確定/取消の最終内容を残す。
      publish({ error: error instanceof Error ? error.message : '応答を確認できません。元の要求を再送できます。' });
    };
    try { Promise.resolve(transport.send(structuredClone(command))).catch(failed); } catch (error) { failed(error); }
  }
  function changes(edit: Session): CardChange[] {
    return edit.cardIds.map(cardId => ({ cardId, patch: contentPatch(edit.bases[objectKey(cardId)], edit.drafts[objectKey(cardId)]) }));
  }
  function complete() {
    const edit = state.edit;
    if (edit.phase === 'idle' || !edit.lockId) return;
    const requestId = createRequestId();
    if (edit.intent === 'cancelling') {
      publish({ edit: { ...edit, phase: 'cancelling', requestId }, error: null });
      send({ ...identity, type: 'edit.cancel', requestId, lockId: edit.lockId });
    } else {
      const finalChanges = changes(edit);
      publish({ edit: { ...edit, phase: 'saving', requestId, intent: 'committing', finalChanges }, error: null });
      send({ ...identity, type: 'edit.commit', requestId, lockId: edit.lockId, changes: finalChanges });
    }
  }
  function grant(edit: Session, lockId: string, board: Board): Session | undefined {
    const bases: Record<string, CardContent> = {};
    const drafts: Record<string, CardContent> = {};
    for (const id of edit.cardIds) {
      const card = getCard(board, id);
      if (!card || card.editingUser?.userId !== identity.userId) return undefined;
      const key = objectKey(id);
      const base = cardContent(card);
      bases[key] = base;
      const proposed = edit.drafts[key];
      const before = edit.bases[key];
      // 仮移動量を許可時の最新の位置・サイズへ合成する。
      drafts[key] = edit.mode === 'transform' ? { ...base,
        position: { x: base.position.x + proposed.position.x - before.position.x,
          y: base.position.y + proposed.position.y - before.position.y, z: proposed.position.z },
        shape: { width: base.shape.width + proposed.shape.width - before.shape.width,
          height: base.shape.height + proposed.shape.height - before.shape.height },
      } : base;
    }
    return { ...edit, phase: 'editing', lockId, bases, drafts };
  }
  function answerCheck(check: Extract<BoardEvent, { type: 'edit.check' }>) {
    let edit = state.edit;
    if (state.status !== 'ready' || edit.phase === 'idle' || check.clientId !== identity.clientId ||
        check.userId !== identity.userId || !sameIds(edit.cardIds, check.cardIds)) return;
    // 許可応答だけが失われた場合も所有端末への問い合わせから回収できる。
    if (edit.phase === 'requesting' && state.board) {
      const granted = grant(edit, check.lockId, state.board);
      if (!granted) return;
      pending.delete(edit.acquisitionRequestId);
      edit = granted; publish({ edit });
    }
    if (edit.lockId !== check.lockId) return;
    const key = JSON.stringify([check.lockId, check.checkId]);
    if (answeredChecks.has(key)) return;
    const common = { ...identity, type: 'edit.check.reply' as const, requestId: createRequestId(), lockId: check.lockId, checkId: check.checkId };
    const command: BoardCommand = edit.intent === 'cancelling' ? { ...common, state: 'cancelling' }
      : { ...common, state: edit.intent === 'committing' ? 'committing' : 'editing', changes: edit.finalChanges ?? changes(edit) };
    answeredChecks.set(key, command); send(command); publish({});
  }
  function receive(input: BoardEvent) {
    if (input.board.boardId !== identity.boardId || !Number.isSafeInteger(input.revision) || input.revision < 0) return;
    const value = structuredClone(input);
    const initializing = state.status === 'loading';
    if (initializing && value.type !== 'board.snapshot') { buffered.push(value); return; }
    let board = state.board;
    let revision = state.revision;
    if (initializing || value.revision >= revision) { board = value.board; revision = value.revision; }
    if (!board) return;
    let generation = state.generation;
    let generationSequence = state.generationSequence;
    if (initializing || value.generationSequence >= generationSequence) {
      generation = value.generation; generationSequence = value.generationSequence;
    }
    let serverOffsetMs = state.serverOffsetMs;
    if (initializing || value.serverNow > lastServerTime) { lastServerTime = value.serverNow; serverOffsetMs = value.serverNow - Date.now(); }
    let edit = state.edit;
    let error = state.error;
    let importState = state.importState;
    const ownReply = 'requestId' in value && value.clientId === identity.clientId;
    const pendingCommand = ownReply ? pending.get(value.requestId) : undefined;
    if (ownReply) pending.delete(value.requestId);
    if (pendingCommand?.type === 'board.import') {
      if (value.type === 'command.accepted') importState = { status: 'succeeded', requestId: value.requestId, message: 'ボードを読み込みました。' };
      if (value.type === 'command.rejected') importState = { status: 'rejected', requestId: value.requestId, message: value.reason };
    }
    const matches = ownReply && edit.phase !== 'idle' && (value.requestId === edit.requestId || value.requestId === edit.acquisitionRequestId);
    let finishAfterGrant = false;
    if (value.type === 'edit.granted' && matches && edit.phase === 'requesting' && sameIds(value.cardIds, edit.cardIds)) {
      const granted = grant(edit, value.lockId, board);
      if (granted) { edit = granted; finishAfterGrant = edit.intent !== 'editing'; error = null; }
      else { edit = { phase: 'idle' }; error = 'この編集権は終了しています。最新のカードから編集を開始してください。'; }
    } else if (value.type === 'command.rejected' && ownReply && pendingCommand) {
      error = value.reason;
      if (matches && edit.phase !== 'idle') {
        edit = edit.lockId && edit.cardIds.every(id => getCard(board!, id)?.editingUser?.userId === identity.userId)
          ? { ...edit, phase: 'editing', intent: 'editing', finalChanges: undefined } : { phase: 'idle' };
      }
    } else if ((value.type === 'edit.committed' || value.type === 'edit.cancelled') && ownReply && edit.phase !== 'idle' &&
        value.lockId === edit.lockId && sameIds(value.cardIds, edit.cardIds)) {
      edit = { phase: 'idle' }; error = null;
    } else if (value.type === 'edit.checked' && ownReply && edit.phase !== 'idle' && value.lockId === edit.lockId && sameIds(value.cardIds, edit.cardIds)) {
      if (value.outcome !== 'saved') { edit = { phase: 'idle' }; error = null; }
    } else if (value.type === 'edit.released' && value.clientId === identity.clientId && value.userId === identity.userId &&
        edit.phase !== 'idle' && value.lockId === edit.lockId && sameIds(value.cardIds, edit.cardIds)) {
      edit = { phase: 'idle' }; error = '期限確認への応答が届かなかったため、編集権が解除されました。';
    } else if (value.type === 'command.accepted' && pendingCommand) error = null;

    // 読み込みで消えたIDに対する取得待ち・保存待ちも終了する。
    if (edit.phase !== 'idle' && edit.cardIds.some(id => !getCard(board!, id))) edit = { phase: 'idle' };
    // 最新の確定属性へ下書きを重ねる。サーバーで除去された関連先は復活させない。
    if (edit.phase === 'editing' && !finishAfterGrant) {
      const currentEdit = edit;
      const bases = { ...edit.bases }; const drafts = { ...edit.drafts };
      if (!edit.cardIds.every(id => getCard(board!, id)?.editingUser?.userId === identity.userId)) {
        edit = { phase: 'idle' }; error = '編集権が終了しました。最新の内容を確認してください。';
      } else {
        for (const id of currentEdit.cardIds) {
          const key = objectKey(id); const base = cardContent(getCard(board, id)!);
          // 途中保存の送信後に元の値へ戻した入力も保持する。
          const patch = Object.fromEntries((currentEdit.touched[key] ?? []).map(field => [field,
            (currentEdit.drafts[key] as unknown as Record<string, unknown>)[field]]));
          const draft = { ...base, ...patch } as CardContent;
          if (draft.cardKind === 'block') drafts[key] = { ...draft, relatedIds: draft.relatedIds.filter(id => getCard(board!, id)) };
          else drafts[key] = draft;
          bases[key] = base;
        }
        edit = { ...currentEdit, bases, drafts };
      }
    }
    let generatedCardIds = state.generatedCardIds.filter(id => getCard(board!, id));
    if (initializing) { seenGenerationEvents.clear(); generatedCardIds = []; }
    if (value.type === 'board.cards-generated' && !seenGenerationEvents.has(value.eventId)) {
      seenGenerationEvents.add(value.eventId);
      generatedCardIds = [...new Map([...generatedCardIds, ...value.generatedCardIds.filter(id => getCard(board!, id))].map(id => [objectKey(id), id])).values()];
    }
    if (edit.phase === 'idle') {
      answeredChecks.clear();
      if (state.edit.phase !== 'idle') {
        const ended = state.edit;
        for (const [requestId, command] of pending) {
          if (requestId === ended.acquisitionRequestId || ('lockId' in command && command.lockId === ended.lockId)) pending.delete(requestId);
        }
      }
    }
    publish({ importState, status: 'ready', board, revision, edit, error, generation, generationSequence, generatedCardIds, serverOffsetMs });
    if (finishAfterGrant) complete();
    if (value.type === 'edit.check') answerCheck(value);
    if (initializing) {
      const initialRevision = value.revision;
      const queued = buffered.splice(0);
      for (const command of [...pending.values()]) if (command.type === 'board.import') send(command);
      for (const queuedEvent of queued) {
        // 初期スナップショットに含まれる過去の生成は案内しない。
        if (queuedEvent.type === 'board.cards-generated' && queuedEvent.revision <= initialRevision) seenGenerationEvents.add(queuedEvent.eventId);
        receive(queuedEvent);
      }
    }
  }
  function connect() {
    if (active) return;
    active = true; const generation = ++connectionGeneration;
    retainImport(); answeredChecks.clear(); seenGenerationEvents.clear(); buffered.length = 0;
    publish({ status: 'loading', edit: { phase: 'idle' }, error: null, generatedCardIds: [] });
    try {
      const stop = transport.subscribe(value => { if (active && generation === connectionGeneration) receive(value); },
        reason => { if (active && generation === connectionGeneration) offline(reason); });
      if (!active || generation !== connectionGeneration) { stop(); return; }
      unsubscribe = stop;
      send({ ...identity, type: 'board.get', requestId: createRequestId() });
    } catch { offline('接続できませんでした。再接続してください。'); }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    connect, disconnect: () => offline(null),
    requestEdit(ids: CardId | readonly CardId[], mode: 'text' | 'transform' = 'text'): boolean {
      if (state.status !== 'ready' || state.importState.status === 'pending' || state.edit.phase !== 'idle' || !state.board) return false;
      const cardIds = Array.isArray(ids) ? ids : [ids as CardId];
      if (!cardIds.length || new Set(cardIds.map(objectKey)).size !== cardIds.length) return false;
      const bases: Record<string, CardContent> = {};
      for (const id of cardIds) {
        const card = getCard(state.board, id);
        if (!card || card.editingUser) return false;
        bases[objectKey(id)] = cardContent(card);
      }
      const requestId = createRequestId();
      publish({ edit: { phase: 'requesting', mode, cardIds: structuredClone(cardIds), requestId, acquisitionRequestId: requestId,
        intent: 'editing', bases, drafts: structuredClone(bases), touched: {} }, error: null });
      send({ ...identity, type: 'edit.request', requestId, cardIds }); publish({});
      return true;
    },
    updateDraft(patch: CardPatch, cardId?: CardId): boolean {
      const edit = state.edit;
      if (state.status !== 'ready' || edit.phase === 'idle' || edit.intent !== 'editing' ||
          (edit.phase !== 'editing' && !(edit.phase === 'requesting' && edit.mode === 'transform'))) return false;
      const id = cardId ?? edit.cardIds[0]; const key = objectKey(id); const previous = edit.drafts[key];
      if (!previous || !validPatch(patch) || (previous.cardKind === 'word' && patch.relatedIds !== undefined)) return false;
      if (edit.phase === 'requesting' && Object.keys(patch).some(key => key !== 'position' && key !== 'shape')) return false;
      publish({ edit: { ...edit, drafts: { ...edit.drafts, [key]: { ...previous, ...structuredClone(patch) } as CardContent },
        touched: { ...edit.touched, [key]: [...new Set([...(edit.touched[key] ?? []), ...Object.keys(patch)])] } } });
      return true;
    },
    commitEdit(): boolean {
      const edit = state.edit;
      if (state.status !== 'ready' || edit.phase === 'idle' || edit.intent !== 'editing' ||
          (edit.phase !== 'editing' && edit.phase !== 'requesting')) return false;
      publish({ edit: { ...edit, intent: 'committing' } });
      if (edit.phase === 'editing') complete();
      return true;
    },
    cancelEdit(): boolean {
      const edit = state.edit;
      if (state.status !== 'ready' || edit.phase === 'idle' || edit.phase === 'saving' || edit.phase === 'cancelling') return false;
      publish({ edit: { ...edit, intent: 'cancelling' } });
      if (edit.lockId) complete();
      return true;
    },
    execute(operation: ImmediateOperation): boolean {
      if (state.status !== 'ready' || state.importState.status === 'pending') return false;
      if (operation.type === 'board.import' && (state.edit.phase !== 'idle' || pending.size > 0)) return false;
      const requestId = createRequestId();
      if (operation.type === 'board.import') publish({ importState: { status: 'pending', requestId }, error: null });
      send({ ...structuredClone(operation), ...identity, requestId } as BoardCommand); publish({});
      return true;
    },
    retryPending() { for (const command of [...pending.values()]) send(command); },
    dismissGuidance(cardIds: readonly CardId[]) {
      const dismissed = new Set(cardIds.map(objectKey));
      publish({ generatedCardIds: state.generatedCardIds.filter(id => !dismissed.has(objectKey(id))) });
    },
  };
}
export type BoardClient = ReturnType<typeof createBoardClient>;
