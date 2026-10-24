import { connection } from 'next/server';
import { getBoardSnapshot } from '@/server/board-store';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ boardId: string }> },
) {
  await connection();
  const { boardId } = await params;
  const snapshot = getBoardSnapshot(boardId);
  const headers = { 'Cache-Control': 'no-store' };
  if (!snapshot) {
    return Response.json({ error: 'ボードが見つかりません。' }, { status: 404, headers });
  }
  return Response.json(snapshot, { headers });
}
