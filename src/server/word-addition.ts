import type { Board, Card } from '../domain/board';

/** 候補の検証・重複除去・配置だけを担当し、ボードやタイマーは変更しない。 */
export function suggestionCards(board: Board, words: readonly string[], count: number): Card[] {
  const seen = new Set(board.cards.map(card => card.text.trim()));
  const selected: string[] = [];
  for (const word of words) {
    if (typeof word !== 'string' || !word.trim() || word.length > 100_000 || seen.has(word.trim())) continue;
    seen.add(word.trim());
    selected.push(word.trim());
    if (selected.length === count) break;
  }
  // 既存カードの右側へ縦に並べ、ランダム配置による重なりを避ける。
  const x = board.cards.reduce((max, card) => Math.max(max, card.position.x), 0) + 260;
  const y = board.cards.reduce((min, card) => Math.min(min, card.position.y), 150);
  const z = board.cards.reduce((max, card) => Math.max(max, card.position.z), -1) + 1;
  return selected.map((text, index) => ({
    cardId: crypto.randomUUID(), shape: 'rectangle',
    position: { x, y: y + index * 140, z: z + index },
    color: '#f0f0f0', text, font: 'sans-serif',
  }));
}
