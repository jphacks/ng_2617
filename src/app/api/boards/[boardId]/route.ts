import { connection } from 'next/server';
import { getBoardSnapshot, executeCommand, ensureBoard } from '@/server/board-store';

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
  let command: unknown;
  try {
    command = await request.json();
  } catch {
    return Response.json({ error: 'JSONが不正です。' }, { status: 400, headers });
  }
  const { boardId } = await params;
  const result = executeCommand(command, boardId);
  return Response.json(result.body, { status: result.status, headers });
}
