import type { Board, Card } from './board';

/** 通信形式の暫定契約。認証情報ではなく、要求の送信先・対応を識別する情報。 */
export type ClientIdentity = Readonly<{
  boardId: string;
  userId: string;
  clientId: string;
}>;

/** 編集者やカードIDは下書きから変更できない。 */
export type CardContent = Omit<Card, 'cardId' | 'editingUser'>;

type Request = ClientIdentity & Readonly<{ requestId: string }>;
export type BoardCommand = Request & (
  | { type: 'board.get' }
  | { type: 'edit.request'; cardId: string }
  | { type: 'edit.commit'; cardId: string; lockId: string; content: CardContent }
  | { type: 'edit.cancel'; cardId: string; lockId: string }
  | ({ type: 'edit.check.reply'; cardId: string; lockId: string; checkId: string } & (
    | { changed: true; content: CardContent }
    | { changed: false }
  ))
);

/**
 * 初期実装では全体スナップショットを配信する。
 * revisionはボード単位で単調増加。変更がない拒否応答では同じ値を使える。
 */
type Snapshot = Readonly<{ board: Board; revision: number }>;
type Reply = Readonly<{ clientId: string; requestId: string; cardId: string }>;
export type BoardEvent = Snapshot & (
  | { type: 'board.snapshot' }
  | (Reply & { type: 'edit.granted'; lockId: string })
  | (Reply & { type: 'edit.rejected'; reason: string })
  | (Reply & { type: 'edit.committed' | 'edit.cancelled' })
  | (Reply & { type: 'edit.checked'; lockId: string; checkId: string; outcome: 'saved' | 'released' })
  | { type: 'edit.check'; userId: string; clientId: string; cardId: string; lockId: string; checkId: string }
  | { type: 'edit.released'; userId: string; clientId: string; cardId: string; lockId: string; reason: 'timeout' }
);

export function cardContent(card: Card): CardContent {
  return { shape: card.shape, position: { ...card.position }, color: card.color, text: card.text, font: card.font };
}

/** JSONのキー順序に依存せず、最後に保存した5属性と下書きを比較する。 */
export function sameCardContent(a: CardContent, b: CardContent): boolean {
  return a.shape === b.shape && a.color === b.color && a.text === b.text && a.font === b.font &&
    a.position.x === b.position.x && a.position.y === b.position.y && a.position.z === b.position.z;
}
