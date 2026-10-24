/** クライアント・サーバー共通の、JSONで送受信できるボード情報。 */
export type User = Readonly<{
  userId: string;
}>;

export type CardPosition = Readonly<{
  x: number;
  y: number;
  /** 描画順。前後の解釈は表示側で決める。 */
  z: number;
}>;

export type Card = Readonly<{
  cardId: string;
  /** 形状の種類は未確定のため、現時点では文字列で扱う。 */
  shape: string;
  position: CardPosition;
  color: string;
  editingUser?: User;
  text: string;
  font: string;
}>;

export type Board = Readonly<{
  boardId: string;
  cards: readonly Card[];
}>;

/** カードIDはボード内で一意。ID生成は呼び出し側の責務。 */
export function createBoard(boardId: string): Board {
  return { boardId, cards: [] };
}

export function getCard(board: Board, cardId: string): Card | undefined {
  return board.cards.find((card) => card.cardId === cardId);
}

export function addCard(board: Board, card: Card): Board {
  if (getCard(board, card.cardId)) {
    throw new Error(`Card already exists: ${card.cardId}`);
  }
  return { ...board, cards: [...board.cards, card] };
}

/**
 * 確定したカード全体を置換する。入力のボードは変更しない。
 * 編集許可・ロック・入力検証は、将来のサーバーの責務。
 */
export function replaceCard(board: Board, card: Card): Board {
  requireCard(board, card.cardId);
  return {
    ...board,
    cards: board.cards.map((current) =>
      current.cardId === card.cardId ? card : current,
    ),
  };
}

export function removeCard(board: Board, cardId: string): Board {
  requireCard(board, cardId);
  return {
    ...board,
    cards: board.cards.filter((card) => card.cardId !== cardId),
  };
}

function requireCard(board: Board, cardId: string): void {
  if (!getCard(board, cardId)) {
    throw new Error(`Card not found: ${cardId}`);
  }
}
