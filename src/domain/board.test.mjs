import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addCard,
  createBoard,
  getCard,
  removeCard,
  replaceCard,
} from './board.ts';

const card = Object.freeze({
  cardId: 'card-1',
  shape: 'rectangle',
  position: Object.freeze({ x: 10, y: 20, z: 0 }),
  color: '#ffffff',
  text: 'カフェ',
  font: 'sans-serif',
  editingUser: Object.freeze({ userId: 'user-1' }),
});

test('編集確定とロック解除を置換で反映し、以前の状態は保持する', () => {
  const original = Object.freeze(createBoard('board-1'));
  const editing = addCard(original, card);
  Object.freeze(editing.cards);
  Object.freeze(editing);
  const content = { ...card };
  delete content.editingUser;
  const committed = replaceCard(editing, { ...content, text: '新しいカフェ' });

  assert.equal(original.cards.length, 0);
  assert.equal(getCard(editing, card.cardId).text, 'カフェ');
  assert.equal(getCard(editing, card.cardId).editingUser.userId, 'user-1');
  assert.equal(getCard(committed, card.cardId).text, '新しいカフェ');
  assert.equal(getCard(committed, card.cardId).editingUser, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(committed)), committed);
  assert.equal(removeCard(committed, card.cardId).cards.length, 0);
  assert.equal(committed.cards.length, 1);
});

test('IDの重複や対象の取り違えを検出する', () => {
  const board = addCard(createBoard('board-1'), card);
  assert.throws(() => addCard(board, card), /already exists/);
  assert.throws(
    () => replaceCard(board, { ...card, cardId: 'missing' }),
    /not found/,
  );
  assert.throws(() => removeCard(board, 'missing'), /not found/);
  assert.equal(getCard(board, 'missing'), undefined);
});
