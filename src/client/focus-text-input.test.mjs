import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { canAutoFocusTextInput, createTextInputActivation, focusTextInput } from './focus-text-input.ts';

test('対応ブラウザでは編集可能な入力欄を先にフォーカスしてキーボードを要求する', () => {
  const dom = new JSDOM('<textarea inputmode="text"></textarea>'); const input = dom.window.document.querySelector('textarea');
  let requested = 0;
  Object.defineProperty(dom.window.navigator, 'virtualKeyboard', { value: { show() {
    assert.equal(dom.window.document.activeElement, input); requested++;
  } } });
  focusTextInput(input); assert.equal(requested, 1);
  input.readOnly = true; input.blur(); focusTextInput(input);
  assert.notEqual(dom.window.document.activeElement, input); assert.equal(requested, 1);
  input.readOnly = false; input.disabled = true; focusTextInput(input); assert.equal(requested, 1);
  dom.window.close();
});

test('SafariのAPI未対応時や表示要求が拒否された場合でも入力欄へのフォーカスを維持する', () => {
  const dom = new JSDOM('<textarea></textarea>'); const input = dom.window.document.querySelector('textarea');
  focusTextInput(input); assert.equal(dom.window.document.activeElement, input);
  Object.defineProperty(dom.window.navigator, 'virtualKeyboard', { value: { show() { throw new Error('not permitted'); } } });
  input.blur(); assert.doesNotThrow(() => focusTextInput(input));
  assert.equal(dom.window.document.activeElement, input); dom.window.close();
});

test('指を置いただけではフォーカスせず、タップ完了時に選択位置を保って入力を開始する', () => {
  const dom = new JSDOM('<textarea>日本語の本文</textarea>'); const input = dom.window.document.querySelector('textarea');
  const activation = createTextInputActivation(); let blurred = 0;
  input.addEventListener('blur', () => blurred++);
  activation.pointerDown({ pointerType: 'touch' }); assert.notEqual(dom.window.document.activeElement, input);
  // 先行するネイティブフォーカス、またはキーボードが出ていない既存のフォーカス。
  input.focus(); input.setSelectionRange(1, 3, 'backward'); activation.click(input);
  assert.equal(dom.window.document.activeElement, input); assert.equal(blurred, 1);
  assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [1, 3, 'backward']);
  activation.pointerDown({ pointerType: 'touch' }); activation.click(input); assert.equal(blurred, 1);
  dom.window.close();
});

test('入力・IME開始後のタップではフォーカスを取り直さず、タッチ端末は自動フォーカス対象にしない', () => {
  const dom = new JSDOM('<textarea></textarea>'); const input = dom.window.document.querySelector('textarea');
  Object.defineProperty(dom.window.navigator, 'maxTouchPoints', { value: 5 }); assert.equal(canAutoFocusTextInput(input), false);
  const activation = createTextInputActivation(); let blurred = 0; input.addEventListener('blur', () => blurred++);
  input.focus(); activation.inputStarted(); activation.pointerDown({ pointerType: 'touch' }); activation.click(input);
  assert.equal(blurred, 0); assert.equal(dom.window.document.activeElement, input); dom.window.close();
});
