'use client';

import { useEffect, useRef } from 'react';
import { useIdleTimer } from './useIdleTimer';
import type { BoardClient } from '../client/board-client';

type UseIdleHeartbeatProps = {
  client: BoardClient | null;
  timeoutSeconds: number; // アイドル判定のタイムアウト（秒）
  heartbeatIntervalSeconds: number; // ハートビート送信間隔（秒）
};

/**
 * クライアントのアイドル状態を定期的にサーバーに送信するフック
 */
export function useIdleHeartbeat({ client, timeoutSeconds, heartbeatIntervalSeconds }: UseIdleHeartbeatProps) {
  const { isIdle } = useIdleTimer({
    timeoutSeconds,
    onIdle: () => {
      // アイドル状態になったときの処理は特になし
    },
  });

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!client) return;

    // 定期的にアイドル状態をサーバーに送信
    const sendHeartbeat = () => {
      const state = client.getSnapshot();
      if (state.status !== 'ready') return;

      const identity = state.identity;
      client.sendCommand({
        ...identity,
        type: 'idle.heartbeat',
        requestId: crypto.randomUUID(),
        isIdle,
      });
    };

    // 初回送信
    sendHeartbeat();

    // 定期送信の開始
    intervalRef.current = setInterval(sendHeartbeat, heartbeatIntervalSeconds * 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [client, isIdle, heartbeatIntervalSeconds]);

  return { isIdle };
}
