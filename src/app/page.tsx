'use client';

import { useEffect, useState, useRef } from 'react';
import { ReactFlow, Background, Controls } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { createBoardClient, type BoardClientState, type BoardClient } from '@/client/board-client';
import { createHttpBoardTransport } from '@/client/http-board-transport';
import { useIdleHeartbeat } from '@/hooks/useIdleHeartbeat';

export default function Home() {
  const [state, setState] = useState<BoardClientState | null>(null);
  const [request, setRequest] = useState(0);
  const clientRef = useRef<BoardClient | null>(null);

  useEffect(() => {
    const client = createBoardClient({
      boardId: 'demo', userId: 'demo-user', clientId: crypto.randomUUID(),
    }, createHttpBoardTransport());
    clientRef.current = client;
    const unsubscribe = client.subscribe(() => setState(client.getSnapshot()));
    client.connect();
    return () => {
      unsubscribe();
      client.disconnect();
      clientRef.current = null;
    };
  }, [request]);

  useIdleHeartbeat({
    client: clientRef.current,
    timeoutSeconds: 30,
    heartbeatIntervalSeconds: 60,
  });

  // --- 【タイマー＆演出担当の統合部分】 ---
  const nodes = state?.board?.cards.map((card) => {
    // レベル（low / mid / high）に応じたアニメーションとスタイルの切り替え
    let animationClass = '';
    let badgeText = '';
    let borderColor = card.color || '#e5e7eb';
    let bgColor = '#ffffff';

    // 仮に card に level プロパティがある、またはサーバーから渡ってくる場合の分岐
    // ※ 実際のプロパティ名（例: card.level や card.relationLevel など）に合わせて調整してください
    const level = (card as any).level || 'mid'; 

    if (level === 'low') {
      animationClass = 'animate-storm';
      badgeText = '🌪️ ストーム (台風)';
      borderColor = '#60a5fa'; // 青系
      bgColor = '#eff6ff';
    } else if (level === 'high') {
      animationClass = 'animate-supply';
      badgeText = '📦 補給物資';
      borderColor = '#f59e0b'; // オレンジ系
      bgColor = '#fffbeb';
    } else {
      animationClass = 'transition-all duration-300';
    }

    return {
      id: card.cardId,
      type: 'default',
      data: {
        label: (
          <div 
            className={`p-3 rounded-lg shadow-md border-2 ${animationClass}`}
            style={{ backgroundColor: bgColor, borderColor: borderColor }}
          >
            {badgeText && (
              <div className="text-[10px] font-bold text-gray-500 mb-1">
                {badgeText}
              </div>
            )}
            <div className="font-semibold text-gray-800 text-sm" style={{ fontFamily: card.font }}>
              {card.text}
            </div>
          </div>
        ),
      },
      position: { x: card.position.x, y: card.position.y },
    };
  }) ?? [];
  // ----------------------------------------

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
        <small>取得のみ・編集はまだできません（🌪️アニメーション・タイマー連携中）</small>
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