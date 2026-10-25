import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { BoardNotice } from '../components/BoardNotice.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');

async function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let props = { noticeId: 'import:1:succeeded', className: 'file-message', children: 'ボードを読み込みました。' };
  const render = async patch => {
    props = { ...props, ...patch };
    await act(() => root.render(createElement(BoardNotice, props)));
  };
  const advance = ms => act(() => t.mock.timers.tick(ms));
  await render({});
  t.after(async () => { await act(() => root.unmount()); host.remove(); });
  return { host, render, advance };
}

test('完了通知は再描画で期限を延ばさず5秒後に消え、同じ文面の新しい操作は再表示する', async t => {
  const s = await setup(t);
  await s.advance(4000); await s.render({});
  await s.advance(999); assert.ok(s.host.textContent.includes('読み込みました'));
  await s.advance(1); assert.equal(s.host.textContent, '');
  await s.render({}); assert.equal(s.host.textContent, '');
  await s.render({ noticeId: 'import:2:succeeded' });
  assert.ok(s.host.textContent.includes('読み込みました'));
  await s.advance(5000); assert.equal(s.host.textContent, '');
});

test('前の通知のタイマーで新しい通知を消さず、他の表示で隠れた古い通知も復活させない', async t => {
  const s = await setup(t);
  await s.advance(3000); await s.render({ noticeId: {}, children: 'JSONファイルを出力しました。' });
  await s.advance(2000); assert.ok(s.host.textContent.includes('出力しました'));
  await s.render({ hidden: true }); await s.advance(3000);
  await s.render({ hidden: false }); assert.equal(s.host.textContent, '');
});

test('処理中と要対応エラーは残し、完了へ変わった時点から5秒間表示する', async t => {
  const s = await setup(t);
  await s.render({ noticeId: 'generation:1:running', persistent: true, children: '生成中…' });
  await s.advance(10_000); assert.equal(s.host.textContent, '生成中…');
  await s.render({ noticeId: 'generation:1:completed', persistent: false, children: '3枚の候補を追加しました。' });
  await s.advance(4999); assert.ok(s.host.textContent.includes('3枚'));
  await s.advance(1); assert.equal(s.host.textContent, '');
  await s.render({ noticeId: 'error', persistent: true, role: 'alert', children: '再接続してください。' });
  await s.advance(10_000); assert.equal(s.host.querySelector('[role="alert"]').textContent, '再接続してください。');
});
