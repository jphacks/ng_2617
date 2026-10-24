import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoardService } from '../server/board-service.ts';
import { createBoardClient } from './board-client.ts';
import { createHttpBoardTransport } from './http-board-transport.ts';
import { fakeClock, flush } from '../test/fake-clock.mjs';

const board = { boardId: 'board', cards: [{ cardId: 'card', shape: 'rectangle', position: { x: 0, y: 0, z: 0 }, text: 'original', color: '#fff', font: 'sans-serif' }] };
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await flush();
  }
  assert.fail('Expected state was not reached');
}

test('2端末のHTTPとSSEで下書き保存・ロック継続・自動解除・候補追加まで同期する', async () => {
  const clock = fakeClock();
  const service = createBoardService([board], {
    now: clock.now, schedule: clock.schedule, lockTtlMs: 100, replyTimeoutMs: 10, additionDelayMs: 30,
    generateSuggestions: async () => ['suggestion'],
  });
  function client(clientId) {
    const identity = { boardId: 'board', userId: 'user', clientId };
    const transport = createHttpBoardTransport(async (_url, options) => {
      if (options.method === 'GET') return Response.json(service.getBoardSnapshot('board'));
      const result = service.executeEdit(JSON.parse(options.body), 'board');
      return Response.json(result.body, { status: result.status });
    }, () => {
      let stop;
      const stream = { closed: false, close() { this.closed = true; stop?.(); } };
      queueMicrotask(() => {
        if (stream.closed) return;
        stream.onopen();
        stop = service.subscribeBoard(identity, event => {
          queueMicrotask(() => { if (!stream.closed) stream.onmessage({ data: JSON.stringify(event) }); });
        });
      });
      return stream;
    });
    return createBoardClient(identity, transport);
  }
  const a = client('a');
  const b = client('b');
  try {
    a.connect(); b.connect();
    await until(() => a.getSnapshot().status === 'ready' && b.getSnapshot().status === 'ready');
    a.requestEdit('card');
    await until(() => a.getSnapshot().edit.phase === 'editing' && b.getSnapshot().revision === 1);
    assert.equal(b.requestEdit('card'), false);
    a.updateDraft({ text: 'interim save' });
    await clock.advance(100);
    await until(() => a.getSnapshot().revision === 2 && b.getSnapshot().revision === 2);
    assert.equal(a.getSnapshot().edit.phase, 'editing');
    assert.equal(b.getSnapshot().board.cards[0].text, 'interim save');
    assert.equal(b.getSnapshot().edit.phase, 'idle');
    await clock.advance(100);
    await until(() => a.getSnapshot().edit.phase === 'idle' && b.getSnapshot().revision === 3);
    assert.equal(service.getBoardSnapshot('board').board.cards[0].editingUser, undefined);
    await clock.advance(30);
    await until(() => a.getSnapshot().board.cards.length === 2 && b.getSnapshot().board.cards.length === 2);
    assert.equal(a.getSnapshot().board.cards[1].text, 'suggestion');
    await clock.advance(1000);
    assert.equal(service.getBoardSnapshot('board').board.cards.length, 2);
  } finally {
    a.disconnect(); b.disconnect(); service.dispose();
  }
});
