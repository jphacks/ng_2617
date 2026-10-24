import 'server-only';
import type { BoardEvent } from '@/domain/board-protocol';

type Snapshot = Extract<BoardEvent, { type: 'board.snapshot' }>;

// 単一プロセス用の初期実装。再起動すると初期状態へ戻る。
const boards = new Map<string, Snapshot>([
  ['demo', {
    type: 'board.snapshot', revision: 0,
    board: {
      boardId: 'demo',
      cards: [{
        cardId: '1', shape: 'rectangle', position: { x: 250, y: 150, z: 0 },
        color: '#ffffff', text: '💡 ブレインストーミング起点 (例: カフェ)', font: 'sans-serif',
      }],
    },
  }],
]);

export function getBoardSnapshot(boardId: string): Snapshot | undefined {
  const snapshot = boards.get(boardId);
  return snapshot ? structuredClone(snapshot) : undefined;
}
