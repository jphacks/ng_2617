'use client';

import { useEffect, useState, useRef } from 'react';
import { ReactFlow, Background, Controls } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { createBoardClient, type BoardClientState, type BoardClient } from '@/client/board-client';
import { createHttpBoardTransport } from '@/client/http-board-transport';

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

  const edit = state?.edit;
  const editing = edit && 'draft' in edit ? edit : null;

  // --- 【タイマー＆演出担当の統合部分】 ---
  const nodes = state?.board?.cards.map((savedCard) => {
    const card = editing?.cardId === savedCard.cardId ? { ...savedCard, ...editing.draft } : savedCard;
    // レベル（low / mid / high）に応じたアニメーションとスタイルの切り替え
    let animationClass = '';
    let badgeText = '';
    let borderColor = card.color || '#e5e7eb';
    let bgColor = '#ffffff';

    // 仮に card に level プロパティがある、またはサーバーから渡ってくる場合の分岐
    // ※ 実際のプロパティ名（例: card.level や card.relationLevel など）に合わせて調整してください
    const level = 'level' in card ? card.level : 'mid';

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
            {card.editingUser && <small>{editing?.cardId === card.cardId ? '編集中' : '別の端末が編集中'}</small>}
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
        <small>カードをクリックして編集できます。全員の編集終了から30秒後に候補を追加します。</small>
      </header>
      {state?.error && <p role="alert" style={{ padding: '0 20px', color: '#dc2626' }}>{state.error}</p>}
      {edit?.phase === 'requesting' && <p role="status" style={{ padding: '0 20px' }}>編集許可を確認中…</p>}
      {editing && (
        <form onSubmit={event => { event.preventDefault(); clientRef.current?.commitEdit(); }}
          style={{ padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <label htmlFor="card-text">カードの内容</label>
          <textarea id="card-text" value={editing.draft.text} maxLength={100_000}
            disabled={editing.phase !== 'editing'}
            onChange={event => clientRef.current?.updateDraft({ text: event.target.value })}
            style={{ flex: 1, border: '1px solid #aaa', borderRadius: 6, padding: 8 }} />
          <button type="submit" disabled={editing.phase !== 'editing'}>保存</button>
          <button type="button" disabled={editing.phase !== 'editing'}
            onClick={() => clientRef.current?.cancelEdit()}>取消</button>
          <span role="status">{editing.phase === 'saving' ? '保存中…' : editing.phase === 'cancelling' ? '取消中…' : '編集中'}</span>
        </form>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        {state?.board && (
          <ReactFlow nodes={nodes} edges={[]} nodesDraggable={false} nodesConnectable={false}
            onNodeClick={(_event, node) => clientRef.current?.requestEdit(node.id)}
            deleteKeyCode={null} fitView>
            <Background gap={16} size={1} />
            <Controls showInteractive={false} style={{ color: '#171717' }} />
          </ReactFlow>
        )}
      </div>
    </main>
  );
}
