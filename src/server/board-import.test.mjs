import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoardService } from './board-service.ts';
import { createBoardFile } from '../client/board-file.ts';
import { validBoard } from '../domain/board-validation.ts';
import { objectKey } from '../domain/board.ts';
import { board, word, block, arrow, commands, identity, cid } from '../test/board-fixtures.mjs';
import { fakeClock, deferred, flush } from '../test/fake-clock.mjs';

function setup(t, options = {}) {
  const clock = fakeClock(); const updates = []; const events = []; let generations = 0;
  const service = createBoardService([board()], { now: clock.now, schedule: clock.schedule,
    additionDelayMs: 30, onBoardUpdated: value => updates.push(value),
    generateSuggestions: async () => { generations++; return ['generated']; }, ...options });
  service.subscribeBoard(identity, event => events.push(event));
  t.after(() => service.dispose());
  const command = commands();
  const run = (type, fields = {}) => service.executeCommand(command(type, fields));
  return { clock, updates, events, service, command, run, current: () => service.getBoardSnapshot('board'), generations: () => generations };
}
const file = () => createBoardFile(board([word(1, { text: '復元した本文' }), word(2),
  block(3, { reactions: [{ reactionId: 'idea', userId: 'a' }] })], [arrow()]));

test('読み込みは原子的に1回更新・通知し、IDと参照を再接続し、動作中タイマーを維持する', async t => {
  const s = setup(t); s.run('timer.start'); await s.clock.advance(100);
  const timer = s.current().board.timer; const revision = s.current().revision;
  const a = []; const b = [];
  s.service.subscribeBoard(identity, value => a.push(value));
  s.service.subscribeBoard({ ...identity, clientId: 'b' }, value => b.push(value));
  const result = s.run('board.import', { file: file() });
  assert.equal(result.status, 200); assert.equal(s.current().revision, revision + 1);
  assert.equal(s.updates.at(-1).kind, 'board-imported');
  const restored = s.current().board;
  assert.deepEqual(restored.timer, timer); assert.equal(validBoard(restored), true);
  assert.equal(restored.cards[0].text, '復元した本文');
  assert.equal(restored.cards.some(card => file().cards.some(old => objectKey(card.cardId) === objectKey(old.cardId))), false);
  assert.deepEqual(restored.cards[2].relatedIds, [restored.cards[0].cardId]);
  assert.deepEqual(restored.cards[2].reactions, file().cards[2].reactions);
  assert.deepEqual(restored.arrows[0].sourceCardId, restored.cards[0].cardId);
  assert.deepEqual(restored.arrows[0].targetCardId, restored.cards[1].cardId);
  assert.equal(a.length, 2); assert.equal(b.length, 2);
  assert.equal(a[1].type, 'command.accepted'); assert.deepEqual(a[1].board, b[1].board);
  await s.clock.advance(100); assert.equal(s.generations(), 0);
});

test('ロック・不正なファイルを拒否し、編集完了後の再試行のみ置き換える', t => {
  const s = setup(t); const grant = s.run('edit.request', { cardIds: [cid(1)] }).body;
  const before = s.current();
  assert.equal(s.run('board.import', { file: file() }).status, 409);
  assert.deepEqual(s.current(), before);
  assert.equal(s.run('board.import', { file: { ...file(), version: 2 } }).status, 400);
  assert.deepEqual(s.current(), before);
  s.run('edit.cancel', { lockId: grant.lockId });
  assert.equal(s.run('board.import', { file: file() }).status, 200);
  const restored = s.current();
  assert.equal(s.run('edit.commit', { lockId: grant.lockId, changes: [{ cardId: cid(1), patch: { text: 'old draft' } }] }).status, 403);
  assert.deepEqual(s.current(), restored);
});

test('応答消失後も同一要求を二重適用せず、異なる内容の再利用を拒否する', t => {
  const s = setup(t); const command = s.command('board.import', { file: file() });
  const first = s.service.executeCommand(command); const count = s.events.length;
  assert.deepEqual(s.service.executeCommand(structuredClone(command)), first);
  assert.equal(s.current().revision, 1); assert.equal(s.events.length, count); assert.equal(s.updates.length, 1);
  const savedError = console.error; console.error = () => {};
  try { assert.equal(s.service.executeCommand({ ...command, file: createBoardFile(board([], [])) }).status, 409); }
  finally { console.error = savedError; }
  assert.equal(s.current().revision, 1);
});

test('読み込みは待機中と生成中の古い候補を無効にし、自動生成を連鎖させない', async t => {
  const pending = deferred(); let called = 0;
  const s = setup(t, { generateSuggestions: () => { called++; return pending.promise; } });
  s.run('board.restore-sample'); // 自動生成待機中に読み込む。
  s.run('board.import', { file: file() }); await s.clock.advance(50); assert.equal(called, 0);
  s.run('generation.request', { level: 'mid' }); await flush(); assert.equal(called, 1);
  s.run('board.import', { file: file() }); const before = s.current().board;
  pending.resolve(['古い候補']); await flush(); await s.clock.advance(100);
  assert.deepEqual(s.current().board, before); assert.equal(called, 1);
  s.run('board.import', { file: createBoardFile(board([], [])) });
  assert.equal(s.current().board.cards.length, 0); assert.equal(s.current().board.arrows.length, 0);
});

test('読み込み後もタイマーは元の期限で一度だけ終了し、通常編集から自動生成を再開する', async t => {
  const finished = [];
  const s = setup(t, { onTimerFinished: value => finished.push(value) });
  s.run('timer.start');
  const endsAt = s.current().board.timer.endsAt;
  await s.clock.advance(100);
  s.run('board.import', { file: file() });
  await s.clock.advance(endsAt - s.clock.now() - 1);
  assert.equal(s.current().board.timer.state, 'running');
  assert.equal(s.generations(), 0);
  await s.clock.advance(1);
  assert.deepEqual(s.current().board.timer, { durationMs: 300_000, state: 'stopped', remainingMs: 0 });
  assert.equal(finished.length, 1);
  assert.equal(finished[0].cards[0].text, '復元した本文');
  const cardId = s.current().board.cards[0].cardId;
  const lock = s.run('edit.request', { cardIds: [cardId] }).body;
  s.run('edit.commit', { lockId: lock.lockId, changes: [{ cardId, patch: { text: '復元後の編集' } }] });
  await s.clock.advance(30); await flush();
  assert.equal(s.generations(), 1);
  assert.ok(s.current().board.cards.some(card => card.text === 'generated'));
  assert.equal(finished.length, 1);
});
