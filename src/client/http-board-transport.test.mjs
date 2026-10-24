import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpBoardTransport } from './http-board-transport.ts';
import { createBoardClient } from './board-client.ts';
import { createBoardService } from '../server/board-service.ts';

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

test('POSTで編集許可・競合拒否・確定・取消を既存クライアントへ届ける', async () => {
  const service = createBoardService([snapshot.board]);
  const transport = createHttpBoardTransport(async (_url, options) => {
    if (options.method === 'GET') return Response.json(service.getBoardSnapshot('demo'));
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    const result = service.executeEdit(JSON.parse(options.body), 'demo');
    return Response.json(result.body, { status: result.status });
  });
  const client = createBoardClient(command, transport);
  const until = predicate => new Promise(resolve => {
    const stop = client.subscribe(() => {
      if (predicate(client.getSnapshot())) { stop(); resolve(); }
    });
  });
  let changed = until(state => state.status === 'ready');
  client.connect();
  await changed;
  // 読み込み後に別端末がロックを取る競合を再現する。
  const other = service.requestEdit({ ...command, type: 'edit.request', clientId: 'other', cardId: '1' });
  changed = until(state => state.error !== null);
  client.requestEdit('1');
  await changed;
  assert.equal(client.getSnapshot().status, 'ready');
  assert.equal(client.getSnapshot().edit.phase, 'idle');
  service.cancelEdit({ ...command, type: 'edit.cancel', clientId: 'other', cardId: '1', lockId: other.body.lockId });
  client.disconnect();
  changed = until(state => state.status === 'ready');
  client.connect();
  await changed;
  changed = until(state => state.edit.phase === 'editing');
  client.requestEdit('1');
  await changed;
  client.updateDraft({ text: 'HTTPで更新' });
  changed = until(state => state.edit.phase === 'idle');
  client.commitEdit();
  await changed;
  assert.equal(service.getBoardSnapshot('demo').board.cards[0].text, 'HTTPで更新');
  assert.equal(client.getSnapshot().board.cards[0].text, 'HTTPで更新');
  changed = until(state => state.edit.phase === 'editing');
  client.requestEdit('1');
  await changed;
  client.updateDraft({ text: '破棄する変更' });
  changed = until(state => state.edit.phase === 'idle');
  client.cancelEdit();
  await changed;
  assert.equal(client.getSnapshot().board.cards[0].text, 'HTTPで更新');
  client.disconnect();
});
