import type { Board } from '../domain/board';
import type {
  BoardCommand, BoardEvent, CardContent, ClientIdentity, BoardPhase, GameState,
} from '../domain/board-protocol';

/** 実装側は受信値を検証してから通知する。接続を失ったらonDisconnectを呼ぶ。 */
export interface BoardTransport {
  send(command: BoardCommand): void | Promise<void>;
  subscribe(
    onEvent: (event: BoardEvent) => void,
    onDisconnect: (reason: string) => void,
  ): () => void;
}

type Editing = Readonly<{
  phase: 'editing' | 'saving' | 'cancelling';
  cardId: string;
  requestId: string;
  lockId: string;
  draft: CardContent;
}>;
export type EditState =
  | Readonly<{ phase: 'idle' }>
  | Readonly<{ phase: 'requesting'; cardId: string; requestId: string }>
  | Editing;

export type BoardClientState = Readonly<{
  identity: ClientIdentity;
  status: 'offline' | 'loading' | 'ready';
  board: Board | null;
  revision: number;
  phase: BoardPhase;
  gameState: GameState | null;
  edit: EditState;
  error: string | null;
}>;

/** Reactにも通信方式にも依存しない、1端末・1ボードの状態管理。 */
export function createBoardClient(
  identity: ClientIdentity,
  transport: BoardTransport,
  createRequestId: () => string = () => crypto.randomUUID(),
) {
  let state: BoardClientState = {
    identity: { ...identity }, status: 'offline', board: null,
    revision: -1, phase: 'word-generation', gameState: null, edit: { phase: 'idle' }, error: null,
  };
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | undefined;
  let generation = 0;
  let active = false;

  function publish(update: Partial<BoardClientState>) {
    state = { ...state, ...update };
    listeners.forEach((listener) => listener());
  }

  function offline(reason: string | null) {
    active = false;
    generation += 1;
    unsubscribe?.();
    unsubscribe = undefined;
    // 結果不明の送信を再試行しない。再接続時に確定状態を取得する。
    publish({ status: 'offline', edit: { phase: 'idle' }, error: reason });
  }

  function send(command: BoardCommand) {
    const sentGeneration = generation;
    const failed = () => {
      if (active && generation === sentGeneration) {
        offline('通信に失敗しました。再接続して最新のボードを取得してください。');
      }
    };
    try {
      Promise.resolve(transport.send(structuredClone(command))).catch(failed);
    } catch {
      failed();
    }
  }

  function receive(event: BoardEvent) {
    if (event.board.boardId !== state.identity.boardId ||
        !Number.isSafeInteger(event.revision) || event.revision < 0) return;

    if (event.revision < state.revision) {
      // 古い許可を採用しない一方、自分の応答を捨てて待ち続けることも避ける。
      if (event.type !== 'board.snapshot' && state.edit.phase !== 'idle' &&
          event.clientId === state.identity.clientId &&
          event.requestId === state.edit.requestId && event.cardId === state.edit.cardId) {
        offline('編集応答の順序が前後しました。再接続して最新の状態を確認してください。');
      }
      return;
    }

    // 接続直後は全体取得の応答を待ち、以前の編集応答から再開しない。
    if (state.status === 'loading' && event.type !== 'board.snapshot') return;

    const board = structuredClone(event.board);
    let edit = state.edit;
    let error = state.error;
    let phase = state.phase;
    let gameState = state.gameState;
    
    // フェーズ更新
    if (event.type === 'board.snapshot' && event.phase) {
      phase = event.phase;
    }
    
    // ゲーム状態更新
    if (event.type === 'board.snapshot' && event.gameState) {
      gameState = event.gameState;
    }
    
    const matches = event.type !== 'board.snapshot' &&
      event.clientId === state.identity.clientId && edit.phase !== 'idle' &&
      event.requestId === edit.requestId && event.cardId === edit.cardId;

    if (matches) {
      if (event.type === 'edit.granted' && edit.phase === 'requesting') {
        const card = board.cards.find((item) => item.cardId === event.cardId);
        if (!card || card.editingUser?.userId !== state.identity.userId) {
          offline('編集許可の内容が一致しません。再接続してください。');
          return;
        }
        edit = {
          phase: 'editing', cardId: card.cardId, requestId: event.requestId,
          lockId: event.lockId,
          draft: {
            shape: card.shape, position: { ...card.position }, color: card.color,
            text: card.text, font: card.font,
          },
        };
        error = null;
      } else if (event.type === 'edit.rejected') {
        edit = { phase: 'idle' };
        error = event.reason;
      } else if ((event.type === 'edit.committed' && edit.phase === 'saving') ||
                 (event.type === 'edit.cancelled' && edit.phase === 'cancelling')) {
        edit = { phase: 'idle' };
        error = null;
      }
    }

    if (edit.phase !== 'idle' && edit.phase !== 'requesting') {
      const editingCardId = edit.cardId;
      const card = board.cards.find((item) => item.cardId === editingCardId);
      if (!card || card.editingUser?.userId !== state.identity.userId) {
        edit = { phase: 'idle' };
        error = '編集権が失われました。最新の内容から編集を開始してください。';
      }
    }
    publish({ board, revision: event.revision, phase, gameState, status: 'ready', edit, error });
  }

  function connect() {
    if (active) return;
    active = true;
    const currentGeneration = ++generation;
    publish({ status: 'loading', edit: { phase: 'idle' }, error: null });
    try {
      const stop = transport.subscribe(
        (event) => {
          if (active && generation === currentGeneration) receive(event);
        },
        (reason) => {
          if (active && generation === currentGeneration) offline(reason);
        },
      );
      if (!active || generation !== currentGeneration) { stop(); return; }
      unsubscribe = stop;
      send({ ...state.identity, type: 'board.get', requestId: createRequestId() });
    } catch {
      offline('接続できませんでした。再接続してください。');
    }
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    connect,
    disconnect: () => offline(null),
    sendCommand(command: BoardCommand) {
      send(command);
    },
    requestEdit(cardId: string): boolean {
      if (state.status !== 'ready' || state.edit.phase !== 'idle') return false;
      const card = state.board?.cards.find((item) => item.cardId === cardId);
      // 同じユーザーの別端末が編集中の場合も、ここでは取得しない。
      if (!card || card.editingUser) return false;
      const requestId = createRequestId();
      publish({ edit: { phase: 'requesting', cardId, requestId }, error: null });
      send({ ...state.identity, type: 'edit.request', cardId, requestId });
      return true;
    },
    updateDraft(patch: Partial<CardContent>): boolean {
      if (state.status !== 'ready' || state.edit.phase !== 'editing') return false;
      // 許可した属性だけを取り込む。IDやeditingUserの変更を混入させない。
      const previous = state.edit.draft;
      const draft: CardContent = {
        shape: patch.shape ?? previous.shape,
        position: { ...(patch.position ?? previous.position) },
        color: patch.color ?? previous.color,
        text: patch.text ?? previous.text,
        font: patch.font ?? previous.font,
      };
      if (![draft.position.x, draft.position.y, draft.position.z].every(Number.isFinite)) {
        return false;
      }
      publish({ edit: { ...state.edit, draft } });
      return true;
    },
    commitEdit(): boolean {
      if (state.status !== 'ready' || state.edit.phase !== 'editing') return false;
      const edit = state.edit;
      const requestId = createRequestId();
      publish({ edit: { ...edit, phase: 'saving', requestId }, error: null });
      send({
        ...state.identity, type: 'edit.commit', requestId,
        cardId: edit.cardId, lockId: edit.lockId, content: edit.draft,
      });
      return true;
    },
    cancelEdit(): boolean {
      if (state.status !== 'ready' || state.edit.phase !== 'editing') return false;
      const edit = state.edit;
      const requestId = createRequestId();
      publish({ edit: { ...edit, phase: 'cancelling', requestId }, error: null });
      send({
        ...state.identity, type: 'edit.cancel', requestId,
        cardId: edit.cardId, lockId: edit.lockId,
      });
      return true;
    },
  };
}

export type BoardClient = ReturnType<typeof createBoardClient>;
