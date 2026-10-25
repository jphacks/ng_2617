import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoardService } from './board-service.ts';
import { fakeClock, deferred, flush } from '../test/fake-clock.mjs';
import { board, block, cid, commands, identity, word } from '../test/board-fixtures.mjs';
import { getCard } from '../domain/board.ts';

function setup(t, options = {}, initial = board()) {
  const clock = fakeClock(); const events = []; const generated = []; const updates = []; const errors = [];
  const service = createBoardService([initial], { now: clock.now, schedule: clock.schedule, lockTtlMs: 100, replyTimeoutMs: 10, additionDelayMs: 30,
    generateSuggestions: async (board, level) => { generated.push({ board, level }); return ['first', 'second', 'third', 'fourth']; },
    onBoardUpdated: update => updates.push(update), onGenerationError: error => errors.push(error), ...options });
  t.after(() => service.dispose()); service.subscribeBoard(identity, event => events.push(event));
  const command = commands(); const run = (type, fields = {}) => service.executeCommand(command(type, fields));
  const current = () => service.getBoardSnapshot('board');
  const acquire = (cardIds = [cid(1)]) => run('edit.request', { cardIds }).body;
  const cancel = lock => run('edit.cancel', { lockId: lock.lockId });
  const check = () => events.findLast(event => event.type === 'edit.check');
  const reply = (check, state = 'editing', changes = check.cardIds.map(cardId => ({ cardId, patch: {} }))) =>
    run('edit.check.reply', { lockId: check.lockId, checkId: check.checkId, state, ...(state !== 'cancelling' && { changes }) });
  return { clock, service, events, generated, updates, errors, run, current, acquire, cancel, check, reply, command };
}

