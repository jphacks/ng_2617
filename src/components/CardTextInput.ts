'use client';

import { createElement, useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from 'react';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'defaultValue' | 'onChange' | 'onCompositionStart' | 'onCompositionEnd'> & {
  value: string;
  editSession: string | null;
  onValueChange: (value: string) => void;
};

/** React Flowのノード反映を待たず、ネイティブ入力と同じイベント内で表示値を更新する。 */
export function CardTextInput({ value, editSession, onValueChange, onKeyDown, ...props }: Props) {
  const [text, setText] = useState(value);
  const composing = useRef(false);
  const pendingText = useRef<string | null>(null);
  const session = useRef(editSession);

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

  function changeText(next: string) {
    pendingText.current = next;
    setText(next);
    onValueChange(next);
  }

  const inputProps: TextareaHTMLAttributes<HTMLTextAreaElement> = {
    ...props,
    value: text,
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: event => {
      composing.current = false;
      changeText(event.currentTarget.value);
    },
    onChange: event => changeText(event.currentTarget.value),
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
  return createElement('textarea', inputProps);
}
