import type { BoardTransport } from './board-client';
import type { BoardCommand, BoardEvent } from '../domain/board-protocol';
import { canonical } from '../domain/board-protocol.ts';
import { record, validEvent } from '../domain/board-validation.ts';
import { BoardRequestRejectedError } from './board-transport-error.ts';

type EventSourceConnection = Pick<EventSource, 'onmessage' | 'onerror' | 'onopen' | 'close'>;
type Subscription = {
  receive: (event: BoardEvent) => void; disconnect: (reason: string) => void;
  pending: Set<AbortController>; stream?: EventSourceConnection; clearStreamTimeout?: () => void;
};
function matchesCommand(event: BoardEvent, command: BoardCommand): boolean {
  if (event.board.boardId !== command.boardId || !('requestId' in event) || event.clientId !== command.clientId || event.requestId !== command.requestId) return false;
  if (event.type === 'command.rejected' || event.type === 'command.accepted') return event.commandType === command.type;
  if (command.type === 'edit.request') return event.type === 'edit.granted' &&
    canonical(event.cardIds.map(id => id.uuid).sort()) === canonical(command.cardIds.map(id => id.uuid).sort());
  if (command.type === 'edit.commit') return event.type === 'edit.committed' && event.lockId === command.lockId &&
    canonical(event.cardIds.map(id => id.uuid).sort()) === canonical(command.changes.map(change => change.cardId.uuid).sort());
  if (command.type === 'edit.cancel') return event.type === 'edit.cancelled' && event.lockId === command.lockId;
  if (command.type === 'edit.check.reply') return event.type === 'edit.checked' && event.lockId === command.lockId && event.checkId === command.checkId;
  return false;
}

/** SSEの最初のスナップショットが初期取得。HTTPとの間に購読の隙間を作らない。 */
export function createHttpBoardTransport(fetcher: typeof fetch = fetch,
  createEventSource: (url: string) => EventSourceConnection = url => new EventSource(url)): BoardTransport {
  let subscription: Subscription | undefined;
  function openStream(current: Subscription, command: BoardCommand) {
    if (current.stream) return;
    const query = new URLSearchParams({ userId: command.userId, clientId: command.clientId });
    const stream = createEventSource(`/api/boards/${encodeURIComponent(command.boardId)}/events?${query}`);
    current.stream = stream;
    const fail = (reason: string) => {
      stream.close(); current.clearStreamTimeout?.();
      if (subscription === current) current.disconnect(reason);
    };
    const timeout = setTimeout(() => fail('更新通知を取得できませんでした。再接続してください。'), 10_000);
    current.clearStreamTimeout = () => clearTimeout(timeout);
    // openだけでなく、初期スナップショットの到着まで期限を設定する。
    stream.onopen = () => {};
    stream.onerror = () => fail('更新通知の接続が切れました。再接続してください。');
    stream.onmessage = message => {
      if (subscription !== current) return;
      try {
        const value: unknown = JSON.parse(message.data);
        if (!validEvent(value) || value.board.boardId !== command.boardId ||
            ('clientId' in value && value.clientId !== command.clientId) ||
            ('userId' in value && value.userId !== command.userId)) throw new Error('Invalid event');
        if (value.type === 'board.snapshot') current.clearStreamTimeout?.();
        current.receive(value);
      } catch { fail('更新通知の形式が不正です。再接続してください。'); }
    };
  }
  return {
    subscribe(receive, disconnect) {
      if (subscription) throw new Error('この通信窓口は既に使用されています。');
      const current: Subscription = { receive, disconnect, pending: new Set() }; subscription = current;
      return () => {
        current.pending.forEach(controller => controller.abort()); current.stream?.close(); current.clearStreamTimeout?.();
        if (subscription === current) subscription = undefined;
      };
    },
    async send(command) {
      if (command.type === 'board.leave') {
        // ページ離脱でも送信を継続し、購読解除のAbortControllerから独立させる。
        await fetcher(`/api/boards/${encodeURIComponent(command.boardId)}`, {
          method: 'POST', cache: 'no-store', keepalive: true,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(command),
        });
        return;
      }
      const current = subscription;
      if (!current) throw new Error('受信を購読してから送信してください。');
      if (command.type === 'board.get') { openStream(current, command); return; }
      const controller = new AbortController(); current.pending.add(controller);
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetcher(`/api/boards/${encodeURIComponent(command.boardId)}`, {
          method: 'POST', cache: 'no-store', signal: controller.signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(command),
        });
        const value: unknown = await response.json();
        if ((command.type === 'board.import' || command.type === 'board.settings.update' || command.type.startsWith('matching.')) && response.status === 503 && record(value) &&
            value.code === 'SERVER_RESTART_REQUIRED' && typeof value.error === 'string' && value.error.length <= 1000) {
          throw new BoardRequestRejectedError(value.error);
        }
        if (validEvent(value) && matchesCommand(value, command) &&
            (response.ok || (value.type === 'command.rejected' && [400, 403, 404, 409].includes(response.status)))) {
          if (subscription === current) current.receive(value);
          return;
        }
        const reason = record(value) && typeof value.error === 'string' && value.error.length <= 1000 ? ` ${value.error}` : '';
        throw new Error(!response.ok ? `要求を確認できませんでした（${response.status}）。${reason} 元の要求を再送できます。`
          : 'サーバーの応答が要求と一致しません。');
      } catch (error) {
        if (subscription === current && error instanceof BoardRequestRejectedError) throw error;
        if (subscription === current) throw new Error(controller.signal.aborted
          ? '応答がタイムアウトしました。元の要求を再送できます。' : error instanceof Error ? error.message : '通信に失敗しました。');
      } finally { clearTimeout(timeout); current.pending.delete(controller); }
    },
  };
}
