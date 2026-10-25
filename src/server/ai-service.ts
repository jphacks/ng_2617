import type { Board, RelationLevel } from '../domain/board';
import { generateWordsByGemini } from './AIapi.ts';
import { WORD_ADDITION_COUNT } from './edit-lifecycle.ts';

/** 手動・自動生成の共通窓口。カードの本文だけを、量を制限してGeminiへ送る。 */
export async function generateWordSuggestions(board: Board, level: RelationLevel): Promise<string[]> {
  const existing = new Set(board.cards.map(card => card.text.trim()).filter(Boolean));
  if (!existing.size) return [];
  const words: string[] = [];
  let remaining = 10_000;
  for (const text of existing) {
    if (words.length >= 100 || remaining <= 0) break;
    const word = text.slice(0, Math.min(300, remaining));
    words.push(word);
    remaining -= word.length;
  }
  const suggestions = await generateWordsByGemini(words, level, WORD_ADDITION_COUNT);
  return suggestions.filter(word => !existing.has(word));
}
