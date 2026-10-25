import assert from 'node:assert/strict';
import test from 'node:test';
import { boardEventResponse } from './board-events.ts';
import { createBoardService } from './board-service.ts';
import { fakeClock } from '../test/fake-clock.mjs';
import { board, cid, commands, identity } from '../test/board-fixtures.mjs';
const readEvent = async reader => JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6).trim());

test('SSEは初期取得・貸し出し・期限確認・解除・生成状態・生成IDを配信する', async t => {
  const clock = fakeClock(); const service = createBoardService([board()], {
    now: clock.now, schedule: clock.schedule, lockTtlMs: 100, replyTimeoutMs: 10, additionDelayMs: 30, generateSuggestions: async () => ['suggestion'],
  });
  const abort = new AbortController(); t.after(() => { abort.abort(); service.dispose(); });
  const response = boardEventResponse(new Request('http://local/events', { signal: abort.signal }), identity, service);
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream; charset=utf-8');
  assert.equal(response.headers.get('Cache-Control'), 'no-store, no-transform');
  const reader = response.body.getReader(); assert.equal((await readEvent(reader)).type, 'board.snapshot');
  const grant = service.executeCommand(commands()('edit.request', { cardIds: [cid(1), cid(2)] }));
  assert.equal((await readEvent(reader)).lockId, grant.body.lockId);
  await clock.advance(100); assert.equal((await readEvent(reader)).cardIds.length, 2);
  await clock.advance(10); assert.equal((await readEvent(reader)).type, 'edit.released');
  await clock.advance(30); assert.equal((await readEvent(reader)).generation.status, 'running');
  const generated = await readEvent(reader); assert.equal(generated.type, 'board.cards-generated'); assert.equal(generated.generatedCardIds.length, 1);
  abort.abort(); assert.equal((await reader.read()).done, true);
});
test('SSEの切断・cancelは一度だけ購読解除し、不正情報・未知ボードを拒否する', async t => {
  const service = createBoardService([board()]); t.after(() => service.dispose());
  for (const mode of ['abort', 'cancel']) {
    const abort = new AbortController(); let count = 0;
    const response = boardEventResponse(new Request('http://local/events', { signal: abort.signal }), identity, {
      ...service, subscribeBoard(identity, receive) { const stop = service.subscribeBoard(identity, receive); return () => { count++; stop(); }; },
    });
    const reader = response.body.getReader(); await readEvent(reader);
    if (mode === 'abort') abort.abort(); else await reader.cancel(); abort.abort(); assert.equal(count, 1);
  }
  assert.equal(boardEventResponse(new Request('http://local/events'), { ...identity, clientId: '' }, service).status, 400);
  assert.equal(boardEventResponse(new Request('http://local/events'), { ...identity, boardId: 'missing' }, service).status, 404);
});
