"use client";

import { useEffect, useState, useRef } from 'react';
import { ReactFlow, Background, Controls } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { createBoardClient, type BoardClientState, type BoardClient } from '@/client/board-client';
import { createHttpBoardTransport } from '@/client/http-board-transport';

export default function Home() {
  const [roomId, setRoomId] = useState("");
  const router = useRouter();

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

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      handleJoin();
    }
  };

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

        <div style={{ marginBottom: 24 }}>
          <label
            style={{
              display: "block",
              fontSize: 13,
              fontWeight: 600,
              color: "#222", // ラベルを濃くしました
              marginBottom: 8,
            }}
          >
            ルームID
          </label>
          <input
            type="text"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="例: my-room-123"
            style={{
              width: "100%",
              padding: "12px 16px",
              border: "1.5px solid #bbb", // 枠線を少し太く・濃くしました
              borderRadius: 8,
              fontSize: 15, // 少し文字を大きく
              color: "#111", // ★入力される文字の色をはっきりとした黒にしました
              backgroundColor: "#fff", // 背景を白く
              outline: "none",
              transition: "border-color 0.2s",
            }}
            onFocus={(e) => {
              e.target.style.borderColor = "#2563eb"; // フォーカス時は青く
              e.target.style.boxShadow = "0 0 0 3px rgba(37, 99, 235, 0.1)"; // フォーカス時の影
            }}
            onBlur={(e) => {
              e.target.style.borderColor = "#bbb";
              e.target.style.boxShadow = "none";
            }}
          />
        </div>

        <button
          onClick={handleJoin}
          disabled={!roomId.trim()}
          style={{
            width: "100%",
            padding: "14px",
            border: 0,
            borderRadius: 8,
            background: roomId.trim() ? "#252525" : "#ccc",
            color: "#fff",
            fontSize: 15,
            fontWeight: 600,
            cursor: roomId.trim() ? "pointer" : "not-allowed",
            transition: "background 0.2s",
          }}
        >
          ルームに参加
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
    </div>
  );
}
