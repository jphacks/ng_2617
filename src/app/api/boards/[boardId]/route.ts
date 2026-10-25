import { readBoardRequest } from '@/server/board-request';
import { connection } from 'next/server';
import { getBoardSnapshot, executeCommand, ensureBoard, supportsBoardImport, supportsMatching } from '@/server/board-store';
import { record } from '@/domain/board-validation';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ boardId: string }> },
) {
  await connection();
  const { boardId } = await params;
  if (!ensureBoard(boardId)) return Response.json({ error: 'ボードIDが不正です。' }, { status: 400 });
  const snapshot = getBoardSnapshot(boardId);
  const headers = { 'Cache-Control': 'no-store' };
  if (!snapshot) {
    return Response.json({ error: 'ボードが見つかりません。' }, { status: 404, headers });
  }
  return Response.json(snapshot, { headers });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ boardId: string }> },
) {
  const headers = { 'Cache-Control': 'no-store' };
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    return Response.json({ error: 'application/jsonで送信してください。' }, { status: 415, headers });
  }
  const parsed = await readBoardRequest(request);
  if ('error' in parsed) return Response.json({ error: parsed.error }, { status: parsed.status, headers });
  if (record(parsed.value) && parsed.value.type === 'board.import' && !supportsBoardImport) {
    return Response.json({ code: 'SERVER_RESTART_REQUIRED',
      error: '開発サーバーに読み込み未対応の旧処理が残っています。空の付箋は原因ではありません。必要なボードをJSON保存し、開発サーバーを再起動してページを再読み込みしてください。' },
    { status: 503, headers });
  }
  if (record(parsed.value) && typeof parsed.value.type === 'string' && parsed.value.type.startsWith('matching.') && !supportsMatching) {
    return Response.json({ code: 'SERVER_RESTART_REQUIRED',
      error: '開発サーバーに神経衰弱未対応の旧処理が残っています。必要なボードをJSON保存し、開発サーバーを再起動してページを再読み込みしてください。' },
    { status: 503, headers });
  }
  const { boardId } = await params;
  const result = executeCommand(parsed.value, boardId);
  return Response.json(result.body, { status: result.status, headers });
}
