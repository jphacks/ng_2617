import type { ClientIdentity } from '../domain/board-protocol';
import type { createBoardService } from './board-service';

type EventService = Pick<ReturnType<typeof createBoardService>, 'getBoardSnapshot' | 'subscribeBoard'>;

/** 初回スナップショット、編集権の期限確認、更新後のボードを同じ接続で配信する。 */
export function boardEventResponse(request: Request, identity: ClientIdentity, service: EventService): Response {
  const headers = { 'Cache-Control': 'no-store, no-transform' };
  if (![identity.boardId, identity.userId, identity.clientId].every(
    value => typeof value === 'string' && value.trim().length > 0 && value.length <= 128,
  )) return Response.json({ error: '接続先の識別情報が不正です。' }, { status: 400, headers });
  if (!service.getBoardSnapshot(identity.boardId)) {
    return Response.json({ error: 'ボードが見つかりません。' }, { status: 404, headers });
  }
  let stop: (() => void) | undefined;
  let closed = false;
  let close: (() => void) | undefined;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    stop?.();
    request.signal.removeEventListener('abort', abort);
  };
  const abort = () => { cleanup(); close?.(); };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => controller.close();
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) { abort(); return; }
      const encoder = new TextEncoder();
      stop = service.subscribeBoard(identity, event => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      });
      if (!stop) abort();
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: {
    ...headers, 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no',
  } });
}
