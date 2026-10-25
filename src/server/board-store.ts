import 'server-only';
import { createSample } from '../domain/board';
import { createBoardService } from './board-service';

// HTTPとSSEで同じプロセス内の保存領域を使う。再起動で初期化される。
const processStore = globalThis as typeof globalThis & { integratedBoardService?: ReturnType<typeof createBoardService> };
const service = processStore.integratedBoardService ??= createBoardService([createSample('demo')]);
// HMR後も旧サービスが残る場合、未対応の読み込みを通常の400として扱わない。
export const supportsBoardImport = service.supportsBoardImport === true;
export const supportsMatching = service.supportsMatching === true;
export const supportsBoardSettings = service.supportsBoardSettings === true;
export const supportsBoardLeave = service.supportsBoardLeave === true;
export const { getBoardSnapshot, ensureBoard, executeCommand, executeEdit, requestEdit, commitEdit, cancelEdit, replyToEditCheck, subscribeBoard } = service;
