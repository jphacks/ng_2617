import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { CardTextInput } from '../components/CardTextInput.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Node', 'Event', 'InputEvent', 'CompositionEvent', 'KeyboardEvent']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// React DOMの入力イベント検出より先にDOMを用意する。
const { createRoot } = await import('react-dom/client');
const setNativeValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;

async function setup(t) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const changes = []; const keys = [];
  let props = { value: '元の本文', editSession: 'lock', onValueChange: value => changes.push(value) };
  const render = async patch => {
    props = { ...props, ...patch };
    await act(() => root.render(createElement('div', { onKeyDown: event => keys.push(event.key) }, createElement(CardTextInput, props))));
  };
  await render({});
  const input = host.querySelector('textarea'); input.focus();
  const dispatch = async event => { await act(() => { input.dispatchEvent(event); }); return event; };
  const type = async (value, isComposing = false) => {
    setNativeValue.call(input, value);
    await dispatch(new InputEvent('input', { bubbles: true, data: value, inputType: isComposing ? 'insertCompositionText' : 'insertText', isComposing }));
  };
  const start = () => dispatch(new CompositionEvent('compositionstart', { bubbles: true }));
  const end = async value => {
    setNativeValue.call(input, value);
    await dispatch(new CompositionEvent('compositionend', { bubbles: true, data: value }));
  };
  const key = (key, options = {}) => dispatch(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
  t.after(async () => { await act(() => root.unmount()); host.remove(); });
  return { host, input, changes, keys, render, type, start, end, key };
}

test('ノードへの反映が遅れても入力イベント直後の日本語を古い値へ巻き戻さない', async t => {
  const s = await setup(t);
  await s.type('に'); assert.equal(s.input.value, 'に');
  await s.type('にほ'); assert.equal(s.input.value, 'にほ');
  await s.render({ style: { fontSize: 18 } });
  assert.equal(s.input, s.host.querySelector('textarea'));
  assert.equal(s.input.value, 'にほ'); assert.equal(s.input.selectionStart, 2);
  assert.deepEqual(s.changes, ['に', 'にほ']);
  await s.render({ value: 'にほ' }); assert.equal(s.input.value, 'にほ');
});

test('変換中の連続入力・ノードの古い反映・変換確定で入力を失わない', async t => {
  const s = await setup(t); await s.start();
  await s.type('に', true); await s.type('にほ', true);
  await s.render({ value: 'に' }); assert.equal(s.input.value, 'にほ');
  await s.type('にほん', true); await s.render({ value: 'にほ' });
  assert.equal(s.input.value, 'にほん');
  await s.end('日本'); assert.equal(s.input.value, '日本'); assert.equal(s.changes.at(-1), '日本');
  await s.render({ value: 'にほん' }); assert.equal(s.input.value, '日本');
  await s.render({ value: '日本' }); assert.equal(s.input.value, '日本');
  // 確定した最新値に追いついた後は、通常の外部更新を表示できる。
  await s.render({ value: '日本のアイデア' }); assert.equal(s.input.value, '日本のアイデア');
});

test('IME中のEnter・Escape・候補操作はカードへ伝播せず、IMEの既定動作は妨げない', async t => {
  const s = await setup(t); const windowKeys = [];
  const listener = event => windowKeys.push(event.key);
  window.addEventListener('keydown', listener); t.after(() => window.removeEventListener('keydown', listener));
  await s.start();
  for (const [key, options] of [['Enter', {}], ['Enter', { ctrlKey: true }], ['Enter', { metaKey: true }], ['Escape', {}], [' ', {}], ['ArrowDown', {}]]) {
    const event = await s.key(key, options); assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(s.keys, []); assert.deepEqual(windowKeys, []);
});

test('compositionstartが届かない場合やSafari形式の229キーでもショートカットを実行しない', async t => {
  const s = await setup(t);
  await s.key('Enter', { isComposing: true, ctrlKey: true });
  await s.key('Escape', { isComposing: true });
  await s.key('Enter', { isComposing: false, keyCode: 229, metaKey: true });
  assert.deepEqual(s.keys, []);
  await s.start(); await s.end('日本');
  await s.key('Enter', { isComposing: false, keyCode: 229 });
  assert.deepEqual(s.keys, []);
});

test('変換終了後はEnter改行を保持し、明示確定・取消のキーを通常どおり渡す', async t => {
  const s = await setup(t); await s.start(); await s.type('にほん', true); await s.end('日本');
  await s.key('Enter'); await s.type('日本\nアイデア');
  assert.equal(s.input.value, '日本\nアイデア'); assert.equal(s.changes.at(-1), '日本\nアイデア');
  await s.key('Enter', { ctrlKey: true }); await s.key('Enter', { metaKey: true }); await s.key('Escape');
  assert.deepEqual(s.keys, ['Enter', 'Enter', 'Enter', 'Escape']);
});

test('取消・編集権消失では変換中のローカル値を破棄し、次の貸し出しに残さない', async t => {
  const s = await setup(t); await s.start(); await s.type('にほん', true);
  await s.render({ editSession: null, readOnly: true }); assert.equal(s.input.value, '元の本文');
  await s.render({ editSession: 'next-lock', readOnly: false, value: '次の本文' });
  assert.equal(s.input.value, '次の本文');
  await s.type('次の本文を編集'); assert.equal(s.input.value, '次の本文を編集');
  await s.key('Escape'); assert.deepEqual(s.keys, ['Escape']);
});
