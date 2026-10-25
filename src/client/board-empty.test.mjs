import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoardFile, parseBoardFile } from './board-file.ts';
import { createBoardSvg } from './board-svg.ts';
import { createBoardService } from '../server/board-service.ts';
import { connectedClient, until } from '../test/transport-harness.mjs';
import { fakeClock } from '../test/fake-clock.mjs';
import { board, word, block, arrow, commands, identity } from '../test/board-fixtures.mjs';

const emptyCards = [
  ['カード0枚', []],
  ['本文が空の付箋', [word(1, { text: '' })]],
  ['空白・改行のみの付箋', [word(1, { text: ' \t\n　' })]],
  ['概要・関連先・リアクションが空の関連カード', [block(3, { text: '', relatedIds: [], reactions: [] })]],
  ['空の付箋を参照する関連カード', [word(1, { text: '' }), block(3, { text: '', reactions: [] })]],
  ['本文ありと空の付箋が混在', [word(1, { text: '' }), word(2, { text: '本文あり' })]],
];

test('各種の空ボード・空付箋はJSON保存・解析・サーバー復元・SVG出力を往復できる', async t => {
  for (const [label, cards] of emptyCards) {
    const clock = fakeClock(); let generations = 0;
    const service = createBoardService([board()], { now: clock.now, schedule: clock.schedule,
      generateSuggestions: async () => { generations++; return ['不要な生成']; } });
    t.after(() => service.dispose());
    const file = createBoardFile(board(cards, []));
    assert.deepEqual(parseBoardFile(JSON.stringify(file)), file, label);
    assert.ok(createBoardSvg(board(cards, [])).includes('<svg'), label);
    const result = service.executeCommand(commands()('board.import', { file }));
    assert.equal(result.status, 200, label);
    const restored = service.getBoardSnapshot('board').board;
    assert.deepEqual(restored.cards.map(card => card.text), cards.map(card => card.text), label);
    assert.equal(restored.arrows.length, 0, label);
    await clock.advance(60_000);
    assert.equal(generations, 0, label);
  }
});

test('空のルームへの読み込みと、空ボードへの置き換えをHTTP＋SSEで同期できる', async t => {
  const clock = fakeClock();
  const service = createBoardService([board([], [])], { now: clock.now, schedule: clock.schedule });
  const a = connectedClient(service, identity).client;
  const b = connectedClient(service, { ...identity, clientId: 'b' }).client;
  t.after(() => { a.disconnect(); b.disconnect(); service.dispose(); });
  a.connect(); b.connect(); await until(() => a.getSnapshot().status === 'ready' && b.getSnapshot().status === 'ready');
  for (const [, cards] of [...emptyCards.slice(1), emptyCards[0]]) {
    assert.equal(a.execute({ type: 'board.import', file: createBoardFile(board(cards, [])) }), true);
    await until(() => a.getSnapshot().importState.status === 'succeeded');
    await until(() => b.getSnapshot().revision === a.getSnapshot().revision);
    assert.equal(a.getSnapshot().board.cards.length, cards.length);
    assert.deepEqual(a.getSnapshot().board, b.getSnapshot().board);
    assert.equal(a.getSnapshot().pendingCommands.length, 0);
  }
});

test('ファイル自体の空・欠けた構造・null属性はボードを変更せず拒否する', t => {
  const clock = fakeClock();
  const service = createBoardService([board()], { now: clock.now, schedule: clock.schedule }); t.after(() => service.dispose());
  const before = service.getBoardSnapshot('board');
  const file = createBoardFile(board([word(1, { text: '' })], []));
  for (const text of ['', ' \n\t　', '{}', 'null', '[]', '""']) assert.throws(() => parseBoardFile(text), undefined, text);
  const invalid = [
    { ...file, cards: null }, { ...file, arrows: null },
    { ...file, cards: undefined }, { ...file, arrows: undefined },
    { ...file, cards: [null] }, { ...file, cards: [{}] },
    { ...file, cards: [word(1, { text: null })] },
    { ...file, cards: [word(1, { text: undefined })] },
    { ...file, cards: [word(1, { color: '' })] },
    { ...file, cards: [], arrows: [arrow()] },
    { ...file, cards: [block(3, { text: '', relatedIds: [], reactions: null })] },
  ];
  const command = commands();
  for (const value of invalid) {
    assert.throws(() => parseBoardFile(JSON.stringify(value)));
    assert.equal(service.executeCommand(command('board.import', { file: value })).status, 400);
    assert.deepEqual(service.getBoardSnapshot('board'), before);
  }
});

test('空付箋でも読み込み先の編集ロックは拒否するが、保存元のロックはファイルに含めない', t => {
  const clock = fakeClock();
  const service = createBoardService([board([word(1, { text: '' })], [])], { now: clock.now, schedule: clock.schedule }); t.after(() => service.dispose());
  const command = commands();
  const file = createBoardFile(board([word(1, { text: '', editingUser: { userId: 'old-editor' } })], []));
  assert.equal('editingUser' in file.cards[0], false);
  const lock = service.executeCommand(command('edit.request', { cardIds: [word().cardId] })).body;
  const before = service.getBoardSnapshot('board');
  assert.equal(service.executeCommand(command('board.import', { file })).status, 409);
  assert.deepEqual(service.getBoardSnapshot('board'), before);
  service.executeCommand(command('edit.cancel', { lockId: lock.lockId }));
  assert.equal(service.executeCommand(command('board.import', { file })).status, 200);
});
