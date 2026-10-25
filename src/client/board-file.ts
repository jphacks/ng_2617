import type { Board, Card } from '@/domain/board';

const FILE_FORMAT = 'brainstorm-board';
const FILE_VERSION = 1;

type ExportCard = Omit<Card, 'editingUser'>;

export type BoardFile = {
  format: typeof FILE_FORMAT;
  version: typeof FILE_VERSION;
  cards: ExportCard[];
  arrows: Board['arrows'];
};

export function createBoardFile(board: Board): BoardFile {
  return {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    cards: board.cards.map((card) => {
      const { editingUser: _editingUser, ...saved } = card;
      return structuredClone(saved) as ExportCard;
    }),
    arrows: structuredClone(board.arrows),
  };
}

export function downloadBoardJson(board: Board): void {
  const json = JSON.stringify(createBoardFile(board), null, 2);
  downloadBlob(
    new Blob([json], { type: 'application/json;charset=utf-8' }),
    `brainstorm-board-${timestamp()}.json`,
  );
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  link.style.display = 'none';

  document.body.appendChild(link);
  link.click();
  link.remove();

  // ダウンロード開始後にURLを解放する。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function timestamp(): string {
  const date = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('') + '-' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}