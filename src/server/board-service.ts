import type { Board, Card } from '../domain/board';
import type { BoardCommand, BoardEvent, CardContent } from '../domain/board-protocol';

type EditCommand = Exclude<BoardCommand, { type: 'board.get' }>;
type Snapshot = Extract<BoardEvent, { type: 'board.snapshot' }>;
export type EditResult = { status: number; body: BoardEvent | { error: string } };
type Lock = { userId: string; clientId: string; lockId: string; expiresAt: number };
type Entry = { board: Board; revision: number; locks: Map<string, Lock> };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}
function content(value: unknown): value is CardContent {
  return record(value) && Object.keys(value).every(key =>
    ['shape', 'position', 'color', 'text', 'font'].includes(key)) &&
    typeof value.shape === 'string' && value.shape.length <= 128 &&
    typeof value.color === 'string' && value.color.length <= 128 &&
    typeof value.font === 'string' && value.font.length <= 256 &&
    typeof value.text === 'string' && value.text.length <= 100_000 &&
    record(value.position) && Object.keys(value.position).every(key => ['x', 'y', 'z'].includes(key)) &&
    [value.position.x, value.position.y, value.position.z].every(n => typeof n === 'number' && Number.isFinite(n));
}
function editCommand(value: unknown): value is EditCommand {
  if (!record(value) || ![value.boardId, value.userId, value.clientId, value.requestId, value.cardId].every(id)) return false;
  return value.type === 'edit.request' ||
    (value.type === 'edit.cancel' && id(value.lockId)) ||
    (value.type === 'edit.commit' && id(value.lockId) && content(value.content));
}

/** 単一プロセスの同期処理。検証〜更新の間にawaitを入れず、競合確認と確定を一体にする。 */
export function createBoardService(
  initialBoards: readonly Board[],
  options: { now?: () => number; createLockId?: () => string; lockTtlMs?: number } = {},
) {
  const now = options.now ?? Date.now;
  const createLockId = options.createLockId ?? (() => crypto.randomUUID());
  const lockTtlMs = options.lockTtlMs ?? 5 * 60_000;
  if (!Number.isFinite(lockTtlMs) || lockTtlMs <= 0) throw new Error('Invalid lock TTL');
  const boards = new Map<string, Entry>(initialBoards.map(board => [board.boardId, {
    board: structuredClone(board), revision: 0, locks: new Map(),
  }]));

  function replace(entry: Entry, card: Card) {
    entry.board = { ...entry.board, cards: entry.board.cards.map(current => current.cardId === card.cardId ? card : current) };
    entry.revision += 1;
  }
  function withoutEditor(card: Card): Card {
    return { cardId: card.cardId, shape: card.shape, position: { ...card.position }, color: card.color, text: card.text, font: card.font };
  }
  function expire(entry: Entry) {
    const time = now();
    for (const [cardId, lock] of entry.locks) {
      if (lock.expiresAt <= time) {
        entry.locks.delete(cardId);
        const card = entry.board.cards.find(item => item.cardId === cardId);
        if (card) replace(entry, withoutEditor(card));
      }
    }
  }
  function snapshot(entry: Entry): Snapshot {
    return { type: 'board.snapshot', board: structuredClone(entry.board), revision: entry.revision };
  }
  function executeEdit(input: unknown, expectedBoardId?: string): EditResult {
    if (!editCommand(input) || (expectedBoardId !== undefined && input.boardId !== expectedBoardId)) {
      return { status: 400, body: { error: '編集要求の形式またはボードIDが不正です。' } };
    }
    // 呼び出し側が保持するオブジェクトを保存領域へ持ち込まない。
    const command = structuredClone(input);
    const entry = boards.get(command.boardId);
    if (!entry) return { status: 404, body: { error: 'ボードが見つかりません。' } };
    expire(entry);
    const reply = { clientId: command.clientId, requestId: command.requestId, cardId: command.cardId };
    const reject = (status: number, reason: string): EditResult => ({
      status, body: { ...snapshot(entry), ...reply, type: 'edit.rejected', reason },
    });
    const card = entry.board.cards.find(item => item.cardId === command.cardId);
    if (!card) return reject(404, 'カードが見つかりません。');
    const lock = entry.locks.get(command.cardId);
    if (command.type === 'edit.request') {
      if (lock || card.editingUser) return reject(409, 'このカードは既に編集中です。');
      const lockId = createLockId();
      entry.locks.set(card.cardId, {
        userId: command.userId, clientId: command.clientId, lockId, expiresAt: now() + lockTtlMs,
      });
      replace(entry, { ...card, editingUser: { userId: command.userId } });
      return { status: 200, body: { ...snapshot(entry), ...reply, type: 'edit.granted', lockId } };
    }
    if (!lock || lock.userId !== command.userId || lock.clientId !== command.clientId || lock.lockId !== command.lockId) {
      return reject(403, '有効な編集権がありません。再度編集許可を取得してください。');
    }
    // 内容の確定とロック解除を、1回の更新として反映する。
    const nextCard = command.type === 'edit.commit'
      ? { ...command.content, cardId: card.cardId }
      : withoutEditor(card);
    replace(entry, nextCard);
    entry.locks.delete(card.cardId);
    return {
      status: 200,
      body: { ...snapshot(entry), ...reply, type: command.type === 'edit.commit' ? 'edit.committed' : 'edit.cancelled' },
    };
  }
  return {
    getBoardSnapshot(boardId: string): Snapshot | undefined {
      const entry = boards.get(boardId);
      if (!entry) return undefined;
      expire(entry);
      return snapshot(entry);
    },
    executeEdit,
    requestEdit(command: Extract<EditCommand, { type: 'edit.request' }>) { return executeEdit(command); },
    commitEdit(command: Extract<EditCommand, { type: 'edit.commit' }>) { return executeEdit(command); },
    cancelEdit(command: Extract<EditCommand, { type: 'edit.cancel' }>) { return executeEdit(command); },
  };
}
