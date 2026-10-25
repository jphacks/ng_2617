import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoardService } from './board-service.ts';
import { createBoardFile } from '../client/board-file.ts';
import { createBoard, getCard } from '../domain/board.ts';
import { validBoard, validCommand, validEvent } from '../domain/board-validation.ts';
import { board, cid, commands, identity } from '../test/board-fixtures.mjs';
import { fakeClock, deferred, flush } from '../test/fake-clock.mjs';
import { connectedClient, until } from '../test/transport-harness.mjs';

function setup(t, options = {}, initial = board()) {
  const clock = fakeClock(); const events = []; const calls = [];
  const service = createBoardService([initial], { now: clock.now, schedule: clock.schedule, additionDelayMs: 30,
    generateSuggestions: async (_board, level) => { calls.push(level); return ['自動候補']; }, ...options });
  service.subscribeBoard(identity, event => events.push(event));
  t.after(() => service.dispose());
  const command = commands();
  const run = (type, fields = {}) => service.executeCommand(command(type, fields));
  const setting = enabled => run('board.settings.update', { autoGenerationEnabled: enabled });
  const editAndCancel = () => { const grant = run('edit.request', { cardIds: [cid(1)] }).body; run('edit.cancel', { lockId: grant.lockId }); };
  return { clock, service, events, calls, run, setting, editAndCancel, current: () => service.getBoardSnapshot('board') };
}

test('設定なしの既存ボードもONで読み込み、設定・コマンドはbooleanだけを受け入れる', t => {
  assert.deepEqual(createBoard('new').settings, { autoGenerationEnabled: true });
  const legacy = board(); delete legacy.settings;
  const s = setup(t, {}, legacy);
  assert.deepEqual(s.current().board.settings, { autoGenerationEnabled: true });
  assert.equal(validBoard(legacy), true);
  for (const settings of [{}, null, { autoGenerationEnabled: 'false' }, { autoGenerationEnabled: true, extra: 1 }]) {
    assert.equal(validBoard({ ...board(), settings }), false);
  }
  const command = commands();
  for (const autoGenerationEnabled of [undefined, null, 0, 'false']) {
    assert.equal(validCommand(command('board.settings.update', { autoGenerationEnabled })), false);
  }
  assert.equal(validCommand(command('board.settings.update', { autoGenerationEnabled: false })), true);
  const result = s.setting(false); assert.equal(validEvent(result.body), true);
});

test('設定は接続中の2端末と途中参加へ共有し、同じ値への更新では再配信しない', async t => {
  const s = setup(t);
  const a = connectedClient(s.service, { ...identity, clientId: 'a' }).client;
  const b = connectedClient(s.service, { ...identity, clientId: 'b' }).client;
  t.after(() => { a.disconnect(); b.disconnect(); });
  a.connect(); b.connect(); await until(() => a.getSnapshot().status === 'ready' && b.getSnapshot().status === 'ready');
  a.execute({ type: 'board.settings.update', autoGenerationEnabled: false });
  await until(() => !a.getSnapshot().board.settings.autoGenerationEnabled && !b.getSnapshot().board.settings.autoGenerationEnabled);
  const count = s.events.length; const revision = s.current().revision;
  assert.equal(s.setting(false).body.changed, false);
  assert.equal(s.events.length, count); assert.equal(s.current().revision, revision);
  const c = connectedClient(s.service, { ...identity, clientId: 'c' }).client;
  t.after(() => c.disconnect()); c.connect(); await until(() => c.getSnapshot().status === 'ready');
  assert.equal(c.getSnapshot().board.settings.autoGenerationEnabled, false);
});

test('OFFは予約を取り消し、ONは新しい待機時間から再開し、手動生成はOFFでも実行できる', async t => {
  const s = setup(t); s.editAndCancel();
  const oldWait = s.clock.scheduled.at(-1).callback;
  await s.clock.advance(20); s.setting(false); oldWait();
  await s.clock.advance(100); assert.equal(s.calls.length, 0);
  s.setting(true); await s.clock.advance(29); assert.equal(s.calls.length, 0);
  await s.clock.advance(1); assert.equal(s.calls.length, 1);
  s.setting(false);
  assert.equal(s.run('generation.request', { level: 'high' }).status, 200);
  await flush(); await flush(); assert.deepEqual(s.calls, ['mid', 'high']);
  await s.clock.advance(100); assert.equal(s.calls.length, 2);
});

