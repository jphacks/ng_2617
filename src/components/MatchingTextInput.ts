'use client';

import { createElement, useLayoutEffect, useRef, useState } from 'react';
import { canAutoFocusTextInput, createTextInputActivation, focusTextInput } from '../client/focus-text-input.ts';

/** 期限で先に破棄せず、blurによるIME確定を集約してから一度だけ最終本文を送る。 */
export function MatchingTextInput({ value, expired, onValueChange, onFinalize }: {
  value: string; expired: boolean; onValueChange: (value: string) => void; onFinalize: (value: string) => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const frozen = useRef<string | null>(null);
  const finalized = useRef(false);
  const [activation] = useState(createTextInputActivation);
  const finalizeCallback = useRef(onFinalize);
  useLayoutEffect(() => { finalizeCallback.current = onFinalize; }, [onFinalize]);
  useLayoutEffect(() => {
    if (!expired && input.current && !composing.current && frozen.current === null && input.current.value !== value) input.current.value = value;
  }, [value, expired]);
  useLayoutEffect(() => {
    const element = input.current;
    if (!expired || !element) return;
    frozen.current ??= element.value;
    element.blur();
    element.readOnly = true;
    const timeout = setTimeout(() => {
      if (finalized.current) return;
      finalized.current = true;
      finalizeCallback.current(frozen.current ?? element.value);
    }, 60);
    return () => clearTimeout(timeout);
  }, [expired]);
  useLayoutEffect(() => {
    if (!expired && input.current && canAutoFocusTextInput(input.current)) focusTextInput(input.current);
  }, [expired]); // 本文の共有でフォーカスを動かさない。

  // createElementはハンドラーの登録だけを行い、描画中にrefを読まない。
  // eslint-disable-next-line react-hooks/refs
  return createElement('textarea', {
    ref: input, defaultValue: value, id: 'matching-idea', className: 'matching-input', maxLength: 100_000, inputMode: 'text',
    placeholder: '2つの単語から、どんなアイデアが浮かびますか？',
    'aria-label': '自分のアイデア', 'aria-describedby': 'matching-save-state',
    onPointerDown: event => {
      if (expired || frozen.current !== null) return;
      activation.pointerDown(event);
    },
    onClick: event => { if (!expired && frozen.current === null) activation.click(event.currentTarget); },
    onCompositionStart: () => { activation.inputStarted(); composing.current = true; },
    onCompositionEnd: event => {
      composing.current = false;
      if (expired) {
        if (!finalized.current) frozen.current = event.currentTarget.value;
      } else onValueChange(event.currentTarget.value);
    },
    onChange: event => {
      activation.inputStarted();
      if (!expired && frozen.current === null) onValueChange(event.currentTarget.value);
    },
  });
}
