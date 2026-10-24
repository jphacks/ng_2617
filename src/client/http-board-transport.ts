import type { BoardTransport } from './board-client';
import type { BoardEvent } from '../domain/board-protocol';

type Snapshot = Extract<BoardEvent, { type: 'board.snapshot' }>;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 受信JSONを、状態管理に渡す前に検証する。 */
function isSnapshot(value: unknown): value is Snapshot {
  if (!isRecord(value) || value.type !== 'board.snapshot' ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
      !isRecord(value.board) || typeof value.board.boardId !== 'string' ||
      !Array.isArray(value.board.cards)) return false;
  const ids = new Set<string>();
  return value.board.cards.every((card: unknown) => {
    if (!isRecord(card) || typeof card.cardId !== 'string' || !card.cardId ||
        ids.has(card.cardId) || typeof card.shape !== 'string' ||
        typeof card.color !== 'string' || typeof card.text !== 'string' ||
        typeof card.font !== 'string' || !isRecord(card.position) ||
        ![card.position.x, card.position.y, card.position.z].every(
          (coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate),
        ) || (card.editingUser !== undefined &&
          (!isRecord(card.editingUser) || typeof card.editingUser.userId !== 'string'))) {
      return false;
    }
    ids.add(card.cardId);
    return true;
  });
}

/** 取得専用のHTTP通信。常時接続や編集要求はまだ実装しない。 */
export function createHttpBoardTransport(fetcher: typeof fetch = fetch): BoardTransport {
  let subscription: {
    receive: (event: BoardEvent) => void;
    disconnect: (reason: string) => void;
    pending: Set<AbortController>;
  } | undefined;
  return {
    subscribe(receive, disconnect) {
      if (subscription) throw new Error('この通信窓口は既に使用されています。');
      const current = { receive, disconnect, pending: new Set<AbortController>() };
      subscription = current;
      return () => {
        current.pending.forEach((controller) => controller.abort());
        if (subscription === current) subscription = undefined;
      };
    },
    async send(command) {
      const current = subscription;
      if (!current) throw new Error('受信を購読してから送信してください。');
      if (command.type !== 'board.get') {
        current.disconnect('このサーバーは現在、ボードの取得だけに対応しています。');
        return;
      }
      const controller = new AbortController();
      current.pending.add(controller);
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetcher(`/api/boards/${encodeURIComponent(command.boardId)}`, {
          method: 'GET', cache: 'no-store', signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error(response.status === 404 ? 'ボードが見つかりません。'
            : `ボードを取得できませんでした（${response.status}）。`);
        }
        const event: unknown = await response.json();
        if (!isSnapshot(event) || event.board.boardId !== command.boardId) {
          throw new Error('サーバーから受け取ったボードの形式が不正です。');
        }
        if (subscription === current) current.receive(event);
      } catch (error) {
        if (subscription === current) {
          current.disconnect(controller.signal.aborted ? '通信がタイムアウトしました。再取得してください。'
            : error instanceof Error ? error.message : '通信に失敗しました。');
        }
      } finally {
        clearTimeout(timeout);
        current.pending.delete(controller);
      }
    },
  };
}
