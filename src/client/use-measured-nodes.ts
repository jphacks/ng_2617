'use client';

import { useCallback, useMemo, useState } from 'react';
import { applyNodeChanges, type Node, type NodeChange } from '@xyflow/react';

/** 共有ボードからノードを作り直しても、DOMで計測したサイズは端末側で保持する。 */
export function useMeasuredNodes<NodeType extends Node>(sourceNodes: NodeType[]) {
  const [measurements, setMeasurements] = useState<ReadonlyMap<string, NonNullable<Node['measured']>>>(() => new Map());
  const nodes = useMemo(() => sourceNodes.map(node => {
    const measured = measurements.get(node.id);
    return measured ? { ...node, measured } : node;
  }), [sourceNodes, measurements]);

  const onNodesChange = useCallback((changes: NodeChange<NodeType>[]) => {
    const dimensions = changes.filter(change => change.type === 'dimensions');
    if (!dimensions.length) return;
    setMeasurements(previous => {
      const current = sourceNodes.map(node => ({ ...node, measured: previous.get(node.id) ?? node.measured }));
      const updated = applyNodeChanges(dimensions, current);
      const next = new Map(updated.flatMap(node => node.measured ? [[node.id, node.measured] as const] : []));
      if (previous.size === next.size && [...next].every(([id, measured]) => {
        const before = previous.get(id);
        return before?.width === measured.width && before?.height === measured.height;
      })) return previous;
      return next;
    });
  }, [sourceNodes]);

  return { nodes, onNodesChange };
}
