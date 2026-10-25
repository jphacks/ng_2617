import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { adoptUserNodes, calculateNodePosition } from '@xyflow/system';
import { useMeasuredNodes } from './use-measured-nodes.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const card = (id = 'card', extra = {}) => ({ id, position: { x: 0, y: 0 }, width: 210, height: 210, data: { text: '本文' }, ...extra });

async function setup(t) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); let result;
  function Probe({ nodes }) { result = useMeasuredNodes(nodes); return null; }
  const render = nodes => act(() => root.render(createElement(Probe, { nodes })));
  const change = changes => act(() => result.onNodesChange(changes));
  await render([card()]);
  t.after(async () => { await act(() => root.unmount()); host.remove(); });
  return { render, change, current: () => result.nodes };
}

function assertDraggable(nodes) {
  const lookup = new Map(); const parents = new Map(); const warnings = [];
  // 制御ノードの更新を繰り返しても、React Flow内部の計測情報が失われない。
  for (let i = 0; i < 2; i++) {
    adoptUserNodes(nodes.map(node => ({ ...node })), lookup, parents);
    for (const node of nodes) calculateNodePosition({ nodeId: node.id, nextPosition: { x: 40, y: 60 }, nodeLookup: lookup,
      onError: code => warnings.push(code) });
  }
  assert.deepEqual(warnings, []);
}

test('計測後の本文・位置・選択・ロック更新でも初期化情報を保ち、015警告を出さない', async t => {
  const s = await setup(t);
  await s.change([{ id: 'card', type: 'dimensions', dimensions: { width: 210, height: 210 } }]);
  for (const extra of [{ data: { text: '新しい本文' } }, { position: { x: 50, y: 70 } }, { selected: true }, { draggable: false }, { draggable: true }]) {
    await s.render([card('card', extra)]);
    assert.deepEqual(s.current()[0].measured, { width: 210, height: 210 });
    for (const [key, value] of Object.entries(extra)) assert.deepEqual(s.current()[0][key], value);
    assertDraggable(s.current());
  }
});

test('リサイズの再計測を保持し、ローカルの変更で共有位置や確定サイズを上書きしない', async t => {
  const s = await setup(t);
  await s.change([{ id: 'card', type: 'dimensions', dimensions: { width: 300, height: 260 }, setAttributes: true }]);
  const updated = card('card', { width: 300, height: 260, position: { x: 100, y: 120 } });
  await s.render([updated]);
  await s.change([{ id: 'card', type: 'position', position: { x: -1, y: -1 } }, { id: 'card', type: 'select', selected: true }]);
  assert.deepEqual(s.current()[0], { ...updated, measured: { width: 300, height: 260 } });
  assertDraggable(s.current());
});

test('複数カードと新規追加を個別に計測し、削除したカードの情報を次のボードへ持ち越さない', async t => {
  const s = await setup(t);
  await s.change([{ id: 'card', type: 'dimensions', dimensions: { width: 210, height: 210 } }]);
  await s.render([card(), card('other')]);
  assert.equal(s.current()[1].measured, undefined);
  await s.change([{ id: 'other', type: 'dimensions', dimensions: { width: 220, height: 230 } }]);
  assertDraggable(s.current());
  await s.render([card('other')]);
  await s.change([{ id: 'other', type: 'dimensions', dimensions: { width: 240, height: 250 } }]);
  await s.render([card('card'), card('other')]);
  assert.equal(s.current()[0].measured, undefined);
  assert.deepEqual(s.current()[1].measured, { width: 240, height: 250 });
});
