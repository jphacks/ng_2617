'use client';

import { useEffect, useState } from 'react';
import { ReactFlow, Background, Controls } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { createBoardClient, type BoardClientState } from '@/client/board-client';
import { createHttpBoardTransport } from '@/client/http-board-transport';

export default function Home() {
  const [state, setState] = useState<BoardClientState | null>(null);
  const [request, setRequest] = useState(0);

  useEffect(() => {
    // ブラウザで生成する。今回は取得専用で、ユーザー認証はまだ行わない。
    const client = createBoardClient({
      boardId: 'demo', userId: 'demo-user', clientId: crypto.randomUUID(),
    }, createHttpBoardTransport());
    const unsubscribe = client.subscribe(() => setState(client.getSnapshot()));
    client.connect();
    return () => {
      unsubscribe();
      client.disconnect();
    };
  }, [request]);

  const nodes = state?.board?.cards.map((card) => ({
    id: card.cardId,
    type: 'default',
    data: { label: card.text },
    position: { x: card.position.x, y: card.position.y },
    style: { backgroundColor: card.color, color: '#171717', fontFamily: card.font },
  })) ?? [];
  const loading = !state || state.status === 'loading';

  return (
    <main style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ padding: '12px 20px', display: 'flex', gap: 16, alignItems: 'center' }}>
        <span role="status">
          {loading ? 'サーバーから取得中…' : state.status === 'ready'
            ? `ボード取得済み：${state.board?.boardId}（${nodes.length}枚）`
            : 'ボードを取得できませんでした'}
        </span>
        <button type="button" disabled={loading} onClick={() => setRequest((value) => value + 1)}
          style={{ border: '1px solid currentColor', borderRadius: 6, padding: '4px 12px', cursor: 'pointer' }}>
          再取得
        </button>
        <small>取得のみ・編集はまだできません</small>
      </header>
      {state?.error && <p role="alert" style={{ padding: '0 20px', color: '#dc2626' }}>{state.error}</p>}
      <div style={{ flex: 1, minHeight: 0 }}>
        {state?.board && (
          <ReactFlow nodes={nodes} edges={[]} nodesDraggable={false} nodesConnectable={false}
            deleteKeyCode={null} fitView>
            <Background gap={16} size={1} />
            <Controls showInteractive={false} style={{ color: '#171717' }} />
          </ReactFlow>
        )}
      </div>
    </main>
  );
}
