'use client';

import React from 'react';
import { ReactFlow, useNodesState, useEdgesState, Background, Controls } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Edge } from '@xyflow/react';

const initialEdge: Edge[] = [];

// 初期ノード（最初に出しておく起点となる単語）
const initialNodes = [
  {
    id: '1',
    type: 'default',
    data: { label: '💡 ブレインストーミング起点 (例: カフェ)' },
    position: { x: 250, y: 150 },
  },
];

const initialEdges: Edge[] = [];

export default function Home() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  return (
    <main style={{ width: '100vw', height: '100vh' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView
      >
        {/* 背景のドット */}
        <Background gap={16} size={1} />
        {/* 拡大縮小のコントロールボタン */}
        <Controls />
      </ReactFlow>
    </main>
  );
}