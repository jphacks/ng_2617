import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { Board } from '@/components/Board';
import { validId } from '@/domain/board-validation';

async function Room({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  if (!validId(roomId)) notFound();
  return <Board boardId={roomId} />;
}
export default function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  return <Suspense fallback={<div className="board-loading">ルームを読み込み中…</div>}><Room params={params} /></Suspense>;
}
