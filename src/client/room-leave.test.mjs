import assert from 'node:assert/strict';
import test from 'node:test';
import { StrictMode, act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { createBoardClient } from './board-client.ts';
import { useBoardClient } from './use-board-client.ts';
import { createBoardService } from '../server/board-service.ts';
import { getCard } from '../domain/board.ts';
import { board, cid, identity, snapshot } from '../test/board-fixtures.mjs';
import { connectedClient, until } from '../test/transport-harness.mjs';
import { deferred, flush } from '../test/fake-clock.mjs';

test('退室は本人のロックだけを即時解除し、同じ利用者の別端末と再入室を妨げない', async t => {
  const service = createBoardService([board()]); const sent = [];
  const a = connectedClient(service, identity, command => { sent.push(command); }).client;
  const b = connectedClient(service, { ...identity, clientId: 'other-tab' }).client;
  t.after(() => { a.disconnect(); b.disconnect(); service.dispose(); });
  a.connect(); b.connect(); await until(() => a.getSnapshot().status === 'ready' && b.getSnapshot().status === 'ready');
  a.requestEdit(cid(1)); b.requestEdit(cid(2));
  await until(() => a.getSnapshot().edit.phase === 'editing' && b.getSnapshot().edit.phase === 'editing');
  a.leave(); a.leave();
  await until(() => !getCard(service.getBoardSnapshot('board').board, cid(1)).editingUser);
  assert.ok(getCard(service.getBoardSnapshot('board').board, cid(2)).editingUser);
  assert.equal(sent.filter(command => command.type === 'board.leave').length, 1);
  const returned = connectedClient(service, { ...identity, clientId: 'returned' }).client;
  t.after(() => returned.disconnect()); returned.connect(); await until(() => returned.getSnapshot().status === 'ready');
  assert.equal(returned.requestEdit(cid(1)), true); await until(() => returned.getSnapshot().edit.phase === 'editing');
});

test('一時切断は退室せず、切断後の明示的な退室でもロックを解除する', async t => {
  const service = createBoardService([board()]); const sent = [];
  const { client, streams } = connectedClient(service, identity, command => { sent.push(command); });
  t.after(() => { client.disconnect(); service.dispose(); });
  client.connect(); await until(() => client.getSnapshot().status === 'ready');
  client.requestEdit(cid(1)); await until(() => client.getSnapshot().edit.phase === 'editing');
  streams.at(-1).onerror();
  assert.ok(getCard(service.getBoardSnapshot('board').board, cid(1)).editingUser);
  assert.equal(sent.some(command => command.type === 'board.leave'), false);
  client.leave(); await until(() => !getCard(service.getBoardSnapshot('board').board, cid(1)).editingUser);
});

test('取得要求が退室より後に届いてもロックを残さない', async t => {
  const service = createBoardService([board()]); const delayed = deferred();
  const { client } = connectedClient(service, identity, command => command.type === 'edit.request' ? delayed.promise : undefined);
  t.after(() => { client.disconnect(); service.dispose(); });
  client.connect(); await until(() => client.getSnapshot().status === 'ready');
  client.requestEdit(cid(1)); client.leave(); await flush(); delayed.resolve(); await flush(); await flush();
  assert.equal(getCard(service.getBoardSnapshot('board').board, cid(1)).editingUser, undefined);
  assert.equal(client.getSnapshot().status, 'offline');
});

test('StrictModeのeffect再実行では退室せず、ページ離脱と本当のアンマウントで退室する', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import('react-dom/client');
  const commands = []; let receive;
  const client = createBoardClient(identity, {
    send(command) { commands.push(command); if (command.type === 'board.get') queueMicrotask(() => receive(snapshot())); },
    subscribe(onEvent) { receive = onEvent; return () => {}; },
  });
  function Consumer() { useBoardClient(client); return null; }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => { root.render(createElement(StrictMode, null, createElement(Consumer))); });
  assert.equal(commands.filter(command => command.type === 'board.leave').length, 0);
  const firstId = client.getSnapshot().identity.clientId;
  await act(async () => { window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: true })); await flush(); });
  assert.equal(commands.filter(command => command.type === 'board.leave').length, 1);
  await act(async () => { window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true })); await flush(); });
  assert.notEqual(client.getSnapshot().identity.clientId, firstId);
  assert.equal(client.getSnapshot().status, 'ready');
  await act(() => root.unmount()); await flush();
  assert.equal(commands.filter(command => command.type === 'board.leave').length, 2);
  client.disconnect(); host.remove(); dom.window.close();
});
