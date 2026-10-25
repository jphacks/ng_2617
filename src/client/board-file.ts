import type { Board } from '../domain/board';
import { BOARD_FILE_FORMAT, BOARD_FILE_VERSION, MAX_BOARD_FILE_BYTES, type BoardFile } from '../domain/board-file.ts';
import { validBoardFile } from '../domain/board-validation.ts';
export type { BoardFile } from '../domain/board-file';

export function createBoardFile(board: Board): BoardFile {
  const file: BoardFile = {
    format: BOARD_FILE_FORMAT, version: BOARD_FILE_VERSION,
    cards: board.cards.map(card => { const saved = { ...structuredClone(card) }; delete saved.editingUser; return saved; }),
    arrows: structuredClone(board.arrows),
  };
  if (!validBoardFile(file)) throw new Error('保存できないボードです。内容・参照・サイズの上限を確認してください（最大5 MiB）。');
  return file;
}

export function parseBoardFile(text: string): BoardFile {
  if (new TextEncoder().encode(text).byteLength > MAX_BOARD_FILE_BYTES) throw new Error('ファイルは5 MiB以下にしてください。');
  if (!text.trim()) throw new Error('ファイルの中身が空です。ボードのメニューの「JSONで保存」で作成したファイルを選んでください。空の付箋やカード0枚のボードは読み込めます。');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('JSONの形式が正しくありません。'); }
  if (!validBoardFile(value)) throw new Error('対応していない形式・バージョン、または不正なカード・参照・サイズが含まれています。');
  return value;
}

export async function readBoardFile(file: Pick<File, 'size' | 'text'>): Promise<BoardFile> {
  if (file.size > MAX_BOARD_FILE_BYTES) throw new Error('ファイルは5 MiB以下にしてください。');
  let text: string;
  try { text = await file.text(); } catch { throw new Error('ファイルを読み込めませんでした。もう一度選択してください。'); }
  return parseBoardFile(text);
}

export function downloadBoardJson(board: Board): void {
  downloadBlob(new Blob([JSON.stringify(createBoardFile(board))], { type: 'application/json;charset=utf-8' }),
    `brainstorm-board-${timestamp()}.json`);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  try {
    link.href = url; link.download = filename; link.style.display = 'none';
    document.body.appendChild(link); link.click();
  } finally {
    link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function timestamp(): string {
  const date = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
