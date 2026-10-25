import assert from 'node:assert/strict';
import test from 'node:test';
import { addCard, createBoard, createSample, getCard, isEmpty, objectKey, removeCard, replaceCard, sameObjectId } from './board.ts';
import { validBoard, validCard, validCommand, validEvent } from './board-validation.ts';
import { canonical, cardContent, contentPatch } from './board-protocol.ts';
import { aid, arrow, block, board, cid, commands, snapshot, word } from '../test/board-fixtures.mjs';

function freeze(value) { Object.values(value).forEach(item => { if (item && typeof item === 'object') freeze(item); }); return Object.freeze(value); }

test('IDは種別とUUIDで比較し、JSONコピー後も一致する', () => {
  assert.equal(sameObjectId(cid(1), structuredClone(cid(1))), true);
  assert.equal(sameObjectId(cid(1), aid(1)), false);
  assert.notEqual(objectKey(cid(1)), objectKey(aid(1)));
});
test('モデル更新は以前の状態を保持し、削除時は参照と矢印も除去する', () => {
  const before = freeze(board(undefined, [arrow()]));
  const saved = replaceCard(before, { ...word(), text: 'changed' });
  assert.equal(getCard(before, cid(1)).text, 'word-1');
  assert.equal(getCard(saved, structuredClone(cid(1))).text, 'changed');
  const removed = removeCard(saved, cid(1));
  assert.equal(removed.cards.length, 2); assert.equal(removed.arrows.length, 0);
  assert.deepEqual(getCard(removed, cid(3)).relatedIds, []);
  assert.equal(before.cards.length, 3);
  assert.throws(() => addCard(before, word()), /already exists/);
  assert.throws(() => replaceCard(before, word(99)), /not found/);
  assert.throws(() => removeCard(before, cid(99)), /not found/);
  assert.equal(addCard(createBoard('board'), word()).cards.length, 1);
});
test('空判定はカード枚数でなく本文を使う', () => {
  assert.equal(isEmpty(board([word(1, { text: ' \n\t ' }), block(3, { text: '　', relatedIds: [] })])), true);
  assert.equal(isEmpty(board([block(3, { relatedIds: [], text: 'idea' })])), false);
});
test('サンプルは毎回新しいIDを使い、参照と接続の整合性を保つ', () => {
  const a = createSample('sample'); const b = createSample('sample');
  assert.equal(validBoard(a), true); assert.equal(validBoard(b), true);
  assert.equal(a.cards.some(card => b.cards.some(other => sameObjectId(card.cardId, other.cardId))), false);
});
test('ユニオン・寸法・構造化ID・リアクション・参照・矢印を実行時検証する', () => {
  assert.equal(validBoard(board(undefined, [arrow()])), true);
  for (const invalid of [
    word(1, { cardId: 'card-1' }), word(1, { shape: 'rectangle' }), word(1, { cardId: { ...cid(1), uuid: 'bad' } }),
    word(1, { relatedIds: [] }), word(1, { shape: { width: 1, height: 210 } }), word(1, { position: { x: NaN, y: 0, z: 0 } }),
    block(3, { relatedIds: [cid(3)] }), block(3, { relatedIds: [cid(1), cid(1)] }),
    block(3, { reactions: [{ reactionId: 'unknown', userId: 'a' }] }),
    block(3, { reactions: [{ reactionId: 'heart', userId: 'a' }, { reactionId: 'heart', userId: 'a' }] }),
  ]) assert.equal(validCard(invalid), false);
  for (const invalid of [board([word(), word()]), board([word(), block(3, { relatedIds: [cid(99)] })]),
    board(undefined, [arrow(), arrow(2)]), board(undefined, [arrow(1, { targetCardId: cid(99) })]),
    { ...board(), timer: { state: 'stopped', remainingMs: -1, durationMs: 300000 } }]) assert.equal(validBoard(invalid), false);
  assert.equal(validBoard(board([block(1, { relatedIds: [cid(2)] }), block(2, { relatedIds: [cid(1)] })])), true);
});
test('編集内容にはリアクションを含めず、変更属性だけを送信する', () => {
  const base = cardContent(block()); const draft = { ...base, position: { ...base.position, x: 99 } };
  assert.equal('reactions' in base, false);
  assert.deepEqual(contentPatch(base, draft), { position: draft.position });
  assert.equal(canonical({ x: 1, y: 2 }), canonical({ y: 2, x: 1 }));
});
test('旧通信・余分な属性・種類変更を拒否し、生成イベントのIDを検証する', () => {
  const command = commands();
  assert.equal(validCommand(command('edit.request', { cardIds: [cid(1), cid(2)] })), true);
  for (const invalid of [command('edit.request', { cardId: '1' }),
    command('edit.commit', { lockId: 'lock', changes: [{ cardId: cid(1), patch: { cardKind: 'block' } }] }),
    command('reaction.add', { cardId: cid(3), reactionId: 'heart', targetUserId: 'other' }),
    command('card.create', { card: word() })]) assert.equal(validCommand(invalid), false);
  assert.equal(validEvent(snapshot()), true);
  assert.equal(validEvent(snapshot(board(), 0, { type: 'board.cards-generated', eventId: 'event', generationId: 'generation', generatedCardIds: [cid(99)] })), false);
});
