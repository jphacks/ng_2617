import type { Board, RelationLevel } from '../domain/board';

/** モック生成。外部AIへ接続する場合もボードと関連性を受け取るこの窓口を使用する。 */
export async function generateWordSuggestions(board: Board, level: RelationLevel): Promise<string[]> {
  const pools: Record<RelationLevel, string[]> = {
    low: ['宇宙旅行', '深海', 'オーケストラ', '季節の便り', '秘密基地', '冒険', '星座', 'タイムカプセル'],
    mid: ['地域のつながり', '体験', '居心地', '発見', '習慣', '交流', '時間', '空間'],
    high: ['利用シーン', '使いやすさ', '価値', '満足度', '改善', '目的', 'ニーズ', '課題解決'],
  };
  const existing = new Set(board.cards.map(card => card.text.trim()));
  return pools[level].filter(word => !existing.has(word)).sort(() => Math.random() - 0.5).slice(0, 3);
}
