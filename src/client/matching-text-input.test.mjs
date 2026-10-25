import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { MatchingTextInput } from '../components/MatchingTextInput.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Node', 'Event', 'InputEvent', 'CompositionEvent']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;

async function setup(t, touchDevice = false) {
  if (touchDevice) {
    const previous = Object.getOwnPropertyDescriptor(window.navigator, 'maxTouchPoints');
    Object.defineProperty(window.navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    t.after(() => { if (previous) Object.defineProperty(window.navigator, 'maxTouchPoints', previous); else delete window.navigator.maxTouchPoints; });
  }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const changes = []; const finals = [];
  let props = { value: '元の本文', expired: false, onValueChange: text => changes.push(text), onFinalize: text => finals.push(text) };
  const render = async patch => { props = { ...props, ...patch }; await act(() => root.render(createElement(MatchingTextInput, props))); };
  await render({}); const input = host.querySelector('textarea');
  const dispatch = async event => { await act(() => input.dispatchEvent(event)); };
  const type = async text => { setValue.call(input, text); await dispatch(new InputEvent('input', { bubbles: true, data: text })); };
  const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 80)));
  t.after(async () => { await act(() => root.unmount()); host.remove(); });
  return { input, changes, finals, render, dispatch, type, settle };
}

test('ゲーム本文の同期でも同じ入力欄・日本語変換・カーソルを維持する', async t => {
  const s = await setup(t); await s.dispatch(new CompositionEvent('compositionstart', { bubbles: true }));
  await s.type('にほん'); s.input.setSelectionRange(2, 2); await s.render({ value: '古い共有本文' });
  assert.equal(s.input.value, 'にほん'); assert.equal(s.input.selectionStart, 2);
  setValue.call(s.input, '日本'); await s.dispatch(new CompositionEvent('compositionend', { bubbles: true, data: '日本' }));
  assert.equal(s.changes.at(-1), '日本'); assert.deepEqual(s.finals, []);
});
test('0秒でIMEを確定して最終本文を一度だけ送り、期限後の通常入力は送らない', async t => {
  const s = await setup(t); await s.dispatch(new CompositionEvent('compositionstart', { bubbles: true })); await s.type('にほん');
  await s.render({ expired: true }); assert.equal(s.input.readOnly, true); assert.notEqual(document.activeElement, s.input);
  setValue.call(s.input, '日本'); await s.dispatch(new CompositionEvent('compositionend', { bubbles: true, data: '日本' }));
  await s.settle(); assert.deepEqual(s.finals, ['日本']); assert.deepEqual(s.changes, ['にほん']);
  await s.type('期限後の書き換え'); await s.render({ value: 'にほん' }); await s.settle();
  assert.deepEqual(s.changes, ['にほん']); assert.deepEqual(s.finals, ['日本']);
});
test('IMEの終了通知が届かなくても期限時点の本文を送り、中断時も空で上書きしない', async t => {
  const s = await setup(t); await s.type('書きかけの本文'); await s.render({ expired: true, value: '' }); await s.settle();
  assert.deepEqual(s.finals, ['書きかけの本文']);
});

test('タッチ端末では押下・自動更新で先行フォーカスせず、タップ完了時に入力を開始する', async t => {
  const s = await setup(t, true); assert.notEqual(document.activeElement, s.input); assert.equal(s.input.inputMode, 'text');
  let blurred = 0; s.input.addEventListener('blur', () => blurred++);
  const touch = () => {
    const event = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerType', { value: 'touch' }); return s.dispatch(event);
  };
  await touch(); assert.notEqual(document.activeElement, s.input); assert.equal(blurred, 0);
  await s.render({ value: '入力前の共有本文' }); assert.notEqual(document.activeElement, s.input);
  // ブラウザの標準動作で、clickより前にフォーカスされた場合も同じタップ内で開始し直す。
  s.input.focus(); await s.dispatch(new Event('click', { bubbles: true }));
  assert.equal(document.activeElement, s.input); assert.equal(blurred, 1);
  await s.type('にほん'); await s.dispatch(new CompositionEvent('compositionstart', { bubbles: true }));
  s.input.setSelectionRange(1, 1); await touch(); await s.dispatch(new Event('click', { bubbles: true }));
  assert.equal(blurred, 1); assert.equal(s.input.selectionStart, 1); assert.equal(s.input.value, 'にほん');
  await s.render({ value: '古い本文' }); assert.equal(blurred, 1); assert.equal(s.input.value, 'にほん');
});

test('期限後のタップは入力欄を再フォーカスせず、最終本文も再送しない', async t => {
  const s = await setup(t); await s.type('終了時の本文'); await s.render({ expired: true }); await s.settle();
  const event = new Event('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerType', { value: 'touch' }); await s.dispatch(event);
  await s.dispatch(new Event('click', { bubbles: true }));
  assert.notEqual(document.activeElement, s.input); assert.equal(s.input.readOnly, true);
  assert.deepEqual(s.finals, ['終了時の本文']);
});
