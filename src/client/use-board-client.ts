'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { BoardClient } from './board-client';

/** clientはuseState等で1回生成し、同じインスタンスを渡す。接続の所有者は1つ。 */
export function useBoardClient(client: BoardClient) {
  const state = useSyncExternalStore(
    client.subscribe, client.getSnapshot, client.getSnapshot,
  );
  useEffect(() => {
    client.connect();
    const leave = () => client.leave();
    const resume = (event: PageTransitionEvent) => { if (event.persisted) client.connect(); };
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', resume);
    return () => {
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', resume);
      client.scheduleLeave();
    };
  }, [client]);
  return { state, client };
}
