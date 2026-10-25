'use client';

import { createElement, useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from 'react';
import { createTextInputActivation } from '../client/focus-text-input.ts';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'defaultValue' | 'onChange' | 'onCompositionStart' | 'onCompositionEnd'> & {
  value: string;
  editSession: string | null;
  onValueChange: (value: string) => void;
};

/** React Flowのノード反映を待たず、ネイティブ入力と同じイベント内で表示値を更新する。 */
export function CardTextInput({ value, editSession, onValueChange, onKeyDown, onPointerDown, onClick, ...props }: Props) {
  const [text, setText] = useState(value);
  const [activation] = useState(createTextInputActivation);
  const composing = useRef(false);
  const pendingText = useRef<string | null>(null);
  const session = useRef(editSession);
  const input = useRef<HTMLTextAreaElement>(null);
  const acceptsInput = editSession !== null && !props.readOnly && !props.disabled;

  useLayoutEffect(() => {
    const element = input.current;
    if (!element || acceptsInput) return;
    // フォーカスは許可してキーボードを開くが、編集権の取得までは本文を変えない。
    const prevent = (event: Event) => event.preventDefault();
    for (const type of ['beforeinput', 'paste', 'cut', 'drop']) element.addEventListener(type, prevent);
    return () => { for (const type of ['beforeinput', 'paste', 'cut', 'drop']) element.removeEventListener(type, prevent); };
  }, [acceptsInput]);

  useLayoutEffect(() => {
    const changedSession = session.current !== editSession;
    session.current = editSession;
    if (changedSession || editSession === null) {
      composing.current = false;
      pendingText.current = null;
    } else if (pendingText.current === value) {
      pendingText.current = null;
    }
    if (!composing.current && pendingText.current === null) {
      // 外部ストアの確定・取消をDOMへ同期する。変換中や古いノードの値では上書きしない。
      setText(value);
    }
  }, [value, editSession]);

  function changeText(element: HTMLTextAreaElement) {
    if (!acceptsInput) {
      element.value = value;
      return;
    }
    const next = element.value;
    activation.inputStarted();
    pendingText.current = next;
    setText(next);
    onValueChange(next);
  }

  const inputProps: TextareaHTMLAttributes<HTMLTextAreaElement> = {
    ...props,
    value: text,
    inputMode: props.inputMode ?? 'text',
    onPointerDown: event => { activation.pointerDown(event); onPointerDown?.(event); },
    onClick: event => {
      onClick?.(event);
      if (!event.defaultPrevented) activation.click(event.currentTarget);
    },
    onCompositionStart: () => {
      composing.current = acceptsInput;
      if (acceptsInput) activation.inputStarted();
    },
    onCompositionEnd: event => {
      composing.current = false;
      changeText(event.currentTarget);
    },
    onChange: event => changeText(event.currentTarget),
    onKeyDown: event => {
      // Safariでは変換確定のキーでisComposingがfalseになる場合がある。
      if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
        event.stopPropagation();
        return;
      }
      onKeyDown?.(event);
    },
  };
  // createElementはイベントハンドラーを登録するだけで、ここでrefを読むことはない。
  // eslint-disable-next-line react-hooks/refs
  return createElement('textarea', { ...inputProps, ref: input });
}
