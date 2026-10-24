import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoardService } from './board-service.ts';

const card = { cardId: 'card', shape: 'rectangle', position: { x: 0, y: 0, z: 0 }, color: '#fff', text: 'original', font: 'sans-serif' };
const board = { boardId: 'board', cards: [card] };
const command = { type: 'edit.request', boardId: 'board', cardId: 'card', userId: 'user', clientId: 'client', requestId: 'request-1' };
const content = structuredClone(card);
delete content.cardId;
const commit = { ...command, type: 'edit.commit', requestId: 'request-2', lockId: 'lock', content: { ...content, text: 'changed' } };
function setup(options = {}) { return createBoardService([board], { createLockId: () => 'lock', ...options }); }

test('許可・確定・ロック解除を行い、GET相当の取得に変更が残る', () => {
  const service = setup();
  const granted = service.requestEdit(command);
  assert.equal(granted.body.type, 'edit.granted');
  assert.equal(granted.body.revision, 1);
  assert.equal(service.getBoardSnapshot('board').board.cards[0].text, 'original');
  const saved = service.commitEdit(commit);
  assert.equal(saved.body.type, 'edit.committed');
  assert.equal(saved.body.revision, 2);
  assert.equal(saved.body.board.cards[0].editingUser, undefined);
  assert.equal(service.getBoardSnapshot('board').board.cards[0].text, 'changed');
  saved.body.board.cards[0].text = 'outside';
  commit.content.position.x = 999;
  assert.equal(service.getBoardSnapshot('board').board.cards[0].text, 'changed');
  assert.equal(service.getBoardSnapshot('board').board.cards[0].position.x, 0);
  commit.content.position.x = 0;
  assert.equal(service.commitEdit(commit).status, 403);
  assert.equal(service.getBoardSnapshot('board').revision, 2);
});

test('同じユーザーの別端末も競合し、編集権を奪えない', () => {
  const service = setup();
  service.requestEdit(command);
  assert.equal(service.requestEdit({ ...command, clientId: 'other' }).status, 409);
  for (const mismatch of [{ clientId: 'other' }, { userId: 'other' }, { lockId: 'wrong' }]) {
    assert.equal(service.commitEdit({ ...commit, ...mismatch }).status, 403);
    assert.equal(service.cancelEdit({ ...command, type: 'edit.cancel', lockId: 'lock', ...mismatch }).status, 403);
  }
  assert.equal(service.getBoardSnapshot('board').revision, 1);
  assert.equal(service.commitEdit(commit).status, 200);
});

test('取消は内容を変更せずロックを解除する', () => {
  const service = setup();
  service.requestEdit(command);
  const cancelled = service.cancelEdit({ ...command, type: 'edit.cancel', lockId: 'lock' });
  assert.equal(cancelled.body.type, 'edit.cancelled');
  assert.deepEqual(cancelled.body.board, board);
  assert.equal(cancelled.body.revision, 2);
  assert.equal(service.requestEdit({ ...command, clientId: 'other' }).status, 200);
});

test('期限切れの編集権では確定できず、別の端末が取得し直せる', () => {
  let time = 0;
  const service = setup({ now: () => time, lockTtlMs: 100 });
  service.requestEdit(command);
  time = 100;
  assert.equal(service.commitEdit(commit).status, 403);
  assert.deepEqual(service.getBoardSnapshot('board').board, board);
  assert.equal(service.getBoardSnapshot('board').revision, 2);
  assert.equal(service.requestEdit({ ...command, clientId: 'other' }).status, 200);
});

test('不正な更新・ID変更・NaNを拒否し、データと編集権を維持する', () => {
  const service = setup();
  service.requestEdit(command);
  for (const input of [
    null, {}, { ...command, userId: '' },
    { ...commit, content: { ...content, cardId: 'changed' } },
    { ...commit, content: { ...content, editingUser: { userId: 'other' } } },
    { ...commit, content: { ...content, position: { x: NaN, y: 0, z: 0 } } },
    { ...commit, content: { text: 'missing fields' } },
  ]) assert.equal(service.executeEdit(input).status, 400);
  assert.equal(service.executeEdit(commit, 'different-board').status, 400);
  assert.equal(service.getBoardSnapshot('board').revision, 1);
  assert.equal(service.commitEdit(commit).status, 200);
});

test('存在しないボードとカードを区別して404を返す', () => {
  const service = setup();
  assert.equal(service.executeEdit({ ...command, boardId: 'missing' }).status, 404);
  const missing = service.executeEdit({ ...command, cardId: 'missing' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.type, 'edit.rejected');
  assert.equal(service.getBoardSnapshot('board').revision, 0);
});

test('別ボードの編集権・更新内容は混ざらない', () => {
  const service = createBoardService([board, { ...board, boardId: 'other' }]);
  const granted = service.requestEdit(command);
  assert.equal(service.commitEdit({ ...commit, boardId: 'other', lockId: granted.body.lockId }).status, 403);
  assert.equal(service.getBoardSnapshot('other').revision, 0);
});
