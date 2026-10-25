import assert from 'node:assert/strict';
import { createBoardClient } from '../client/board-client.ts';
import { createHttpBoardTransport } from '../client/http-board-transport.ts';
import { flush } from './fake-clock.mjs';

export async function until(predicate) {
  for (let index = 0; index < 200; index++) { if (predicate()) return; await flush(); }
  assert.fail('Expected state was not reached');
}
export function connectedClient(service, identity, intercept) {
  const streams = [];
  const transport = createHttpBoardTransport(async (_url, options) => {
    const command = JSON.parse(options.body);
    if (intercept) await intercept(command);
    const result = service.executeCommand(command, identity.boardId);
    return Response.json(result.body, { status: result.status });
  }, () => {
    let stop;
    const stream = { closed: false, close() { this.closed = true; stop?.(); } };
    streams.push(stream);
    queueMicrotask(() => {
      if (stream.closed) return;
      stream.onopen();
      stop = service.subscribeBoard(identity, event => queueMicrotask(() => { if (!stream.closed) stream.onmessage({ data: JSON.stringify(event) }); }));
    });
    return stream;
  });
  return { client: createBoardClient(identity, transport), streams };
}
