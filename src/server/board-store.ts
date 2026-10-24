import 'server-only';
import { createBoardService } from './board-service';

// 単一プロセス用。再起動・開発中の再読み込みで初期状態に戻る。
const service = createBoardService([{
  boardId: 'demo',
  cards: [{
    cardId: '1', shape: 'rectangle', position: { x: 250, y: 150, z: 0 },
    color: '#ffffff', text: '💡 ブレインストーミング起点 (例: カフェ)', font: 'sans-serif',
  }],
}]);

export const { getBoardSnapshot, executeEdit, requestEdit, commitEdit, cancelEdit } = service;
