import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpBoardTransport } from './http-board-transport.ts';
import { createBoardClient } from './board-client.ts';

const snapshot = {
  type: 'board.snapshot', revision: 0,
  board: { boardId: 'demo', cards: [{
    cardId: '1', shape: 'rectangle', position: { x: 0, y: 0, z: 0 },
    text: 'サーバーのカード', color: '#fff', font: 'sans-serif',
  }] },
};
const command = {
  type: 'board.get', boardId: 'demo', userId: 'user', clientId: 'client', requestId: 'request',
};

test('HTTP応答を既存クライアントの状態に反映する', async () => {
  const transport = createHttpBoardTransport(async (url, options) => {
    assert.equal(url, '/api/boards/demo');
    assert.equal(options.cache, 'no-store');
    return Response.json(snapshot);
  });
  const client = createBoardClient(command, transport, () => 'request');
  const ready = new Promise((resolve) => {
    client.subscribe(() => { if (client.getSnapshot().status === 'ready') resolve(); });
  });
  client.connect();
  await ready;
  assert.deepEqual(client.getSnapshot().board, snapshot.board);
  client.disconnect();
});

test('404・不正なJSON・別ボード・重複カードを状態管理に渡さない', async () => {
  for (const response of [
    new Response('', { status: 404 }),
    new Response('invalid json'),
    Response.json({ ...snapshot, board: { ...snapshot.board, boardId: 'other' } }),
    Response.json({ ...snapshot, board: { ...snapshot.board, cards: [snapshot.board.cards[0], snapshot.board.cards[0]] } }),
    Response.json({ ...snapshot, revision: -1 }),
  ]) {
    const errors = [];
    const transport = createHttpBoardTransport(async () => response);
    const stop = transport.subscribe(() => assert.fail('不正な応答を受信した'), reason => errors.push(reason));
    await transport.send(command);
    assert.equal(errors.length, 1);
    stop();
  }
});

test('購読解除で送信を中断し、古い応答を次の購読者へ渡さない', async () => {
  let finish;
  let signal;
  const transport = createHttpBoardTransport((_url, options) => {
    signal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  const stop = transport.subscribe(() => assert.fail('古い受信'), () => assert.fail('古いエラー'));
  const sending = transport.send(command);
  stop();
  assert.equal(signal.aborted, true);
  const stopNew = transport.subscribe(() => assert.fail('新しい購読への混入'), () => assert.fail('エラー'));
  finish(Response.json(snapshot));
  await sending;
  stopNew();
});

test('未実装の編集要求をネットワークへ送らない', async () => {
  const transport = createHttpBoardTransport(() => assert.fail('未対応の送信'));
  const errors = [];
  const stop = transport.subscribe(() => assert.fail(), reason => errors.push(reason));
  await transport.send({ ...command, type: 'edit.request', cardId: '1' });
  assert.match(errors[0], /取得だけ/);
  stop();
});