test('同じONへの更新は予約時刻を延ばさず、ロック中のONは最後の編集終了から待機する', async t => {
  const s = setup(t); s.editAndCancel(); await s.clock.advance(20);
  assert.equal(s.setting(true).body.changed, false);
  await s.clock.advance(10); assert.equal(s.calls.length, 1);
  s.setting(false);
  const lock = s.run('edit.request', { cardIds: [cid(1)] }).body;
  s.setting(true); await s.clock.advance(100); assert.equal(s.calls.length, 1);
  s.run('edit.cancel', { lockId: lock.lockId });
  await s.clock.advance(29); assert.equal(s.calls.length, 1);
  await s.clock.advance(1); assert.equal(s.calls.length, 2);
});

test('OFFからONへ戻しても、設定変更前に開始した自動生成の結果は追加しない', async t => {
  const jobs = [];
  const s = setup(t, { generateSuggestions: () => { const job = deferred(); jobs.push(job); return job.promise; } });
  s.editAndCancel(); await s.clock.advance(30); assert.equal(jobs.length, 1);
  s.setting(false); s.setting(true);
  const before = s.current().board.cards;
  jobs[0].resolve(['古い候補']); await flush(); await flush();
  assert.deepEqual(s.current().board.cards, before);
  assert.equal(s.current().generation.status, 'discarded');
  assert.equal(s.events.some(event => event.type === 'board.cards-generated'), false);
  await s.clock.advance(30); assert.equal(jobs.length, 2);
  jobs[1].resolve(['新しい候補']); await flush(); await flush();
  assert.ok(s.current().board.cards.some(card => card.text === '新しい候補'));
});

test('設定変更は手動生成の結果や共有タイマーの期限を無効にしない', async t => {
  const job = deferred(); const finished = [];
  const s = setup(t, { generateSuggestions: () => job.promise, onTimerFinished: board => finished.push(board) });
  s.run('timer.start'); const timer = s.current().board.timer;
  s.run('generation.request', { level: 'low' }); await flush();
  s.setting(false); s.setting(true); assert.deepEqual(s.current().board.timer, timer);
  job.resolve(['手動の候補']); await flush(); await flush();
  assert.ok(s.current().board.cards.some(card => card.text === '手動の候補'));
  await s.clock.advance(timer.endsAt); assert.equal(finished.length, 1);
});

test('OFF設定はJSON読み込み・サンプル復元・全消去で維持される', async t => {
  const s = setup(t); s.setting(false);
  for (const [type, fields] of [['board.import', { file: createBoardFile(board()) }], ['board.restore-sample', {}], ['board.clear', {}]]) {
    assert.equal(s.run(type, fields).status, 200);
    assert.equal(s.current().board.settings.autoGenerationEnabled, false);
    await s.clock.advance(100); assert.equal(s.calls.length, 0);
  }
});

test('神経衰弱中も設定を変更でき、ゲームの期限と内容を維持する', async t => {
  const s = setup(t); assert.equal(s.run('matching.start').status, 200);
  const before = s.current().board;
  assert.equal(s.setting(false).status, 200);
  assert.deepEqual(s.current().board.matching, before.matching);
  assert.deepEqual(s.current().board.timer, before.timer);
  assert.equal(validBoard(s.current().board), true);
  await s.clock.advance(30); assert.equal(s.calls.length, 0);
});

test('退室は自分の接続の全ロックのみ解除し、遅れて届く編集要求を拒否する', t => {
  const s = setup(t); const other = commands({ ...identity, clientId: 'other' });
  s.run('edit.request', { cardIds: [cid(1)] });
  s.run('edit.request', { cardIds: [cid(2)] });
  s.service.executeCommand(other('edit.request', { cardIds: [cid(3)] }));
  const result = s.run('board.leave'); assert.equal(result.status, 200); assert.equal(validEvent(result.body), true);
  assert.equal(getCard(s.current().board, cid(1)).editingUser, undefined);
  assert.equal(getCard(s.current().board, cid(2)).editingUser, undefined);
  assert.ok(getCard(s.current().board, cid(3)).editingUser);
  assert.equal(s.run('edit.request', { cardIds: [cid(1)] }).status, 403);
  assert.equal(s.service.executeCommand(other('edit.request', { cardIds: [cid(1)] })).status, 200);
  assert.equal(s.run('board.leave').body.changed, false);
});

test('一時的なSSE切断ではロックを解除せず、退室後の再入室は新しい接続で編集できる', t => {
  const s = setup(t); const stop = s.service.subscribeBoard(identity, () => {});
  s.run('edit.request', { cardIds: [cid(1)] }); stop();
  assert.ok(getCard(s.current().board, cid(1)).editingUser);
  s.run('board.leave');
  const returned = commands({ ...identity, clientId: 'returned' });
  assert.equal(s.service.executeCommand(returned('edit.request', { cardIds: [cid(1)] })).status, 200);
});
