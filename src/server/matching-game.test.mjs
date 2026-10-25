import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoardService } from './board-service.ts';
import { validBoard, validCommand, validEvent } from '../domain/board-validation.ts';
import { createEmptyCard, objectKey } from '../domain/board.ts';
import { MATCHING_DURATION_MS as DURATION, MATCHING_FINALIZE_MS as FINALIZE } from '../domain/matching.ts';
import { board, word, block, commands, identity, cid } from '../test/board-fixtures.mjs';
import { fakeClock, deferred, flush } from '../test/fake-clock.mjs';
import { BOARD_FILE_FORMAT } from '../domain/board-file.ts';

function setup(t, count = 4, options = {}) {
  const clock = fakeClock(); const events = []; const generations = [];
  const original = board([...Array.from({ length: count }, (_, i) => word(i + 1)), block(100), word(101, { text: '  ' })]);
  const service = createBoardService([original], { now: clock.now, schedule: clock.schedule, random: () => 0.25,
    generateSuggestions: async () => { generations.push(true); return ['unused']; }, ...options });
  t.after(() => { service.dispose(); assert.ok(events.every(validEvent), '配信する中間状態も実行時検証に通る'); });
  const stops = [];
  const join = (userId = identity.userId, clientId = identity.clientId) => {
    const sender = commands({ ...identity, userId, clientId });
    const stop = service.subscribeBoard({ ...identity, userId, clientId }, event => events.push(event)); stops.push(stop);
    return { stop, run: (type, fields = {}) => service.executeCommand(sender(type, fields)), sender };
  };
  const owner = join();
  const current = () => service.getBoardSnapshot('board').board;
  const game = () => current().matching;
  const start = () => owner.run('matching.start');
  const select = (copyId, player = owner, fields = {}) => player.run('matching.select', { gameId: game().gameId, turnId: game().turnId, copyId, ...fields });
  const write = (text, player = owner, fields = {}) => {
    const draft = game().drafts.find(draft => draft.userId === player.sender('board.get').userId);
    return player.run('matching.draft', { gameId: game().gameId, turnId: game().turnId,
      writerToken: draft.writerToken, sequence: draft.sequence + 1, text, final: false, ...fields });
  };
  const pair = (player = owner) => { const ids = game().slots.filter(Boolean).slice(0, 2); ids.forEach(id => assert.equal(select(id, player).status, 200)); return ids; };
  return { clock, events, generations, original, service, join, owner, current, game, start, select, pair, write };
}

