import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpBoardTransport } from './http-board-transport.ts';
import { board, cid, commands, identity, snapshot } from '../test/board-fixtures.mjs';
import { createBoardService } from '../server/board-service.ts';
import { connectedClient, until } from '../test/transport-harness.mjs';

function setup(t, fetcher = async () => Response.json(snapshot())) {
  const streams = []; const events = []; const errors = [];
  const transport = createHttpBoardTransport(fetcher, url => {
    assert.equal(url, '/api/boards/board/events?userId=user&clientId=client');
    const stream = { closed: false, close() { this.closed = true; } }; streams.push(stream); return stream;
  });
  const stop = transport.subscribe(event => events.push(event), error => errors.push(error)); t.after(stop);
  const command = commands(); const start = () => transport.send(command('board.get'));
  const emit = value => streams.at(-1).onmessage({ data: typeof value === 'string' ? value : JSON.stringify(value) });
  return { streams, events, errors, transport, stop, command, start, emit };
}
test('初期取得はSSEの最初のスナップショットを使い、独立したGETとの隙間を作らない', async t => {
  const s = setup(t, () => assert.fail('GETで初期化しない')); await s.start();
  assert.equal(s.events.length, 0); s.streams[0].onopen(); s.emit(snapshot()); assert.equal(s.events.length, 1);
  s.emit(snapshot(board(), 1)); assert.equal(s.events.length, 2);
});
test('SSEで不正JSON・別ボード・重複ID・旧ID・不正Reaction・矢印・端末の取り違えを拒否する', async t => {
  for (const invalid of [
    'bad json', snapshot({ ...board(), boardId: 'other' }), snapshot(board([board().cards[0], board().cards[0]])),
    snapshot(board([{ ...board().cards[0], cardId: 'old' }])), snapshot(board(), -1),
    snapshot(board(), 0, { type: 'edit.check', userId: 'other', clientId: 'client', cardIds: [cid(1)], lockId: 'lock', checkId: 'check' }),
    snapshot(board(), 0, { type: 'edit.check', userId: 'user', clientId: 'other', cardIds: [cid(1)], lockId: 'lock', checkId: 'check' }),
    snapshot(board(), 0, { type: 'board.cards-generated', eventId: 'event', generationId: 'g', generatedCardIds: [cid(99)] }),
  ]) {
    const s = setup(t); await s.start(); s.emit(invalid);
    assert.equal(s.errors.length, 1); assert.equal(s.events.length, 0); assert.equal(s.streams[0].closed, true);
    s.stop(); s.emit(snapshot()); assert.equal(s.events.length, 0);
  }
});
test('POSTの拒否も正常な応答として受信し、HTTP失敗はSSEを切断せず呼出元へ返す', async t => {
  const command = commands()('generation.request', { level: 'mid' });
  const rejected = snapshot(board(), 0, { type: 'command.rejected', clientId: 'client', requestId: command.requestId, commandType: command.type, reason: 'locked' });
  const s = setup(t, async (_url, options) => {
    assert.equal(options.method, 'POST'); assert.equal(options.cache, 'no-store'); assert.equal(options.headers['Content-Type'], 'application/json');
    return Response.json(rejected, { status: 409 });
  });
  await s.start(); s.emit(snapshot()); await s.transport.send(command);
  assert.equal(s.events.at(-1).type, 'command.rejected'); assert.equal(s.errors.length, 0);
  const failed = setup(t, async () => { throw new Error('network'); }); await failed.start(); failed.emit(snapshot());
  await assert.rejects(failed.transport.send(command), /network/);
  assert.equal(failed.errors.length, 0); assert.equal(failed.streams[0].closed, false);
});
test('HTTPで要求・端末・問い合わせ・ロックが一致しない応答を拒否する', async t => {
  const request = commands()('edit.check.reply', { lockId: 'lock', checkId: 'check', state: 'cancelling' });
  const reply = snapshot(board(), 0, { type: 'edit.checked', clientId: 'client', requestId: request.requestId,
    cardIds: [cid(1)], lockId: 'lock', checkId: 'check', outcome: 'cancelled' });
  for (const extra of [{ clientId: 'other' }, { requestId: 'other' }, { lockId: 'other' }, { checkId: 'other' }, { board: { ...board(), boardId: 'other' } }]) {
    const s = setup(t, async () => Response.json({ ...reply, ...extra }));
    await assert.rejects(s.transport.send(request), /一致/); assert.equal(s.events.length, 0); assert.equal(s.errors.length, 0);
  }
});
test('購読解除は送信を中断し、古いHTTP応答を新しい購読者へ渡さない', async t => {
  let finish; let signal;
  const s = setup(t, (_url, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); });
  const command = s.command('timer.start'); const sending = s.transport.send(command); s.stop(); assert.equal(signal.aborted, true);
  const stopNew = s.transport.subscribe(() => assert.fail('old response'), () => assert.fail('old error')); t.after(stopNew);
  finish(Response.json(snapshot(board(), 0, { type: 'command.accepted', commandType: 'timer.start', requestId: command.requestId, clientId: 'client', changed: true })));
  await sending; assert.equal(s.events.length, 0);
});
test('SSE切断はクライアントをオフラインにする', async t => {
  const service = createBoardService([board()]); const { client, streams } = connectedClient(service, identity);
  t.after(() => { client.disconnect(); service.dispose(); }); client.connect(); await until(() => client.getSnapshot().status === 'ready');
  streams[0].onerror(); assert.equal(client.getSnapshot().status, 'offline'); assert.equal(streams[0].closed, true);
});
