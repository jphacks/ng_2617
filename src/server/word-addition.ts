import type { Board, Card } from '../domain/board';
import { createEmptyCard } from '../domain/board.ts';

/** 候補の検証・重複除去・配置。状態変更や通知はサービスの責務。 */
export function suggestionCards(board: Board, words: readonly string[], count: number): Card[] {
  const seen = new Set(board.cards.map(card => card.text.trim()));
  const selected: string[] = [];
  for (const word of words) {
    if (typeof word !== 'string' || !word.trim() || word.length > 100_000 || seen.has(word.trim())) continue;
    seen.add(word.trim()); selected.push(word.trim());
    if (selected.length >= count) break;
  }
  const x = board.cards.reduce((max, card) => Math.max(max, card.position.x + card.shape.width), 0) + 70;
  const y = board.cards.reduce((min, card) => Math.min(min, card.position.y), 150);
  const z = board.cards.reduce((max, card) => Math.max(max, card.position.z), -1) + 1;
  return selected.map((text, index) => ({
    ...createEmptyCard('word', { x, y: y + index * 250, z: z + index }, '#EADFFF'), text,
  }));
}
