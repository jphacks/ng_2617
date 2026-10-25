import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoardClient } from './board-client.ts';
import { createHttpBoardTransport } from './http-board-transport.ts';
import { createBoardFile } from './board-file.ts';
import { createBoardService } from '../server/board-service.ts';
import { connectedClient, until } from '../test/transport-harness.mjs';
import { fakeClock, flush } from '../test/fake-clock.mjs';
import { board, word, identity, cid, snapshot } from '../test/board-fixtures.mjs';

const file = () => createBoardFile(board([word(1, { text: '読み込み完了' })], []));

test('HTTP＋SSEで読み込み成功と拒否を確定し、他端末のボードも更新する', async t => {
  const clock = fakeClock(); const service = createBoardService([board()], { now: clock.now, schedule: clock.schedule });
  const a = connectedClient(service, identity).client;
  const b = connectedClient(service, { ...identity, clientId: 'b' }).client;
  t.after(() => { a.disconnect(); b.disconnect(); service.dispose(); });
  a.connect(); b.connect(); await until(() => a.getSnapshot().status === 'ready' && b.getSnapshot().status === 'ready');
  b.requestEdit(cid(1)); await until(() => b.getSnapshot().edit.phase === 'editing');
  a.execute({ type: 'board.import', file: file() });
  await until(() => a.getSnapshot().importState.status === 'rejected');
  assert.equal(a.getSnapshot().board.cards.length, 3);
  b.cancelEdit(); await until(() => b.getSnapshot().edit.phase === 'idle');
  a.execute({ type: 'board.import', file: file() });
  await until(() => a.getSnapshot().importState.status === 'succeeded' && b.getSnapshot().board.cards.length === 1);
  assert.deepEqual(a.getSnapshot().board, b.getSnapshot().board);
  assert.equal(b.getSnapshot().board.cards[0].text, '読み込み完了');
  assert.equal(a.getSnapshot().pendingCommands.length, 0);
});

test('読み込み応答が消えて切断しても要求IDを保持し、再接続時に再確認して二重置換しない', async t => {
  const service = createBoardService([board()]);
  let receive; let disconnect; let stop; let lose = true; const sent = [];
  const client = createBoardClient(identity, {
    subscribe(onEvent, onDisconnect) { receive = onEvent; disconnect = onDisconnect; return () => stop?.(); },
    send(command) {
      sent.push(structuredClone(command));
      if (command.type === 'board.get') {
        stop = service.subscribeBoard(identity, event => {
          if (!(lose && event.type === 'command.accepted' && event.commandType === 'board.import')) receive(event);
        });
      } else {
        const result = service.executeCommand(command);
        if (lose && command.type === 'board.import') throw new Error('応答消失');
        receive(result.body);
      }
    },
  });
  t.after(() => { client.disconnect(); service.dispose(); });
  client.connect(); client.execute({ type: 'board.import', file: file() }); await flush();
  assert.equal(client.getSnapshot().importState.status, 'pending');
  assert.ok(client.getSnapshot().error); assert.equal(service.getBoardSnapshot('board').revision, 1);
  assert.equal(client.execute({ type: 'board.import', file: file() }), false);
  const before = service.getBoardSnapshot('board').board;
  const original = sent.find(command => command.type === 'board.import');
  client.retryPending(); await flush(); assert.equal(service.getBoardSnapshot('board').revision, 1);
  disconnect('切断'); assert.deepEqual(client.getSnapshot().pendingCommands, [original]);
  lose = false; client.connect(); await flush();
  assert.equal(client.getSnapshot().importState.status, 'succeeded');
  assert.equal(client.getSnapshot().pendingCommands.length, 0);
  assert.deepEqual(service.getBoardSnapshot('board').board, before);
  assert.ok(sent.filter(command => command.type === 'board.import').every(command => command.requestId === original.requestId));
});

test('読み込み後のスナップショットで古い取得待ちドラフトを破棄し、遅い許可でも復活させない', t => {
  const service = createBoardService([board()]); let receive; const sent = [];
  const client = createBoardClient(identity, {
    subscribe(onEvent) { receive = onEvent; return () => {}; }, send(command) { sent.push(command); },
  });
  t.after(() => { client.disconnect(); service.dispose(); });
  client.connect(); receive(service.getBoardSnapshot('board'));
  client.requestEdit(cid(1), 'transform'); client.updateDraft({ position: { x: 999, y: 999, z: 1 } });
  const stale = { ...service.getBoardSnapshot('board'), type: 'edit.granted', cardIds: [cid(1)], lockId: 'old',
    clientId: identity.clientId, requestId: sent.at(-1).requestId };
  service.executeCommand({ ...identity, clientId: 'b', requestId: 'import', type: 'board.import', file: file() });
  receive(service.getBoardSnapshot('board')); receive(stale);
  assert.equal(client.getSnapshot().edit.phase, 'idle');
  assert.equal(client.getSnapshot().board.cards[0].text, '読み込み完了');
  assert.equal(client.getSnapshot().pendingCommands.length, 0);
});

test('旧サーバーの明示的な再起動要求は理由を表示して待機を解除し、不明な503では元の要求を保持する', async t => {
  for (const explicit of [true, false]) {
    const message = '開発サーバーを再起動してください。';
    const transport = createHttpBoardTransport(async () => Response.json({
      ...(explicit && { code: 'SERVER_RESTART_REQUIRED' }), error: message,
    }, { status: 503 }), () => {
      const stream = { close() {} };
      queueMicrotask(() => stream.onmessage({ data: JSON.stringify(snapshot()) }));
      return stream;
    });
    const client = createBoardClient(identity, transport); t.after(() => client.disconnect());
    client.connect(); await until(() => client.getSnapshot().status === 'ready');
    const before = client.getSnapshot().board;
    client.execute({ type: 'board.import', file: file() });
    await until(() => !!client.getSnapshot().error);
    assert.equal(client.getSnapshot().status, 'ready');
    assert.deepEqual(client.getSnapshot().board, before);
    assert.ok(client.getSnapshot().error.includes(message));
    assert.equal(client.getSnapshot().importState.status, explicit ? 'rejected' : 'pending');
    assert.equal(client.getSnapshot().pendingCommands.length, explicit ? 0 : 1);
    assert.equal(client.requestEdit(cid(1)), explicit);
    client.disconnect();
  }
});
