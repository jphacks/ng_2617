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
    return () => client.disconnect();
  }, [client]);
  return { state, client };
}
