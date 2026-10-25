"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const [roomId, setRoomId] = useState("");
  const router = useRouter();

  const handleJoin = () => {
    const trimmedRoomId = roomId.trim();
    if (trimmedRoomId) {
      router.push(`/room/${encodeURIComponent(trimmedRoomId)}`);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      handleJoin();
    }
  };

  return (
    <div
      style={{
        height: "100vh",
        width: "100vw",
        background: "#f7f9fc",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily:
          'Inter, "Noto Sans JP", -apple-system, BlinkMacSystemFont, sans-serif',
      }}
    >
      <div
        style={{
          background: "#fff",
          padding: "48px 64px",
          borderRadius: 16,
          boxShadow: "0 8px 32px #00000010",
          maxWidth: 480,
          width: "100%",
        }}
      >
        <h1
          style={{
            fontSize: 28,
            fontWeight: 700,
            color: "#111", // 少し濃くしました
            marginBottom: 12,
            textAlign: "center",
          }}
        >
          ブレインストーミング ボード
        </h1>
        <p
          style={{
            fontSize: 14,
            color: "#555", // 少し濃くしました
            marginBottom: 32,
            textAlign: "center",
          }}
        >
          ルームIDを入力して共同編集を開始
        </p>

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

        <div
          style={{
            marginTop: 24,
            paddingTop: 24,
            borderTop: "1px solid #eee",
            fontSize: 12,
            color: "#666", // 注釈も少し読みやすく濃くしました
            textAlign: "center",
          }}
        >
          <p style={{ marginBottom: 8 }}>
            同じルームIDを共有しているユーザーとリアルタイムで共同編集できます
          </p>
        </div>
      </div>
    </div>
  );
}