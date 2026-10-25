'use client';

import { createElement, useEffect, useState, type ReactNode } from 'react';

export const NOTICE_DURATION_MS = 5_000;

/** 通知の発生単位で期限を持ち、同期やタイマーの再描画では延長しない。 */
export function BoardNotice({ noticeId, persistent = false, hidden = false, className, role = 'status', children }: {
  noticeId: string | object; persistent?: boolean; hidden?: boolean;
  className: string; role?: 'status' | 'alert'; children: ReactNode;
}) {
  const [expiredId, setExpiredId] = useState<string | object | null>(null);
  useEffect(() => {
    if (persistent) return;
    const timeout = setTimeout(() => setExpiredId(noticeId), NOTICE_DURATION_MS);
    return () => clearTimeout(timeout);
  }, [noticeId, persistent]);
  if (hidden || (!persistent && expiredId === noticeId)) return null;
  return createElement('div', { className, role }, children);
}
