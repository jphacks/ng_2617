import type { Board } from '../domain/board';

/** 共有タイマーが0秒へ遷移した際の拡張点。業務処理は今後ここに追加する。 */
export function onTimerFinished(board: Board): void {
  void board;
}
