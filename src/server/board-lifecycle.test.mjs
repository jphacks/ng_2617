import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoardService } from './board-service.ts';
import { fakeClock, deferred, flush } from '../test/fake-clock.mjs';

const card = { cardId: 'card', shape: 'rectangle', position: { x: 0, y: 0, z: 0 }, color: '#fff', text: 'original', font: 'sans-serif' };
const board = { boardId: 'board', cards: [card] };
const identity = { boardId: 'board', userId: 'user', clientId: 'client' };
const request = { ...identity, type: 'edit.request', cardId: 'card', requestId: 'request' };
const content = { ...card };
delete content.cardId;

function setup(options = {}, initialBoards = [board]) {
  const clock = fakeClock();
  const generated = [];
  const events = [];
  const errors = [];
  let id = 0;
  const service = createBoardService(initialBoards, {
    now: clock.now, schedule: clock.schedule, lockTtlMs: 100, replyTimeoutMs: 10, additionDelayMs: 30,
    createLockId: () => `lock-${++id}`, createCheckId: () => `check-${++id}`,
    generateSuggestions: async value => { generated.push(value); return ['first', 'second', 'third', 'fourth']; },
    onGenerationError: error => errors.push(error), ...options,
  });
  service.subscribeBoard(identity, event => events.push(event));
  const snapshot = () => service.getBoardSnapshot('board');
  const acquire = (extra = {}) => service.requestEdit({ ...request, ...extra }).body;
  const cancel = (grant, extra = {}) => service.cancelEdit({ ...request, type: 'edit.cancel', lockId: grant.lockId, ...extra });
  const reply = (check, changed = true, extra = {}) => service.replyToEditCheck({
    ...request, type: 'edit.check.reply', requestId: 'reply', lockId: check.lockId, checkId: check.checkId,
    changed, ...(changed && { content: { ...content, text: 'saved draft' } }), ...extra,
  });
  return { clock, service, generated, events, errors, snapshot, acquire, cancel, reply };
}

test('アクセスなしで所有端末だけに問い合わせ、途中保存でロックを継続する', async () => {
  const s = setup();
  const other = [];
  s.service.subscribeBoard({ ...identity, clientId: 'other' }, event => other.push(event));
  const grant = s.acquire();
  const staleDeadline = s.clock.scheduled[0].callback;
  await s.clock.advance(100);
  const check = s.events.at(-1);
  assert.equal(check.type, 'edit.check');
  assert.equal(check.lockId, grant.lockId);
  assert.equal(other.some(event => 'lockId' in event), false);
  assert.equal(s.snapshot().revision, 1);
  const staleTimeout = s.clock.scheduled.at(-1).callback;
  const result = s.reply(check);
  assert.equal(result.body.outcome, 'saved');
  assert.equal(result.body.revision, 2);
  assert.equal(s.snapshot().board.cards[0].text, 'saved draft');
  assert.deepEqual(s.snapshot().board.cards[0].editingUser, { userId: 'user' });
  staleDeadline();
  staleTimeout();
  assert.equal(s.snapshot().revision, 2);
  await s.clock.advance(99);
  assert.equal(s.generated.length, 0);
  assert.equal(s.events.at(-1).type, 'edit.checked');
  await s.clock.advance(1);
  const next = s.events.at(-1);
  assert.equal(next.type, 'edit.check');
  assert.notEqual(next.checkId, check.checkId);
  assert.equal(next.lockId, grant.lockId);
  assert.equal(s.reply(check).status, 409);
  assert.equal(s.snapshot().revision, 2);
  s.reply(next, false);
  assert.equal(s.snapshot().board.cards[0].text, 'saved draft');
  assert.equal(s.snapshot().board.cards[0].editingUser, undefined);
});

test('変更なし・内容が同じ・無応答はいずれも解除し、最後の解除から待機する', async () => {
  for (const mode of ['unchanged', 'equal', 'timeout']) {
    const s = setup();
    s.acquire();
    await s.clock.advance(100);
    if (mode === 'timeout') await s.clock.advance(10);
    else s.reply(s.events.at(-1), mode === 'equal', mode === 'equal' ? { content } : {});
    assert.equal(s.snapshot().board.cards[0].editingUser, undefined);
    assert.equal(s.snapshot().revision, 2);
    await s.clock.advance(29);
    assert.equal(s.generated.length, 0);
    await s.clock.advance(1);
    assert.equal(s.generated.length, 1);
    assert.equal(s.snapshot().board.cards.length, 4);
  }
});

