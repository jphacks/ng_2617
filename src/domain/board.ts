/** JSONで共有するモデル。選択・仮移動・表示範囲はここに保存しない。 */
export type BoardObjectId = Readonly<{ type: 'card'; uuid: string }> | Readonly<{ type: 'arrow'; uuid: string }>;
export type CardId = Extract<BoardObjectId, { type: 'card' }>;
export type ArrowId = Extract<BoardObjectId, { type: 'arrow' }>;
export type UserId = string;
export type User = Readonly<{ userId: UserId }>;
export type ReactionId = string;
export type Reaction = Readonly<{ reactionId: ReactionId; icon: string; altText: string }>;
export type CardReaction = Readonly<{ reactionId: ReactionId; userId: UserId }>;
export type CardShape = Readonly<{ width: number; height: number }>;
export type CardPosition = Readonly<{ x: number; y: number; z: number }>;
export type CardCommon = Readonly<{
  cardId: CardId; shape: CardShape; position: CardPosition;
  color: string; font: string; text: string; editingUser?: User;
}>;
export type WordCard = CardCommon & Readonly<{ cardKind: 'word' }>;
export type BlockCard = CardCommon & Readonly<{
  cardKind: 'block'; relatedIds: readonly CardId[]; reactions: readonly CardReaction[];
}>;
export type Card = WordCard | BlockCard;
export type Anchor = 'north' | 'east' | 'south' | 'west';
export type Arrow = Readonly<{
  arrowId: ArrowId; sourceCardId: CardId; targetCardId: CardId;
  sourceAnchor: Anchor; targetAnchor: Anchor;
}>;
export type BoardTimer = Readonly<{ durationMs: number }> & (
  | Readonly<{ state: 'stopped'; remainingMs: number }>
  | Readonly<{ state: 'running'; endsAt: number }>
);
export type Board = Readonly<{
  boardId: string; cards: readonly Card[]; arrows: readonly Arrow[]; timer: BoardTimer;
}>;
export type RelationLevel = 'low' | 'mid' | 'high';

export const CARD_SIZES = {
  word: { width: 210, height: 210, minWidth: 160, minHeight: 150 },
  block: { width: 310, height: 330, minWidth: 260, minHeight: 280 },
} as const;
export const MAX_CARD_SIZE = 2000;
export const TIMER_DURATION_MS = 300_000;
export const REACTIONS: readonly Reaction[] = [
  { reactionId: 'thumbs-up', icon: '👍', altText: 'いいね' },
  { reactionId: 'heart', icon: '❤️', altText: '好き' },
  { reactionId: 'idea', icon: '💡', altText: 'ひらめき' },
  { reactionId: 'thinking', icon: '🤔', altText: '考え中' },
  { reactionId: 'celebrate', icon: '🎉', altText: 'すばらしい' },
];

export const objectKey = (id: BoardObjectId): string => `${id.type}:${id.uuid}`;
export const sameObjectId = (a: BoardObjectId, b: BoardObjectId): boolean => a.type === b.type && a.uuid === b.uuid;
export const newCardId = (): CardId => ({ type: 'card', uuid: crypto.randomUUID() });
export const newArrowId = (): ArrowId => ({ type: 'arrow', uuid: crypto.randomUUID() });

export function createBoard(boardId: string): Board {
  return { boardId, cards: [], arrows: [], timer: { durationMs: TIMER_DURATION_MS, state: 'stopped', remainingMs: TIMER_DURATION_MS } };
}
export function createEmptyCard(cardKind: Card['cardKind'], position: CardPosition, color = '#FFF0A8', cardId = newCardId()): Card {
  const { width, height } = CARD_SIZES[cardKind];
  const common = { cardId, shape: { width, height }, position: { ...position }, color, font: 'sans-serif', text: '' };
  return cardKind === 'word' ? { ...common, cardKind } : { ...common, cardKind, relatedIds: [], reactions: [] };
}
export function getCard(board: Board, cardId: CardId): Card | undefined {
  return board.cards.find(card => sameObjectId(card.cardId, cardId));
}
export function addCard(board: Board, card: Card): Board {
  if (getCard(board, card.cardId)) throw new Error(`Card already exists: ${objectKey(card.cardId)}`);
  return { ...board, cards: [...board.cards, card] };
}
export function replaceCard(board: Board, card: Card): Board {
  if (!getCard(board, card.cardId)) throw new Error(`Card not found: ${objectKey(card.cardId)}`);
  return { ...board, cards: board.cards.map(current => sameObjectId(current.cardId, card.cardId) ? card : current) };
}
/** 削除に伴う参照・接続の除去も同じ純粋操作に含める。 */
export function removeObjects(board: Board, ids: readonly BoardObjectId[]): Board {
  const removed = new Set(ids.map(objectKey));
  return {
    ...board,
    cards: board.cards.filter(card => !removed.has(objectKey(card.cardId))).map(card => card.cardKind === 'block'
      ? { ...card, relatedIds: card.relatedIds.filter(id => !removed.has(objectKey(id))) } : card),
    arrows: board.arrows.filter(arrow => !removed.has(objectKey(arrow.arrowId)) &&
      !removed.has(objectKey(arrow.sourceCardId)) && !removed.has(objectKey(arrow.targetCardId))),
  };
}
export function removeCard(board: Board, cardId: CardId): Board {
  if (!getCard(board, cardId)) throw new Error(`Card not found: ${objectKey(cardId)}`);
  return removeObjects(board, [cardId]);
}
/** カード枚数ではなく、候補生成に使える本文の有無。 */
export const isEmpty = (board: Board): boolean => board.cards.every(card => !card.text.trim());

/** 復元ごとにIDを発行し、参照と矢印もそのIDへ接続する。 */
export function createSample(boardId: string): Board {
  const theme = { ...createEmptyCard('word', { x: 150, y: 140, z: 0 }), text: 'ブレストのテーマ' };
  const problem = { ...createEmptyCard('word', { x: 440, y: 140, z: 1 }, '#D9E9FF'), text: '利用者の困りごと' };
  const block: BlockCard = {
    ...createEmptyCard('block', { x: 740, y: 120, z: 2 }, '#DDF5D7'),
    cardKind: 'block', text: '複数のアイデアをまとめる', relatedIds: [theme.cardId, problem.cardId], reactions: [],
  };
  return { ...createBoard(boardId), cards: [theme, problem, block], arrows: [{
    arrowId: newArrowId(), sourceCardId: theme.cardId, targetCardId: problem.cardId, sourceAnchor: 'east', targetAnchor: 'west',
  }] };
}
