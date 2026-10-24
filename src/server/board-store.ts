import 'server-only';
import { createBoardService } from './board-service';

// HTTPとSSEのRoute Handler間で同じ保存領域を使う。プロセス再起動時は初期化される。
const processStore = globalThis as typeof globalThis & {
  editLifecycleBoardService?: ReturnType<typeof createBoardService>;
};
const service = processStore.editLifecycleBoardService ??= createBoardService([{
  boardId: 'demo',
  cards: [{
    cardId: '1', shape: 'rectangle', position: { x: 250, y: 150, z: 0 },
    color: '#ffffff', text: '💡 ブレインストーミング起点 (例: カフェ)', font: 'sans-serif',
  }],
}]);

export const { getBoardSnapshot, executeEdit, requestEdit, commitEdit, cancelEdit, replyToEditCheck, subscribeBoard } = service;
