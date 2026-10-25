import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoardService } from '../server/board-service.ts';
import { fakeClock } from '../test/fake-clock.mjs';
import { board, cid, identity } from '../test/board-fixtures.mjs';
import { connectedClient, until } from '../test/transport-harness.mjs';
import { getCard } from '../domain/board.ts';

test('2端末のHTTP＋SSEで複数編集・途中保存・自動解除・候補通知を同期する', async t => {
  const clock = fakeClock(); const service = createBoardService([board()], {
    now: clock.now, schedule: clock.schedule, lockTtlMs: 100, replyTimeoutMs: 10, additionDelayMs: 30,
    generateSuggestions: async () => ['suggestion'],
  });
  const a = connectedClient(service, { ...identity, clientId: 'a' }).client;
  const b = connectedClient(service, { ...identity, clientId: 'b' }).client;
  t.after(() => { a.disconnect(); b.disconnect(); service.dispose(); });
  a.connect(); b.connect(); await until(() => a.getSnapshot().status === 'ready' && b.getSnapshot().status === 'ready');
  a.requestEdit([cid(1), cid(2)]); await until(() => a.getSnapshot().edit.phase === 'editing' && b.getSnapshot().revision === 1);
  assert.equal(b.requestEdit(cid(1)), false);
  a.updateDraft({ text: 'interim' }, cid(1)); await clock.advance(100);
  await until(() => a.getSnapshot().revision === 2 && b.getSnapshot().revision === 2);
  assert.equal(a.getSnapshot().edit.phase, 'editing'); assert.equal(getCard(b.getSnapshot().board, cid(1)).text, 'interim');
  await clock.advance(100); await until(() => a.getSnapshot().edit.phase === 'idle' && b.getSnapshot().revision === 3);
  await clock.advance(30); await until(() => a.getSnapshot().board.cards.length === 4 && b.getSnapshot().board.cards.length === 4);
  assert.deepEqual(a.getSnapshot().generatedCardIds, b.getSnapshot().generatedCardIds);
  assert.equal(a.getSnapshot().generation.status, 'completed');
  await clock.advance(1000); assert.equal(service.getBoardSnapshot('board').board.cards.length, 4);
});
test('届かなかった確定・取消要求を期限確認から回収し、再送でも二重反映しない', async t => {
  for (const operation of ['commitEdit', 'cancelEdit']) {
    const clock = fakeClock(); const service = createBoardService([board()], {
      now: clock.now, schedule: clock.schedule, lockTtlMs: 100, replyTimeoutMs: 10, additionDelayMs: 30,
    });
    const { client } = connectedClient(service, identity, command => {
      if (command.type === 'edit.commit' || command.type === 'edit.cancel') throw new Error('HTTP request lost');
    });
    t.after(() => { client.disconnect(); service.dispose(); });
    client.connect(); await until(() => client.getSnapshot().status === 'ready');
    client.requestEdit(cid(1)); await until(() => client.getSnapshot().edit.phase === 'editing');
    client.updateDraft({ text: 'final' }); client[operation](); await until(() => !!client.getSnapshot().error);
    assert.equal(client.getSnapshot().status, 'ready');
    await clock.advance(100); await until(() => client.getSnapshot().edit.phase === 'idle');
    assert.equal(client.getSnapshot().pendingCommands.length, 0); assert.equal(service.getBoardSnapshot('board').revision, 2);
    assert.equal(getCard(service.getBoardSnapshot('board').board, cid(1)).text, operation === 'commitEdit' ? 'final' : 'word-1');
    client.retryPending(); assert.equal(service.getBoardSnapshot('board').revision, 2);
  }
});
test('途中参加・再接続は現在の生成状態を取得し、過去の案内を再生しない', async t => {
  const service = createBoardService([board()], { generateSuggestions: async () => ['new'] });
  const a = connectedClient(service, { ...identity, clientId: 'a' }).client;
  const b = connectedClient(service, { ...identity, clientId: 'b' }).client;
  t.after(() => { a.disconnect(); b.disconnect(); service.dispose(); });
  a.connect(); await until(() => a.getSnapshot().status === 'ready');
  a.execute({ type: 'generation.request', level: 'high' }); await until(() => a.getSnapshot().generation.status === 'completed');
  assert.equal(a.getSnapshot().generatedCardIds.length, 1);
  b.connect(); await until(() => b.getSnapshot().status === 'ready');
  assert.equal(b.getSnapshot().board.cards.length, 4); assert.equal(b.getSnapshot().generation.status, 'completed');
  assert.deepEqual(b.getSnapshot().generatedCardIds, []);
  a.disconnect(); a.connect(); await until(() => a.getSnapshot().status === 'ready'); assert.deepEqual(a.getSnapshot().generatedCardIds, []);
});