test('1人で開始し、全カードのコピーと最大10枠を共有し、元の配置・関連を変えない', t => {
  const s = setup(t, 13); assert.equal(s.start().status, 200);
  assert.equal(s.game().selectorUserId, identity.userId); assert.equal(s.game().copies.length, 15);
  assert.equal(s.game().slots.length, 10); assert.equal(s.game().reserve.length, 3);
  assert.deepEqual(s.current().cards, s.original.cards); assert.deepEqual(s.current().arrows, s.original.arrows);
  assert.equal(s.current().timer.durationMs, DURATION); assert.equal(s.current().timer.endsAt, DURATION);
  assert.equal(s.start().status, 409); assert.ok(validBoard(s.current()));
});
test('編集中・単語不足・接続していない端末からは開始できない', t => {
  const s = setup(t); const lock = s.owner.run('edit.request', { cardIds: [cid(1)] });
  assert.equal(s.start().status, 409);
  s.owner.run('edit.cancel', { lockId: lock.body.lockId }); assert.equal(s.start().status, 200);
  const short = setup(t, 1); assert.equal(short.start().status, 409);
  assert.equal(short.service.executeCommand(commands({ ...identity, clientId: 'offline' })('matching.start')).status, 403);
});
test('担当者だけが異なる表示枠を2枚選べ、2枚目で接続中ユーザーへ1枚ずつ配る', t => {
  const s = setup(t); const other = s.join('other', 'other-client'); s.join('other', 'other-tab'); s.start();
  const id = s.game().slots[0]; assert.equal(s.select(id, other).status, 403);
  assert.equal(s.select(s.game().reserve[0] ?? 'missing').status, 409);
  assert.equal(s.select(id).status, 200); assert.equal(s.select(id).status, 409);
  assert.equal(s.game().step, 'selecting'); assert.equal(s.select(s.game().slots[1]).status, 200);
  assert.equal(s.game().step, 'writing'); assert.equal(s.game().drafts.length, 2);
  assert.equal(s.game().drafts.find(draft => draft.userId === 'other').writerClientId, 'other-tab');
});
test('全員空なら同じ表示枠に戻し、1人で続行する。古い期限は次の手番へ作用しない', async t => {
  const s = setup(t); s.start(); const slots = s.game().slots; const oldId = s.game().turnId;
  const staleSelection = s.clock.scheduled.at(-1).callback; s.pair(); staleSelection(); assert.equal(s.game().step, 'writing');
  await s.clock.advance(DURATION); assert.equal(s.game().step, 'closing');
  const staleClosing = s.clock.scheduled.at(-1).callback;
  await s.clock.advance(FINALIZE); assert.equal(s.game().step, 'selecting'); assert.deepEqual(s.game().slots, slots);
  assert.equal(s.game().used.length, 0); assert.notEqual(s.game().turnId, oldId); assert.equal(s.game().selectorUserId, identity.userId);
  staleClosing(); assert.equal(s.game().step, 'selecting');
  const copy = slots[0]; s.select(copy); const turn = s.game().turnId;
  await s.clock.advance(DURATION); assert.notEqual(s.game().turnId, turn); assert.deepEqual(s.game().slots, slots); assert.deepEqual(s.game().selected, []);
});
test('本文のある下書きだけ追加し、元2枚を関連先にして使用済みにし、空いた枠だけ補充する', async t => {
  const s = setup(t, 13); const other = s.join('other', 'other-client'); s.start();
  const before = s.game(); const selected = s.pair(); const related = selected.map(id => before.copies.find(copy => copy.copyId === id).card.cardId);
  s.write('書きかけの案'); s.write(' \n ', other);
  const draftId = s.game().drafts[0].card.cardId; const end = s.current().timer.endsAt;
  await s.clock.advance(500); s.write('書きかけを残す'); assert.equal(s.current().timer.endsAt, end);
  await s.clock.advance(DURATION - 500 + FINALIZE);
  assert.equal(s.current().cards.length, s.original.cards.length + 1);
  const added = s.current().cards.at(-1); assert.deepEqual(added.cardId, draftId); assert.deepEqual(added.relatedIds, related);
  assert.equal('userId' in added, false); assert.equal('editingUser' in added, false); assert.equal(s.game().selectorUserId, 'other');
  assert.deepEqual(s.current().cards.slice(0, s.original.cards.length), s.original.cards);
  assert.deepEqual(s.game().used, selected); assert.equal(s.game().reserve.length, 1);
  assert.deepEqual(s.game().slots.slice(2), before.slots.slice(2));
  assert.ok(!s.game().slots.some(id => selected.includes(id))); assert.ok(!s.game().reserve.some(id => selected.includes(id)));
  assert.ok(added.position.x >= Math.max(...s.original.cards.map(card => card.position.x + card.shape.width)) + 70);
  await s.clock.advance(30_000); assert.equal(s.generations.length, 0);
});
test('同じ本文のアイデアも全員分残し、実際のカード寸法で重ならず配置する', async t => {
  const s = setup(t); const other = s.join('other', 'other-client'); s.start(); s.pair();
  s.write('同じ案'); s.write('同じ案', other); await s.clock.advance(DURATION + FINALIZE);
  const added = s.current().cards.slice(s.original.cards.length); assert.equal(added.length, 2);
  assert.ok(added[1].position.y >= added[0].position.y + added[0].shape.height + 40);
});
test('未使用2枚未満で自然終了し、コピーを片付け、共有タイマーを5分停止へ戻す', async t => {
  const s = setup(t, 3); s.start(); const gameId = s.game().gameId; s.pair(); s.write('案');
  await s.clock.advance(DURATION + FINALIZE); assert.equal(s.game(), undefined);
  assert.deepEqual(s.current().timer, { state: 'stopped', durationMs: 300_000, remainingMs: 300_000 });
  assert.equal(s.owner.run('matching.abort.request', { gameId }).status, 409);
  assert.equal(s.current().cards.at(-1).text, '案'); assert.ok(validBoard(s.current()));
  await s.clock.advance(30_000); assert.equal(s.generations.length, 0);
  assert.equal(s.owner.run('edit.request', { cardIds: [cid(1)] }).status, 200);
});
test('ゲーム中は通常の変更・生成・読み込み・タイマー操作をサーバーでも拒否する', t => {
  const s = setup(t); s.start(); const saved = s.current();
  for (const [type, fields] of [['edit.request', { cardIds: [cid(1)] }], ['card.create', { card: createEmptyCard('word', { x: 0, y: 0, z: 0 }) }],
    ['objects.delete', { objectIds: [cid(1)] }], ['board.clear', {}], ['board.restore-sample', {}], ['generation.request', { level: 'mid' }],
    ['timer.start', {}], ['timer.stop', {}], ['timer.reset', {}], ['reaction.add', { cardId: cid(100), reactionId: 'heart' }],
    ['board.import', { file: { format: BOARD_FILE_FORMAT, version: 1, cards: [], arrows: [] } }]]) {
    const command = s.owner.sender(type, fields);
    assert.ok(validCommand(command), type); assert.equal(s.service.executeCommand(command).status, 409, type);
  }
  assert.deepEqual(s.current(), saved);
});
test('入力途中の新規参加者は閲覧だけでき、次の入力開始時に配布する', async t => {
  const s = setup(t, 6); s.start(); s.pair(); const other = s.join('late', 'late-client');
  assert.equal(s.game().drafts.length, 1);
  assert.equal(other.run('matching.draft', { gameId: s.game().gameId, turnId: s.game().turnId, writerToken: s.game().drafts[0].writerToken,
    sequence: 1, text: 'forged', final: false }).status, 403);
  s.write('案'); await s.clock.advance(DURATION + FINALIZE); s.pair(other);
  assert.equal(s.game().drafts.length, 2);
});
test('複数タブ・再接続で入力権を移し、旧入力元と逆順・重複した本文を巻き戻さない', t => {
  const s = setup(t); s.start(); s.pair(); s.write('最初の本文'); const old = s.game().drafts[0];
  const newer = s.join(identity.userId, 'new-client'); const current = s.game().drafts[0];
  assert.notEqual(current.writerToken, old.writerToken); assert.equal(current.card.text, old.card.text);
  assert.equal(s.write('古いタブ', s.owner, { writerToken: old.writerToken, sequence: 99 }).status, 403);
  s.write('新しい本文', newer, { sequence: 5 }); s.write('古い順序', newer, { sequence: 2 });
  assert.equal(s.game().drafts[0].card.text, '新しい本文');
  newer.stop(); assert.equal(s.game().drafts[0].writerClientId, identity.clientId);
  assert.equal(s.write('戻ったタブ').status, 200);
});
test('中断確認は全員で共有し、時間は進み、他の1人が続行・終了できる', async t => {
  const s = setup(t); const other = s.join('other', 'other-client'); s.start(); s.pair(); s.write('中断でも残す');
  const gameId = s.game().gameId; s.owner.run('matching.abort.request', { gameId });
  const confirmationId = s.game().abortConfirmationId;
  await s.clock.advance(3000); assert.equal(s.current().timer.endsAt, DURATION);
  assert.equal(other.run('matching.abort.cancel', { gameId, confirmationId }).status, 200);
  assert.equal(s.game().abortConfirmationId, undefined);
  s.owner.run('matching.abort.request', { gameId }); const newConfirmation = s.game().abortConfirmationId;
  assert.equal(other.run('matching.abort.confirm', { gameId, confirmationId }).status, 409);
  const confirm = other.sender('matching.abort.confirm', { gameId, confirmationId: newConfirmation });
  assert.equal(s.service.executeCommand(confirm).status, 200); assert.equal(s.game().step, 'closing');
  s.service.executeCommand(confirm); await s.clock.advance(FINALIZE);
  assert.equal(s.game(), undefined); assert.equal(s.current().cards.length, s.original.cards.length + 1);
  assert.equal(s.current().cards.at(-1).text, '中断でも残す'); assert.equal(s.current().timer.remainingMs, 300_000);
});
test('入力期限と中断が重なっても最終送信だけを受理し、成果物を一度だけ追加する', async t => {
  const s = setup(t, 2); s.start(); s.pair(); s.write('変換途中');
  s.owner.run('matching.abort.request', { gameId: s.game().gameId }); const confirmationId = s.game().abortConfirmationId;
  await s.clock.advance(DURATION);
  assert.equal(s.write('期限後の通常編集').status, 409);
  assert.equal(s.write('日本語の確定本文', s.owner, { final: true }).status, 200);
  assert.equal(s.write('最終送信後の書き換え', s.owner, { final: true }).status, 409);
  s.owner.run('matching.abort.confirm', { gameId: s.game().gameId, confirmationId });
  await s.clock.advance(FINALIZE); assert.equal(s.current().cards.at(-1).text, '日本語の確定本文');
  assert.equal(s.current().cards.length, s.original.cards.length + 1);
  await s.clock.advance(20_000); assert.equal(s.current().cards.length, s.original.cards.length + 1);
});
test('担当者切断で接続者へ交代し、同一ユーザーの別タブがあれば交代しない', t => {
  const s = setup(t); const other = s.join('other', 'other-client'); const anotherTab = s.join(); s.start(); s.select(s.game().slots[0]);
  const old = s.game(); s.owner.stop(); assert.equal(s.game().turnId, old.turnId);
  anotherTab.stop(); assert.equal(s.game().selectorUserId, 'other'); assert.deepEqual(s.game().slots, old.slots); assert.deepEqual(s.game().selected, []);
  other.stop(); assert.equal(s.game(), undefined); assert.equal(s.current().timer.remainingMs, 300_000);
});
test('入力担当切断でも期限まで進み、接続者0人では受理済み本文を保存して終了する', async t => {
  const s = setup(t); const other = s.join('other', 'other-client'); s.start(); s.pair(); s.write('切断前の案');
  s.owner.stop(); assert.equal(s.game().step, 'writing'); assert.equal(s.current().timer.endsAt, DURATION);
  other.stop(); assert.equal(s.game(), undefined); assert.equal(s.current().cards.at(-1).text, '切断前の案');
  s.join(); assert.equal(s.game(), undefined); await s.clock.advance(DURATION + FINALIZE);
  assert.equal(s.current().cards.length, s.original.cards.length + 1); assert.equal(s.current().timer.remainingMs, 300_000);
});
test('開始前の非同期生成と自動生成待機はゲームにカードを追加しない', async t => {
  const job = deferred(); const s = setup(t, 4, { generateSuggestions: () => job.promise });
  s.owner.run('generation.request', { level: 'mid' }); await flush(); s.start(); job.resolve(['stale']); await flush(); await flush();
  assert.deepEqual(s.current().cards, s.original.cards);
  assert.equal(s.service.getBoardSnapshot('board').generation.status, 'discarded');
});
test('ゲーム状態の重複枠・不正参照・作者混入・タイマー不整合を境界で拒否する', t => {
  const s = setup(t); s.start(); s.pair(); assert.ok(validBoard(s.current()));
  for (const change of [value => { value.matching.slots[1] = value.matching.slots[0]; }, value => { value.matching.drafts[0].card.relatedIds = [cid(999)]; },
    value => { value.matching.drafts[0].card.author = 'author'; }, value => { value.timer.durationMs = 300_000; },
    value => { value.matching.selected[0] = 'missing'; }]) {
    const value = structuredClone(s.current()); change(value); assert.equal(validBoard(value), false);
  }
  assert.equal(new Set(s.current().cards.map(card => objectKey(card.cardId))).size, s.current().cards.length);
});
