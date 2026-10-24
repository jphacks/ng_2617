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
);
