import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoardService } from './board-service.ts';
import { getCard, objectKey, createEmptyCard } from '../domain/board.ts';
import { aid, arrow, board, cid, commands, identity } from '../test/board-fixtures.mjs';

function setup(t, initial = board()) {
  const updates = []; const events = [];
  const service = createBoardService([initial, { ...initial, boardId: 'other' }], { onBoardUpdated: update => updates.push(update) });
  t.after(() => service.dispose());
  service.subscribeBoard(identity, event => events.push(event));
  const command = commands();
  const run = (type, fields) => service.executeCommand(command(type, fields));
  const current = () => service.getBoardSnapshot('board');
  return { service, command, run, current, updates, events };
}

test('複数カードを1つのlockIdで一括取得・確定し、更新・配信は操作ごとに1回', t => {
  const s = setup(t);
  const grant = s.run('edit.request', { cardIds: [cid(1), cid(2)] }).body;
  assert.equal(grant.type, 'edit.granted'); assert.equal(grant.revision, 1);
  assert.deepEqual(grant.cardIds, [cid(1), cid(2)]);
  assert.ok(getCard(s.current().board, cid(1)).editingUser);
  assert.equal(s.run('edit.request', { clientId: 'other', cardIds: [cid(2), cid(3)] }).status, 409);
  assert.equal(getCard(s.current().board, cid(3)).editingUser, undefined);
  const commit = s.command('edit.commit', { lockId: grant.lockId, changes: [
    { cardId: cid(1), patch: { position: { x: 1, y: 2, z: 3 } } }, { cardId: cid(2), patch: { text: 'changed' } },
  ] });
  const saved = s.service.executeCommand(commit);
  assert.equal(saved.body.revision, 2); assert.equal(saved.body.type, 'edit.committed');
  assert.equal(getCard(s.current().board, cid(1)).text, 'word-1');
  assert.equal(getCard(s.current().board, cid(2)).text, 'changed');
  assert.equal(s.current().board.cards.some(card => card.editingUser), false);
  assert.deepEqual(s.updates.map(u => u.objectIds.length), [2, 2]);
  assert.equal(s.events.length, 3);
  saved.body.board.cards[0].text = 'external'; commit.changes[0].patch.position.x = 999;
  assert.equal(getCard(s.current().board, cid(1)).position.x, 1);
});
test('一部だけの保存・不正寸法・別端末・別ユーザーは全体拒否し、ロックを維持する', t => {
  const s = setup(t); const grant = s.run('edit.request', { cardIds: [cid(1), cid(3)] }).body;
  for (const changes of [[{ cardId: cid(1), patch: { text: 'partial' } }], [
    { cardId: cid(1), patch: { text: 'partial' } }, { cardId: cid(3), patch: { shape: { width: 200, height: 200 } } },
  ]]) assert.equal(s.run('edit.commit', { lockId: grant.lockId, changes }).status, 400);
  for (const extra of [{ clientId: 'other' }, { userId: 'other' }, { lockId: 'wrong' }, { boardId: 'other' }]) {
    assert.equal(s.run('edit.cancel', { lockId: grant.lockId, ...extra }).status, 403);
  }
  assert.equal(s.current().revision, 1); assert.equal(getCard(s.current().board, cid(1)).text, 'word-1');
  assert.equal(s.run('edit.cancel', { lockId: grant.lockId }).status, 200);
  assert.equal(s.current().revision, 2);
});
test('空カード作成はロックを付けず、取消でもカードは残る', t => {
  const s = setup(t);
  for (const kind of ['word', 'block']) {
    const card = createEmptyCard(kind, { x: 0, y: 0, z: 0 });
    assert.equal(s.run('card.create', { card }).status, 200);
    assert.equal(getCard(s.current().board, card.cardId).editingUser, undefined);
    assert.equal(s.run('card.create', { card }).status, 409);
    const grant = s.run('edit.request', { cardIds: [card.cardId] }).body;
    s.run('edit.cancel', { lockId: grant.lockId });
    assert.ok(getCard(s.current().board, card.cardId));
  }
});
test('リアクションはユーザー・種類ごとに一件で、本文編集中も最新値を保持する', t => {
  const s = setup(t); const grant = s.run('edit.request', { cardIds: [cid(3)] }).body;
  const add = { cardId: cid(3), reactionId: 'heart' };
  s.run('reaction.add', add); s.run('reaction.add', { ...add, userId: 'other' });
  const revision = s.current().revision;
  assert.equal(s.run('reaction.add', add).body.changed, false); assert.equal(s.current().revision, revision);
  s.run('edit.commit', { lockId: grant.lockId, changes: [{ cardId: cid(3), patch: { text: 'summary' } }] });
  assert.equal(getCard(s.current().board, cid(3)).reactions.length, 2);
  s.run('reaction.remove', add);
  assert.deepEqual(getCard(s.current().board, cid(3)).reactions, [{ reactionId: 'heart', userId: 'other' }]);
  const unchanged = s.current().revision; s.run('reaction.remove', add); assert.equal(s.current().revision, unchanged);
  assert.equal(s.run('reaction.add', { ...add, cardId: cid(1) }).status, 400);
  assert.equal(s.run('reaction.add', { ...add, reactionId: 'unknown' }).status, 400);
});
test('矢印は独立に作成・削除し、重複・自己接続を拒否し、逆向き・別Anchor・循環を許可する', t => {
  const s = setup(t); s.run('edit.request', { cardIds: [cid(1)] });
  assert.equal(s.run('arrow.create', { arrow: arrow() }).body.changed, true);
  const revision = s.current().revision;
  assert.equal(s.run('arrow.create', { arrow: arrow() }).body.changed, false);
  assert.equal(s.run('arrow.create', { arrow: arrow(2) }).status, 409);
  assert.equal(s.run('arrow.create', { arrow: arrow(1, { sourceAnchor: 'north' }) }).status, 409);
  assert.equal(s.run('arrow.create', { arrow: arrow(2, { sourceAnchor: 'north' }) }).status, 200);
  assert.equal(s.run('arrow.create', { arrow: arrow(3, { sourceCardId: cid(2), targetCardId: cid(1) }) }).status, 200);
  assert.equal(s.run('arrow.create', { arrow: arrow(4, { targetCardId: cid(1) }) }).status, 400);
  assert.equal(s.run('arrow.create', { arrow: arrow(4, { targetCardId: cid(99) }) }).status, 404);
  assert.equal(s.current().revision, revision + 2);
  s.run('arrow.delete', { arrowId: aid(2) }); const after = s.current().revision;
  s.run('arrow.delete', { arrowId: aid(2) }); assert.equal(s.current().revision, after);
});
test('削除対象にロックがあれば全拒否し、許可時は本体・参照・矢印を一括除去する', t => {
  const s = setup(t, board(undefined, [arrow()]));
  const locked = s.run('edit.request', { cardIds: [cid(2)] }).body;
  assert.equal(s.run('objects.delete', { objectIds: [cid(1), cid(2), aid(1)] }).status, 409);
  assert.equal(s.current().board.cards.length, 3); assert.equal(s.current().board.arrows.length, 1);
  assert.equal(s.run('board.clear').status, 409); assert.equal(s.run('board.restore-sample').status, 409);
  s.run('edit.cancel', { lockId: locked.lockId });
  const owner = s.run('edit.request', { cardIds: [cid(3)] }).body;
  const revision = s.current().revision;
  s.run('objects.delete', { objectIds: [cid(1)] });
  assert.equal(s.current().revision, revision + 1);
  assert.deepEqual(new Set(s.updates.at(-1).objectIds.map(objectKey)), new Set([cid(1), cid(3), aid(1)].map(objectKey)));
  assert.deepEqual(getCard(s.current().board, cid(3)).relatedIds, []);
  s.run('edit.commit', { lockId: owner.lockId, changes: [{ cardId: cid(3), patch: { relatedIds: [cid(1)], text: 'latest' } }] });
  assert.deepEqual(getCard(s.current().board, cid(3)).relatedIds, []);
  assert.equal(getCard(s.current().board, cid(3)).text, 'latest');
  s.run('objects.delete', { objectIds: [cid(3)] }); assert.ok(getCard(s.current().board, cid(2)));
});
test('同ID・同内容の再送は結果を再利用し、異内容はログと409、JSONキー順は無視する', t => {
  const s = setup(t); const request = s.command('edit.request', { cardIds: [cid(1), cid(2)] });
  const first = s.service.executeCommand(request);
  const duplicate = s.service.executeCommand({ ...Object.fromEntries(Object.entries(request).reverse()), cardIds: [...request.cardIds].reverse() });
  assert.deepEqual(duplicate, first); assert.equal(s.updates.length, 1);
  const logs = []; const original = console.error; console.error = (...args) => logs.push(args);
  try {
    assert.equal(s.service.executeCommand({ ...request, cardIds: [cid(2)] }).status, 409);
    assert.equal(s.service.executeCommand({ ...identity, requestId: request.requestId, type: 'board.get' }).status, 409);
  } finally { console.error = original; }
  assert.equal(logs[0][1].requestId, request.requestId); assert.equal(s.current().revision, 1);
  const cancel = s.command('edit.cancel', { lockId: first.body.lockId });
  const result = s.service.executeCommand(cancel); assert.deepEqual(s.service.executeCommand(cancel), result);
  assert.equal(s.current().revision, 2);
  assert.deepEqual(s.service.executeCommand(request), first);
  assert.equal(s.current().board.cards.some(card => card.editingUser), false);
});
test('全消去・存在しない対象は変更なしを識別し、サンプル復元は共有タイマーを維持する', t => {
  const s = setup(t); s.run('timer.start'); const timer = s.current().board.timer;
  s.run('board.restore-sample'); assert.deepEqual(s.current().board.timer, timer);
  const ids = s.current().board.cards.map(c => c.cardId); s.run('board.restore-sample');
  assert.equal(s.current().board.cards.some(card => ids.some(id => objectKey(id) === objectKey(card.cardId))), false);
  s.run('board.clear'); const revision = s.current().revision;
  s.run('board.clear'); s.run('objects.delete', { objectIds: [cid(99), aid(99)] });
  assert.equal(s.current().revision, revision); assert.equal(s.current().board.cards.length, 0);
});
test('境界の不正要求と未知ボードを拒否し、内部入口も同じルールを適用する', t => {
  const s = setup(t);
  assert.equal(s.service.executeCommand(null).status, 400);
  assert.equal(s.service.executeCommand(s.command('edit.request', { cardIds: [cid(1)] }), 'other').status, 400);
  assert.equal(s.run('edit.request', { boardId: 'missing', cardIds: [cid(1)] }).status, 404);
  assert.equal(s.run('edit.request', { cardIds: [cid(99)] }).status, 404);
  assert.equal(s.service.ensureBoard('new-room'), true); assert.equal(s.service.getBoardSnapshot('new-room').board.cards.length, 0);
  assert.equal(s.service.ensureBoard(''), false); assert.equal(s.current().revision, 0);
});