test('別端末・ユーザー・ロック・問い合わせ・ボードの返答と不正内容は更新しない', async () => {
  const s = setup();
  s.acquire();
  await s.clock.advance(100);
  const check = s.events.at(-1);
  for (const extra of [{ clientId: 'other' }, { userId: 'other' }, { lockId: 'other' }, { checkId: 'other' }, { boardId: 'other' }]) {
    assert.ok(s.reply(check, true, extra).status >= 400);
  }
  for (const extra of [{ content: {} }, { changed: 'yes' }, { content: { ...content, text: 12 } }, { content: { ...content, editingUser: { userId: 'other' } } }]) {
    assert.equal(s.reply(check, true, extra).status, 400);
  }
  assert.equal(s.snapshot().revision, 1);
  await s.clock.advance(10);
  assert.equal(s.snapshot().revision, 2);
  assert.equal(s.reply(check).status, 403);
});

test('問い合わせ中の確定・取消と遅延返答が競合しても二重反映もロック復活も起きない', async () => {
  for (const type of ['edit.commit', 'edit.cancel']) {
    const s = setup();
    const grant = s.acquire();
    await s.clock.advance(100);
    const check = s.events.at(-1);
    const timeout = s.clock.scheduled.at(-1).callback;
    const result = s.service.executeEdit({ ...request, type, lockId: grant.lockId, ...(type === 'edit.commit' && { content }) });
    assert.equal(result.status, 200);
    assert.equal(s.reply(check).status, 403);
    timeout();
    assert.equal(s.snapshot().revision, 2);
    const next = s.acquire();
    assert.notEqual(next.lockId, grant.lockId);
    timeout();
    assert.equal(s.reply(check).status, 403);
    assert.equal(s.snapshot().revision, 3);
    assert.ok(s.snapshot().board.cards[0].editingUser);
  }
});

test('途中保存が先に完了しても、通常確定・取消は同じロックで続行できる', async () => {
  for (const type of ['edit.commit', 'edit.cancel']) {
    const s = setup();
    const grant = s.acquire();
    await s.clock.advance(100);
    s.reply(s.events.at(-1));
    const result = s.service.executeEdit({ ...request, type, lockId: grant.lockId, ...(type === 'edit.commit' && { content: { ...content, text: 'final' } }) });
    assert.equal(result.status, 200);
    assert.equal(result.body.revision, 3);
    assert.equal(s.snapshot().board.cards[0].text, type === 'edit.commit' ? 'final' : 'saved draft');
    assert.equal(s.snapshot().board.cards[0].editingUser, undefined);
  }
});

test('初期取得と拒否は生成せず、複数カードの最後の解除時刻から一度だけ追加する', async () => {
  const s = setup({}, [{ ...board, cards: [card, { ...card, cardId: 'second' }] }]);
  await s.clock.advance(1000);
  assert.equal(s.generated.length, 0);
  assert.equal(s.service.executeEdit({ ...request, type: 'idle.heartbeat', isIdle: true }).status, 400);
  const first = s.acquire();
  const second = s.acquire({ cardId: 'second' });
  s.cancel(first);
  await s.clock.advance(40);
  assert.equal(s.generated.length, 0);
  s.cancel(second, { cardId: 'second' });
  await s.clock.advance(20);
  s.snapshot();
  assert.equal(s.service.executeEdit({ ...request, cardId: 'missing' }).status, 404);
  await s.clock.advance(10);
  assert.equal(s.generated.length, 1);
  assert.equal(s.snapshot().revision, 5);
  assert.equal(s.snapshot().board.cards.length, 5);
  assert.equal(new Set(s.snapshot().board.cards.map(card => card.cardId)).size, 5);
  // 自動生成後の通常の待機予約が存在し、満了すると再生成せず止まる。
  assert.equal(s.clock.pending(), 1);
  await s.clock.advance(30);
  assert.equal(s.clock.pending(), 0);
  await s.clock.advance(1000);
  s.snapshot();
  assert.equal(s.generated.length, 1);
});

test('待機中の新しい編集許可が古いタイマーを無効にし、次の終了から数え直す', async () => {
  const s = setup();
  s.cancel(s.acquire());
  const oldWait = s.clock.scheduled.at(-1).callback;
  await s.clock.advance(20);
  const grant = s.acquire();
  oldWait();
  await s.clock.advance(15);
  assert.equal(s.generated.length, 0);
  s.cancel(grant);
  await s.clock.advance(29);
  assert.equal(s.generated.length, 0);
  await s.clock.advance(1);
  assert.equal(s.generated.length, 1);
});

