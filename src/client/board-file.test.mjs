import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoardFile, parseBoardFile, readBoardFile } from './board-file.ts';
import { validBoardFile, validCommand } from '../domain/board-validation.ts';
import { MAX_BOARD_FILE_BYTES, MAX_BOARD_FILE_CARDS } from '../domain/board-file.ts';
import { board, arrow, block, word, cid, commands } from '../test/board-fixtures.mjs';

test('JSON保存は全属性と参照を往復し、編集ロック・タイマーを除外し、元データを変更しない', () => {
  const before = board([word(1, { editingUser: { userId: 'editor' }, text: '日本語\n<&>' }), word(2),
    block(3, { reactions: [{ reactionId: 'heart', userId: 'a' }] })], [arrow()]);
  const copy = structuredClone(before);
  const file = createBoardFile(before);
  assert.equal(validBoardFile(file), true);
  assert.deepEqual(parseBoardFile(JSON.stringify(file)), file);
  assert.equal('timer' in file, false);
  assert.equal(file.cards.some(card => 'editingUser' in card), false);
  assert.deepEqual(file.cards[2].relatedIds, [cid(1)]);
  assert.deepEqual(file.arrows, before.arrows);
  file.cards[0].position.x = 2000;
  assert.deepEqual(before, copy);
});

test('ファイルとサーバー入口は形式・バージョン・重複ID・参照・座標・属性混入を同じルールで拒否する', () => {
  const file = createBoardFile(board(undefined, [arrow()]));
  const invalid = [
    { ...file, format: 'unknown' }, { ...file, version: 2 }, { ...file, timer: board().timer },
    { ...file, cards: [...file.cards, file.cards[0]] }, { ...file, arrows: [...file.arrows, file.arrows[0]] },
    { ...file, cards: file.cards.slice(1) },
    { ...file, cards: [word(1, { position: { x: 1e308, y: 0, z: 0 } })], arrows: [] },
    { ...file, cards: [word(1, { editingUser: { userId: 'a' } })], arrows: [] },
    { ...file, cards: [word(1, { shape: { width: 1, height: 1 } })], arrows: [] },
    { ...file, cards: [block(3, { relatedIds: [cid(99)] })], arrows: [] },
    { ...file, cards: [word(1, { cardId: { type: 'card', uuid: 'invalid' } })], arrows: [] },
  ];
  const command = commands();
  for (const value of invalid) {
    assert.throws(() => parseBoardFile(JSON.stringify(value)));
    assert.equal(validCommand(command('board.import', { file: value })), false);
  }
  assert.throws(() => parseBoardFile('{'), /JSON/);
  assert.equal(validBoardFile({ ...file, cards: Array(MAX_BOARD_FILE_CARDS + 1).fill(word()) }), false);
});

test('バイト数上限を読む前と解析時に確認し、読取失敗を説明する', async () => {
  let read = false;
  await assert.rejects(() => readBoardFile({ size: MAX_BOARD_FILE_BYTES + 1, text: () => { read = true; } }), /5 MiB/);
  assert.equal(read, false);
  assert.throws(() => parseBoardFile('あ'.repeat(Math.ceil(MAX_BOARD_FILE_BYTES / 3))), /5 MiB/);
  await assert.rejects(() => readBoardFile({ size: 1, text: async () => { throw new Error('denied'); } }), /読み込めません/);
  assert.throws(() => createBoardFile(board(Array.from({ length: 53 }, (_, i) => word(i + 1, { text: 'a'.repeat(100_000) })))), /最大5 MiB/);
});
