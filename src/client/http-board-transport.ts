import type { BoardTransport } from './board-client';
import type { BoardCommand, BoardEvent } from '../domain/board-protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 受信JSONを、状態管理に渡す前に検証する。 */
function isEvent(value: unknown): value is BoardEvent {
  if (!isRecord(value) ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
      !isRecord(value.board) || typeof value.board.boardId !== 'string' ||
      !Array.isArray(value.board.cards)) return false;
  const ids = new Set<string>();
  const validCards = value.board.cards.every((card: unknown) => {
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
  if (!validCards) return false;
  if (value.type === 'board.snapshot') return true;
  if (![value.clientId, value.requestId, value.cardId].every(v => typeof v === 'string' && v.length > 0)) return false;
  return (value.type === 'edit.granted' && typeof value.lockId === 'string' && value.lockId.length > 0) ||
    (value.type === 'edit.rejected' && typeof value.reason === 'string') ||
    value.type === 'edit.committed' || value.type === 'edit.cancelled';
}

function matchesCommand(event: BoardEvent, command: BoardCommand): boolean {
  if (event.board.boardId !== command.boardId) return false;
  if (command.type === 'board.get') return event.type === 'board.snapshot';
  if (event.type === 'board.snapshot' || event.clientId !== command.clientId ||
      event.requestId !== command.requestId || event.cardId !== command.cardId) return false;
  return event.type === 'edit.rejected' ||
    (command.type === 'edit.request' && event.type === 'edit.granted') ||
    (command.type === 'edit.commit' && event.type === 'edit.committed') ||
    (command.type === 'edit.cancel' && event.type === 'edit.cancelled');
}

/** HTTPの要求・応答を既存のイベント契約へ変換する。全端末への配信はまだ行わない。 */
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
      const controller = new AbortController();
      current.pending.add(controller);
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetcher(`/api/boards/${encodeURIComponent(command.boardId)}`, {
          method: command.type === 'board.get' ? 'GET' : 'POST',
          cache: 'no-store', signal: controller.signal,
          headers: { Accept: 'application/json', ...(command.type !== 'board.get' && { 'Content-Type': 'application/json' }) },
          ...(command.type !== 'board.get' && { body: JSON.stringify(command) }),
        });
        const event: unknown = await response.json();
        const valid = isEvent(event) && matchesCommand(event, command);
        // ロック競合・権限拒否も正常な編集応答として状態管理へ渡す。
        if (valid && event.type === 'edit.rejected' && [403, 404, 409].includes(response.status)) {
          if (subscription === current) current.receive(event);
          return;
        }
        if (!response.ok) {
          throw new Error(response.status === 404 ? 'ボードが見つかりません。'
            : `ボードを取得できませんでした（${response.status}）。`);
        }
        if (!valid) {
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
