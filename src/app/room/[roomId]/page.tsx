"use client";

import { Suspense } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Board } from "@/components/Board";

export default function RoomPage() {
  return (
    <ReactFlowProvider>
      <Suspense fallback={<div className="flex h-screen items-center justify-center">読み込み中...</div>}>
        <Board />
      </Suspense>
    </ReactFlowProvider>
  );
}