test('生成中の編集で古い結果を捨て、次の待機が満了済みでも新しい生成を取りこぼさない', async () => {
  const jobs = [];
  const inputs = [];
  const s = setup({ generateSuggestions: value => {
    inputs.push(structuredClone(value));
    value.cards[0].text = 'generator mutated its copy';
    const job = deferred(); jobs.push(job); return job.promise;
  } });
  s.cancel(s.acquire());
  await s.clock.advance(30);
  assert.equal(jobs.length, 1);
  const grant = s.acquire();
  s.service.commitEdit({ ...request, type: 'edit.commit', lockId: grant.lockId, content: { ...content, text: 'new revision' } });
  await s.clock.advance(30);
  assert.equal(jobs.length, 1);
  jobs[0].resolve(['stale']);
  await flush();
  await s.clock.advance(0);
  assert.equal(jobs.length, 2);
  assert.equal(s.snapshot().board.cards.length, 1);
  assert.equal(inputs[1].cards[0].text, 'new revision');
  assert.equal(s.snapshot().board.cards[0].text, 'new revision');
  jobs[1].resolve(['fresh']);
  await flush();
  assert.equal(s.snapshot().board.cards[1].text, 'fresh');
  await s.clock.advance(100);
  assert.equal(jobs.length, 2);
});

test('生成後の取消・確定・自動解除は新しい更新として再び生成できる', async () => {
  for (const finish of ['cancel', 'commit', 'timeout']) {
    let run = 0;
    const s = setup({ generateSuggestions: async () => [`word-${++run}`] });
    s.cancel(s.acquire());
    await s.clock.advance(30);
    assert.equal(run, 1);
    const grant = s.acquire();
    if (finish === 'cancel') s.cancel(grant);
    if (finish === 'commit') s.service.commitEdit({ ...request, type: 'edit.commit', lockId: grant.lockId, content });
    if (finish === 'timeout') await s.clock.advance(110);
    await s.clock.advance(30);
    assert.equal(run, 2);
    await s.clock.advance(100);
    assert.equal(run, 2);
  }
});

test('生成失敗・空候補の後はループせず、次の更新で再試行できる', async () => {
  for (const fail of [true, false]) {
    let runs = 0;
    const s = setup({ generateSuggestions: async () => {
      runs++;
      if (runs > 1) return ['next'];
      if (fail) throw new Error('generation unavailable');
      return ['', 'original', 'original'];
    } });
    s.cancel(s.acquire());
    await s.clock.advance(1000);
    assert.equal(runs, 1);
    assert.equal(s.errors.length, fail ? 1 : 0);
    assert.equal(s.snapshot().revision, 2);
    s.cancel(s.acquire());
    await s.clock.advance(30);
    assert.equal(runs, 2);
    assert.equal(s.snapshot().board.cards[1].text, 'next');
  }
});

test('ボードごとの待機・ロック・生成状態は混ざらない', async () => {
  const jobs = new Map();
  const s = setup({ generateSuggestions: value => {
    const job = deferred(); jobs.set(value.boardId, job); return job.promise;
  } }, [board, { ...board, boardId: 'other' }]);
  s.cancel(s.acquire());
  const other = s.acquire({ boardId: 'other' });
  await s.clock.advance(30);
  assert.deepEqual([...jobs.keys()], ['board']);
  s.cancel(other, { boardId: 'other' });
  await s.clock.advance(30);
  assert.deepEqual([...jobs.keys()], ['board', 'other']);
  jobs.get('board').resolve(['board suggestion']);
  jobs.get('other').resolve(['other suggestion']);
  await flush();
  assert.equal(s.snapshot().board.cards[1].text, 'board suggestion');
  assert.equal(s.service.getBoardSnapshot('other').board.cards[1].text, 'other suggestion');
});

test('問い合わせ中の再購読は同じ問い合わせを返し、応答期限を延ばさない', async () => {
  const s = setup();
  s.acquire();
  await s.clock.advance(100);
  const check = s.events.at(-1);
  await s.clock.advance(9);
  const events = [];
  const stop = s.service.subscribeBoard(identity, event => events.push(event));
  assert.equal(events[0].type, 'board.snapshot');
  assert.equal(events[1].checkId, check.checkId);
  await s.clock.advance(1);
  assert.equal(events.at(-1).type, 'edit.released');
  stop();
});

test('停止後はタイマーも非同期生成も状態を更新しない', async () => {
  const job = deferred();
  const s = setup({ generateSuggestions: () => job.promise });
  s.cancel(s.acquire());
  await s.clock.advance(30);
  const before = s.events.length;
  s.service.dispose();
  job.resolve(['late']);
  await flush();
  assert.equal(s.events.length, before);
  assert.equal(s.clock.pending(), 0);
  assert.equal(s.service.executeEdit(request).status, 503);
});

test('再起動時の初期データに編集者が残っていても孤立したロックは復元しない', async () => {
  const s = setup({}, [{ ...board, cards: [{ ...card, editingUser: { userId: 'old' } }] }]);
  assert.equal(s.snapshot().board.cards[0].editingUser, undefined);
  await s.clock.advance(1000);
  assert.equal(s.generated.length, 0);
  assert.equal(s.acquire().type, 'edit.granted');
});
