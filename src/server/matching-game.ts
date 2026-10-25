import type { Board, BlockCard } from '../domain/board';
import { createEmptyCard } from '../domain/board.ts';
import { MATCHING_SLOT_COUNT, type MatchingGame } from '../domain/matching.ts';

export function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
export function newMatchingGame(board: Board, userId: string, random: () => number): MatchingGame {
  const copies = board.cards.map(card => ({ copyId: crypto.randomUUID(), card: structuredClone(card) }));
  const eligible = shuffled(copies.filter(copy => copy.card.cardKind === 'word' && copy.card.text.trim()).map(copy => copy.copyId), random);
  return {
    gameId: crypto.randomUUID(), turnId: crypto.randomUUID(), step: 'selecting', selectorUserId: userId, copies,
    slots: Array.from({ length: MATCHING_SLOT_COUNT }, (_, i) => eligible[i] ?? null), reserve: eligible.slice(MATCHING_SLOT_COUNT),
    selected: [], used: [], drafts: [], addedCardIds: [], notice: 'ゲームを開始しました。2枚の単語を選びましょう。',
  };
}
export function newMatchingDraft(game: MatchingGame, userId: string, clientId: string) {
  const card: BlockCard = {
    ...createEmptyCard('block', { x: 0, y: 0, z: 0 }, '#DDF5D7'), cardKind: 'block', reactions: [],
    relatedIds: game.selected.map(id => game.copies.find(copy => copy.copyId === id)!.card.cardId),
  };
  return { userId, writerClientId: clientId, writerToken: crypto.randomUUID(), sequence: 0, finalized: false, card };
}
export function consumeSelected(game: MatchingGame): MatchingGame {
  const reserve = [...game.reserve];
  return { ...game, used: [...game.used, ...game.selected],
    slots: game.slots.map(id => id && game.selected.includes(id) ? reserve.shift() ?? null : id), reserve };
}
