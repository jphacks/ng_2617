import type { BlockCard, Card } from './board';

export const MATCHING_DURATION_MS = 10_000;
export const MATCHING_SLOT_COUNT = 10;
/** 入力時間は延長せず、0秒時点のIME確定と最終送信だけを待つ。 */
export const MATCHING_FINALIZE_MS = 1_000;

export type MatchingDraft = Readonly<{
  userId: string; writerClientId: string; writerToken: string;
  sequence: number; finalized: boolean; card: BlockCard;
}>;
export type MatchingGame = Readonly<{
  gameId: string; turnId: string; step: 'selecting' | 'writing' | 'closing'; selectorUserId: string;
  copies: readonly Readonly<{ copyId: string; card: Card }>[];
  slots: readonly (string | null)[]; reserve: readonly string[]; used: readonly string[];
  selected: readonly string[]; drafts: readonly MatchingDraft[];
  abortConfirmationId?: string; finishAfterClosing?: boolean;
  addedCardIds: readonly import('./board').CardId[];
  notice: string;
}>;