test('期限確認は貸し出し単位で所有端末だけに配信し、1枚の変更で全対象を継続する', async t => {
  const s = setup(t); const other = [];
  s.service.subscribeBoard({ ...identity, clientId: 'other' }, event => other.push(event));
  const grant = s.acquire([cid(1), cid(2)]); const oldDeadline = s.clock.scheduled[0].callback;
  await s.clock.advance(100); const check = s.check(); const oldTimeout = s.clock.scheduled.at(-1).callback;
  assert.equal(check.lockId, grant.lockId); assert.equal(check.cardIds.length, 2);
  assert.equal(other.some(event => 'lockId' in event), false);
  const result = s.reply(check, 'editing', [{ cardId: cid(1), patch: { text: 'interim' } }, { cardId: cid(2), patch: {} }]);
  assert.equal(result.body.outcome, 'saved'); assert.equal(s.current().revision, 2);
  assert.equal(getCard(s.current().board, cid(1)).text, 'interim');
  assert.ok(getCard(s.current().board, cid(2)).editingUser);
  oldDeadline(); oldTimeout(); assert.equal(s.current().revision, 2);
  await s.clock.advance(100); const next = s.check(); assert.notEqual(next.checkId, check.checkId);
  assert.equal(s.reply(check).status, 409);
  s.reply(next); assert.equal(s.current().board.cards.some(card => card.editingUser), false);
});
test('変更なし・同内容・無応答は貸し出し全体を解除し、最後の解除から1回生成する', async t => {
  for (const mode of ['unchanged', 'equal', 'timeout']) {
    const s = setup(t); s.acquire([cid(1), cid(2)]); await s.clock.advance(100);
    if (mode === 'timeout') await s.clock.advance(10);
    else s.reply(s.check(), 'editing', [
      { cardId: cid(1), patch: mode === 'equal' ? { text: 'word-1' } : {} }, { cardId: cid(2), patch: {} },
    ]);
    assert.equal(s.current().revision, 2); assert.equal(s.current().board.cards.some(card => card.editingUser), false);
    await s.clock.advance(29); assert.equal(s.generated.length, 0);
    await s.clock.advance(1); assert.equal(s.generated.length, 1); assert.equal(s.generated[0].level, 'mid');
    assert.equal(s.current().board.cards.length, 6);
    assert.equal(s.events.at(-1).type, 'board.cards-generated'); assert.equal(s.events.at(-1).generatedCardIds.length, 3);
    assert.equal(s.clock.pending(), 1);
    await s.clock.advance(1000); assert.equal(s.generated.length, 1); assert.equal(s.clock.pending(), 0);
  }
});
test('確定要求済み・取消要求済みの問い合わせを通常の終了処理で回収する', async t => {
  for (const state of ['committing', 'cancelling']) {
    const s = setup(t); s.acquire([cid(1), cid(2)]); await s.clock.advance(100);
    const check = s.check(); const oldTimeout = s.clock.scheduled.at(-1).callback;
    const result = s.reply(check, state, [{ cardId: cid(1), patch: { text: 'final' } }, { cardId: cid(2), patch: {} }]);
    assert.equal(result.body.outcome, state === 'committing' ? 'committed' : 'cancelled');
    assert.equal(getCard(s.current().board, cid(1)).text, state === 'committing' ? 'final' : 'word-1');
    assert.equal(s.current().board.cards.some(card => card.editingUser), false);
    oldTimeout(); assert.equal(s.current().revision, 2); assert.equal(s.reply(check).status, 403);
  }
});
test('通常確定と取消が先着したら、古い問い合わせ・期限コールバックはロックを復活させない', async t => {
  for (const type of ['edit.commit', 'edit.cancel']) {
    const s = setup(t); const lock = s.acquire(); await s.clock.advance(100);
    const check = s.check(); const oldTimeout = s.clock.scheduled.at(-1).callback;
    s.run(type, { lockId: lock.lockId, ...(type === 'edit.commit' && { changes: [{ cardId: cid(1), patch: { text: 'final' } }] }) });
    s.acquire(); oldTimeout(); assert.equal(s.reply(check).status, 403); assert.equal(s.current().revision, 3);
    assert.ok(getCard(s.current().board, cid(1)).editingUser);
  }
});
test('不正な問い合わせ返答は期限を延長せず、途中保存後の取消は保存済み内容を残す', async t => {
  const s = setup(t); const lock = s.acquire(); await s.clock.advance(100); const check = s.check();
  for (const fields of [{ clientId: 'other' }, { userId: 'other' }, { lockId: 'other' }, { checkId: 'other' }, { changes: [{ cardId: cid(1), patch: { text: 3 } }] }]) {
    assert.ok(s.run('edit.check.reply', { lockId: check.lockId, checkId: check.checkId, state: 'editing', changes: [{ cardId: cid(1), patch: {} }], ...fields }).status >= 400);
  }
  s.reply(check, 'editing', [{ cardId: cid(1), patch: { text: 'saved' } }]); s.cancel(lock);
  assert.equal(getCard(s.current().board, cid(1)).text, 'saved'); assert.equal(s.current().revision, 3);
});
test('取得・拒否では生成せず、最後の解除後の即時操作で待機をリセットする', async t => {
  const s = setup(t); await s.clock.advance(1000); assert.equal(s.generated.length, 0);
  s.cancel(s.acquire()); const oldWait = s.clock.scheduled.at(-1).callback;
  await s.clock.advance(20); s.run('reaction.add', { cardId: cid(3), reactionId: 'heart' }); oldWait();
  await s.clock.advance(20); assert.equal(s.generated.length, 0);
  s.run('reaction.add', { cardId: cid(3), reactionId: 'heart' });
  s.run('edit.request', { cardIds: [cid(99)] }); s.current();
  await s.clock.advance(10); assert.equal(s.generated.length, 1);
});
test('待機中の編集許可は古い待機を停止し、別ロックが残る間も生成しない', async t => {
  const s = setup(t); s.cancel(s.acquire()); const oldWait = s.clock.scheduled.at(-1).callback;
  const a = s.acquire(); const b = s.acquire([cid(2)]); oldWait(); s.cancel(a);
  await s.clock.advance(40); assert.equal(s.generated.length, 0); s.cancel(b);
  await s.clock.advance(30); assert.equal(s.generated.length, 1);
});
test('全消去・空カード・空白本文は待機満了でも生成せず、手動生成も拒否する', async t => {
  for (const initial of [board([word(1, { text: ' \n ' })]), board([block(3, { text: '', relatedIds: [] })])]) {
    const s = setup(t, {}, initial); const id = initial.cards[0].cardId;
    s.cancel(s.acquire([id])); await s.clock.advance(30); assert.equal(s.generated.length, 0); assert.equal(s.clock.pending(), 0);
    assert.equal(s.run('generation.request', { level: 'mid' }).status, 409);
    s.run('board.clear'); await s.clock.advance(30); assert.equal(s.current().board.cards.length, 0); assert.equal(s.generated.length, 0);
  }
});
test('手動と自動で同じ生成処理を使い、関連性を渡し、処理中の再送でも二重起動しない', async t => {
  const job = deferred(); const inputs = [];
  const s = setup(t, { generateSuggestions: (board, level) => { inputs.push({ board, level }); return job.promise; } });
  const request = s.command('generation.request', { level: 'low' });
  const first = s.service.executeCommand(request); assert.equal(first.status, 200);
  assert.equal(first.body.generation.status, 'running'); assert.equal(s.current().revision, 0);
  assert.deepEqual(s.service.executeCommand(request), first); assert.equal(s.run('generation.request', { level: 'high' }).status, 409);
  await flush(); assert.equal(inputs.length, 1); assert.equal(inputs[0].level, 'low');
  job.resolve(['new']); await flush(); await flush();
  assert.equal(s.current().generation.status, 'completed'); assert.equal(s.current().revision, 1);
  assert.equal(s.events.at(-1).generationId, first.body.generation.generationId);
  await s.clock.advance(300); assert.equal(inputs.length, 1);
});
test('生成中の共有タイマー更新は結果を無効化せず、最新タイマーを維持する', async t => {
  const job = deferred(); const s = setup(t, { generateSuggestions: () => job.promise });
  s.run('generation.request', { level: 'high' }); s.run('timer.start'); const timer = s.current().board.timer;
  job.resolve(['new']); await flush(); await flush();
  assert.equal(s.current().generation.status, 'completed'); assert.deepEqual(s.current().board.timer, timer);
  assert.equal(s.current().revision, 2);
});
test('生成中の編集・リアクション・矢印・削除で古い結果を破棄し、次の待機を取りこぼさない', async t => {
  for (const type of ['edit', 'reaction', 'delete', 'arrow']) {
    const jobs = []; const s = setup(t, { generateSuggestions: () => { const job = deferred(); jobs.push(job); return job.promise; } });
    s.cancel(s.acquire()); await s.clock.advance(30); assert.equal(jobs.length, 1);
    if (type === 'edit') s.cancel(s.acquire());
    if (type === 'reaction') s.run('reaction.add', { cardId: cid(3), reactionId: 'heart' });
    if (type === 'delete') s.run('objects.delete', { objectIds: [cid(2)] });
    if (type === 'arrow') s.run('arrow.create', { arrow: { arrowId: { ...cid(4), type: 'arrow' }, sourceCardId: cid(1), targetCardId: cid(2), sourceAnchor: 'east', targetAnchor: 'west' } });
    await s.clock.advance(30); assert.equal(jobs.length, 1);
    jobs[0].resolve(['stale']); await flush(); await flush(); assert.equal(s.current().generation.status, 'discarded');
    assert.equal(s.current().board.cards.some(card => card.text === 'stale'), false);
    await s.clock.advance(0); assert.equal(jobs.length, 2);
    jobs[1].resolve(['fresh']); await flush(); await flush(); assert.equal(s.current().board.cards.at(-1).text, 'fresh');
  }
});
test('生成失敗・候補0件は進行表示を終了し、revisionや待機を増やさず自動再試行しない', async t => {
  for (const fails of [true, false]) {
    const s = setup(t, { generateSuggestions: async () => { if (fails) throw new Error('failed'); return []; } });
    s.run('generation.request', { level: 'mid' }); await flush(); await flush();
    assert.equal(s.current().generation.status, fails ? 'failed' : 'completed'); assert.equal(s.current().revision, 0);
    assert.equal(s.errors.length, fails ? 1 : 0); await s.clock.advance(1000); assert.equal(s.clock.pending(), 0);
  }
});
test('共有タイマーは初期5分停止・再開・リセット・0秒停止し、終了フックは1実行につき1回', async t => {
  const finishes = []; const s = setup(t, { onTimerFinished: board => finishes.push(board) });
  assert.deepEqual(s.current().board.timer, { durationMs: 300000, state: 'stopped', remainingMs: 300000 });
  s.run('timer.stop'); s.run('timer.reset'); assert.equal(s.current().revision, 0);
  const start = s.command('timer.start'); s.service.executeCommand(start); const stale = s.clock.scheduled.at(-1).callback;
  s.service.executeCommand(start); s.run('timer.start'); assert.equal(s.current().revision, 1);
  await s.clock.advance(1000); s.run('timer.stop'); assert.equal(s.current().board.timer.remainingMs, 299000);
  stale(); assert.equal(finishes.length, 0);
  s.run('timer.start'); await s.clock.advance(299000); assert.equal(finishes.length, 1);
  assert.equal(s.current().board.timer.remainingMs, 0); const revision = s.current().revision;
  s.run('timer.start'); assert.equal(s.current().revision, revision);
  s.run('timer.reset'); s.run('timer.start'); const old = s.clock.scheduled.at(-1).callback;
  s.run('timer.reset'); old(); assert.equal(finishes.length, 1);
});
test('共有タイマーの更新だけでは自動生成の待機を変えない', async t => {
  const s = setup(t); s.cancel(s.acquire()); await s.clock.advance(20); s.run('timer.start');
  await s.clock.advance(10); assert.equal(s.generated.length, 1);
  assert.equal(s.current().board.timer.state, 'running');
});
