import assert from 'node:assert/strict';
import test from 'node:test';
import { boardEventResponse } from './board-events.ts';
import { createBoardService } from './board-service.ts';
import { fakeClock } from '../test/fake-clock.mjs';

const board = { boardId: 'board', cards: [{ cardId: 'card', shape: 'rectangle', position: { x: 0, y: 0, z: 0 }, text: 'original', color: '#fff', font: 'sans-serif' }] };
const identity = { boardId: 'board', userId: 'user', clientId: 'client' };
const command = { ...identity, type: 'edit.request', cardId: 'card', requestId: 'request' };
const readEvent = async reader => JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6).trim());

test('SSEは初期取得・許可・期限確認・自動解除・候補追加を配信する', async () => {
  const clock = fakeClock();
  const service = createBoardService([board], {
    now: clock.now, schedule: clock.schedule, lockTtlMs: 100, replyTimeoutMs: 10, additionDelayMs: 30,
    generateSuggestions: async () => ['suggestion'],
  });
  const abort = new AbortController();
  const response = boardEventResponse(new Request('http://local/events', { signal: abort.signal }), identity, service);
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream; charset=utf-8');
  assert.equal(response.headers.get('Cache-Control'), 'no-store, no-transform');
  const reader = response.body.getReader();
  assert.equal((await readEvent(reader)).type, 'board.snapshot');
  const grant = service.executeEdit(command);
  assert.equal((await readEvent(reader)).lockId, grant.body.lockId);
  await clock.advance(100);
  assert.equal((await readEvent(reader)).type, 'edit.check');
  await clock.advance(10);
  assert.equal((await readEvent(reader)).type, 'edit.released');
  await clock.advance(30);
  const generated = await readEvent(reader);
  assert.equal(generated.type, 'board.snapshot');
  assert.equal(generated.board.cards[1].text, 'suggestion');
  abort.abort();
  assert.equal((await reader.read()).done, true);
  service.dispose();
});

test('SSEの切断・キャンセルは一度だけ購読解除し、不正な識別情報や未知ボードは拒否する', async () => {
  const service = createBoardService([board]);
  for (const mode of ['abort', 'cancel']) {
    const abort = new AbortController();
    let unsubscribed = 0;
    const response = boardEventResponse(new Request('http://local/events', { signal: abort.signal }), identity, {
      ...service,
      subscribeBoard(identity, receive) {
        const stop = service.subscribeBoard(identity, receive);
        return () => { unsubscribed++; stop(); };
      },
    });
    const reader = response.body.getReader();
    await readEvent(reader);
    if (mode === 'abort') abort.abort();
    else await reader.cancel();
    abort.abort();
    assert.equal(unsubscribed, 1);
  }
  assert.equal(boardEventResponse(new Request('http://local/events'), { ...identity, clientId: '' }, service).status, 400);
  assert.equal(boardEventResponse(new Request('http://local/events'), { ...identity, boardId: 'missing' }, service).status, 404);
  service.dispose();
});
