/** タッチ入力ではタップ完了時に呼び、pointerdownや非同期応答からは呼ばない。 */
export function focusTextInput(input: HTMLTextAreaElement, renewFocus = false): void {
  if (input.disabled || input.readOnly) return;
  // 既に「カーソルだけ」のフォーカスがある場合も、同じタップ内で開始し直す。
  const selection = { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
  if (renewFocus && input.ownerDocument.activeElement === input) input.blur();
  input.focus();
  if (renewFocus) input.setSelectionRange(selection.start, selection.end, selection.direction);
  if (input.ownerDocument.activeElement !== input) return;
  const navigator = input.ownerDocument.defaultView?.navigator as
    (Navigator & { virtualKeyboard?: { show: () => void } }) | undefined;
  // Safari等の未対応ブラウザは通常のタップによるキーボード表示に任せる。
  try { navigator?.virtualKeyboard?.show(); } catch { /* 利用できない端末でも通常の入力は続ける。 */ }
}

/** 指を置いただけ・スクロール開始時には入力用フォーカスを作らない。 */
export function createTextInputActivation() {
  let pointerType = 'mouse';
  let needsActivation = true;
  return {
    pointerDown(event: { pointerType: string }) { pointerType = event.pointerType; },
    click(input: HTMLTextAreaElement) {
      if (input.disabled || input.readOnly) return;
      focusTextInput(input, needsActivation && (pointerType === 'touch' || pointerType === 'pen'));
      needsActivation = false;
    },
    inputStarted() { needsActivation = false; },
  };
}

/** タッチ端末ではSafariの標準タップを先取りしない。 */
export function canAutoFocusTextInput(input: HTMLTextAreaElement): boolean {
  const view = input.ownerDocument.defaultView;
  return !!view && !view.navigator.maxTouchPoints && !view.matchMedia?.('(any-pointer: coarse)').matches;
}
