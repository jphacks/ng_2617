import type { Board, BlockCard, WordCard } from './board';

export const BOARD_FILE_FORMAT = 'brainstorm-board';
export const BOARD_FILE_VERSION = 1;
export const MAX_BOARD_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_BOARD_FILE_CARDS = 10_000;
export const MAX_BOARD_FILE_ARROWS = 10_000;
// 有限でも極端な座標はSVGの範囲計算を壊すため、入出力の座標を制限する。
export const MAX_BOARD_FILE_COORDINATE = 1_000_000;
export type BoardFile = Readonly<{
  format: typeof BOARD_FILE_FORMAT;
  version: typeof BOARD_FILE_VERSION;
  cards: readonly (Omit<WordCard, 'editingUser'> | Omit<BlockCard, 'editingUser'>)[];
  arrows: Board['arrows'];
}>;
