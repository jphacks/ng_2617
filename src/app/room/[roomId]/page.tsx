"use client";

import { Suspense, useState, useEffect, useRef } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { useParams, useRouter } from "next/navigation";
import {
  createBoardClient,
  type BoardClient,
} from "@/client/board-client";
import { createHttpBoardTransport } from "@/client/http-board-transport";
import { useIdleHeartbeat } from "@/hooks/useIdleHeartbeat";
import type { BoardPhase, GameState } from "@/domain/board-protocol";

function Board() {
  const params = useParams();
  const router = useRouter();
  const roomId = params.roomId as string;
  const [phase, setPhase] = useState<BoardPhase>("word-generation");
  const [gameState, setGameState] = useState<GameState | null>(null);
  const clientRef = useRef<BoardClient | null>(null);

  // ボードクライアントの初期化
  useEffect(() => {
    const client = createBoardClient(
      {
        boardId: roomId,
        userId: `user-${crypto.randomUUID()}`,
        clientId: crypto.randomUUID(),
      },
      createHttpBoardTransport()
    );
    clientRef.current = client;
    
    // フェーズ状態とゲーム状態を監視
    const unsubscribe = client.subscribe(() => {
      const state = client.getSnapshot();
      if (state.status === "ready") {
        if (state.phase) setPhase(state.phase);
        if (state.gameState) setGameState(state.gameState);
      }
    });
    
    client.connect();
    return () => {
      unsubscribe();
      client.disconnect();
      clientRef.current = null;
    };
  }, [roomId]);

  // アイドル状態を定期的にサーバーに送信
  useIdleHeartbeat({
    client: clientRef.current,
    timeoutSeconds: 30,
    heartbeatIntervalSeconds: 60,
  });

  const handlePhaseTransition = (newPhase: BoardPhase) => {
    const client = clientRef.current;
    if (!client) return;
    
    const state = client.getSnapshot();
    if (state.status !== "ready") return;

    client.sendCommand({
      ...state.identity,
      type: "phase.transition",
      requestId: crypto.randomUUID(),
      phase: newPhase,
    });
  };

  const handleFlipCard = (cardId: string) => {
    const client = clientRef.current;
    if (!client || !gameState) return;
    
    const state = client.getSnapshot();
    if (state.status !== "ready") return;

    client.sendCommand({
      ...state.identity,
      type: "game.flip",
      requestId: crypto.randomUUID(),
      cardId,
    });
  };

  return (
    <div
      style={{
        height: "100vh",
        width: "100vw",
        background: "#f7f9fc",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* ヘッダー */}
      <div
        style={{
          padding: "16px 24px",
          background: "#fff",
          borderBottom: "1px solid #eee",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button
            onClick={() => router.push("/")}
            style={{
              padding: "8px 12px",
              border: "1px solid #eee",
              borderRadius: 8,
              background: "#fff",
              color: "#555",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            ← ホーム
          </button>
          <div>
            <span style={{ fontSize: 12, color: "#666" }}>ルーム:</span>
            <span style={{ fontSize: 14, fontWeight: 600, marginLeft: 4 }}>
              {roomId}
            </span>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 13, color: "#666" }}>フェーズ:</span>
          <button
            onClick={() => handlePhaseTransition("word-generation")}
            style={{
              padding: "6px 12px",
              border: phase === "word-generation" ? "2px solid #4778e6" : "1px solid #ddd",
              borderRadius: 6,
              background: phase === "word-generation" ? "#eef2ff" : "#fff",
              color: "#333",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            単語出し
          </button>
          <button
            onClick={() => handlePhaseTransition("idea-generation")}
            style={{
              padding: "6px 12px",
              border: phase === "idea-generation" ? "2px solid #4778e6" : "1px solid #ddd",
              borderRadius: 6,
              background: phase === "idea-generation" ? "#eef2ff" : "#fff",
              color: "#333",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            アイデア出し
          </button>
          <button
            onClick={() => handlePhaseTransition("evaluation")}
            style={{
              padding: "6px 12px",
              border: phase === "evaluation" ? "2px solid #4778e6" : "1px solid #ddd",
              borderRadius: 6,
              background: phase === "evaluation" ? "#eef2ff" : "#fff",
              color: "#333",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            評価
          </button>
        </div>
      </div>

      {/* ボードエリア */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 16,
          color: "#666",
          position: "relative",
        }}
      >
        {phase === "word-generation" && (
          <div>
            <p>単語出しフェーズ - ボード上の単語を使って神経衰劣</p>
            <p style={{ fontSize: 14, marginTop: 8 }}>アイデア出しフェーズに移動するとゲームが開始されます</p>
          </div>
        )}
        
        {phase === "idea-generation" && gameState && (
          <div style={{ width: "100%", height: "100%", padding: 20 }}>
            <div style={{ marginBottom: 16, fontSize: 14 }}>
              現在のプレイヤー: {gameState.players[gameState.currentPlayerIndex] || "なし"}
              {gameState.isProcessing && " (判定中...)"}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 12,
                maxWidth: 900,
                margin: "0 auto",
              }}
            >
              {gameState.cards.map((card) => (
                <div
                  key={card.cardId}
                  onClick={() => !card.isFaceUp && !card.isMatched && !gameState.isProcessing && handleFlipCard(card.cardId)}
                  style={{
                    width: 150,
                    height: 100,
                    background: card.isFaceUp ? "#fff" : "#4778e6",
                    border: "2px solid #ddd",
                    borderRadius: 8,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 16,
                    fontWeight: 600,
                    color: card.isFaceUp ? "#333" : "#fff",
                    cursor: (!card.isFaceUp && !card.isMatched && !gameState.isProcessing) ? "pointer" : "default",
                    opacity: card.isMatched ? 0.5 : 1,
                    transition: "all 0.3s",
                  }}
                >
                  {card.isFaceUp ? card.word : "❓"}
                </div>
              ))}
            </div>
          </div>
        )}
        
        {phase === "idea-generation" && !gameState && (
          <div>ゲーム初期化中...</div>
        )}
        
        {phase === "evaluation" && "評価フェーズ - アイデアを評価・投票"}
      </div>
    </div>
  );
}

export default function RoomPage() {
  return (
    <ReactFlowProvider>
      <Suspense fallback={<div className="flex h-screen items-center justify-center">読み込み中...</div>}>
        <Board />
      </Suspense>
    </ReactFlowProvider>
  );
}
