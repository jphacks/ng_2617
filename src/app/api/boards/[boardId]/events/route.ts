import { connection } from 'next/server';
import { getBoardSnapshot, subscribeBoard } from '@/server/board-store';
import { boardEventResponse } from '@/server/board-events';

export async function GET(request: Request, { params }: { params: Promise<{ boardId: string }> }) {
  await connection();
  const { boardId } = await params;
  const search = new URL(request.url).searchParams;
  return boardEventResponse(request, {
    boardId, userId: search.get('userId') ?? '', clientId: search.get('clientId') ?? '',
  }, { getBoardSnapshot, subscribeBoard });
}
