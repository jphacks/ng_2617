'use client';

import { createElement, useCallback, useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';

export const NOTICE_DURATION_MS = 10_000;

/** 通知の発生単位で期限を持ち、同期やタイマーの再描画では延長しない。 */
export function BoardNotice({ noticeId, hidden = false, className, role = 'status', children, onDismiss }: {
  noticeId: string | object; hidden?: boolean;
  className: string; role?: 'status' | 'alert'; children: ReactNode; onDismiss?: () => void;
}) {
  const [expiredId, setExpiredId] = useState<string | object | null>(null);
  const dismissedId = useRef<string | object | null>(null);
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);
  const dismiss = useCallback(() => {
    if (dismissedId.current === noticeId) return;
    dismissedId.current = noticeId;
    setExpiredId(noticeId);
    onDismissRef.current?.();
  }, [noticeId]);
  useEffect(() => {
    const timeout = setTimeout(dismiss, NOTICE_DURATION_MS);
    return () => clearTimeout(timeout);
  }, [dismiss]);
  if (hidden || expiredId === noticeId) return null;
  const noticeProps: HTMLAttributes<HTMLDivElement> = {
    className: `board-notice ${className}`, role, tabIndex: 0,
    title: 'タップまたはEnterキーで閉じる',
    onClick: event => {
      event.stopPropagation();
      // 再接続・再送などの操作は、通知を閉じずに実行する。
      if ((event.target as HTMLElement).closest?.('button,a,input,select,textarea,summary,[role="button"],[contenteditable="true"]')) return;
      dismiss();
    },
    onKeyDown: event => {
      if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault(); event.stopPropagation(); dismiss();
    },
  };
  // createElementはイベントハンドラーを登録するだけで、refを読むdismissはここでは実行しない。
  // eslint-disable-next-line react-hooks/refs
  return createElement('div', noticeProps, children);
}
