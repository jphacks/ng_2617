'use client';

import { createElement, useLayoutEffect, useRef } from 'react';

/** 期限で先に破棄せず、blurによるIME確定を集約してから一度だけ最終本文を送る。 */
export function MatchingTextInput({ value, expired, onValueChange, onFinalize }: {
  value: string; expired: boolean; onValueChange: (value: string) => void; onFinalize: (value: string) => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const frozen = useRef<string | null>(null);
  const finalized = useRef(false);
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
    if (window.matchMedia?.('(pointer: fine)').matches && !expired) input.current?.focus();
  }, [expired]); // 本文の共有でフォーカスを動かさない。

  // createElementはハンドラーの登録だけを行い、描画中にrefを読まない。
  // eslint-disable-next-line react-hooks/refs
  return createElement('textarea', {
    ref: input, defaultValue: value, id: 'matching-idea', className: 'matching-input', maxLength: 100_000,
    placeholder: '2つの単語から、どんなアイデアが浮かびますか？',
    'aria-label': '自分のアイデア', 'aria-describedby': 'matching-save-state',
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: event => {
      composing.current = false;
      if (expired) {
        if (!finalized.current) frozen.current = event.currentTarget.value;
      } else onValueChange(event.currentTarget.value);
    },
    onChange: event => {
      if (!expired && frozen.current === null) onValueChange(event.currentTarget.value);
    },
  });
}
