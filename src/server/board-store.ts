import 'server-only';
import { createSample } from '../domain/board';
import { createBoardService } from './board-service';

// HTTPとSSEで同じプロセス内の保存領域を使う。再起動で初期化される。
const processStore = globalThis as typeof globalThis & { integratedBoardService?: ReturnType<typeof createBoardService> };
const service = processStore.integratedBoardService ??= createBoardService([createSample('demo')]);
export const { getBoardSnapshot, ensureBoard, executeCommand, executeEdit, requestEdit, commitEdit, cancelEdit, replyToEditCheck, subscribeBoard } = service;
