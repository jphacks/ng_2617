'use client';

import { randomUUID } from '@/domain/uuid';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function Home() {
  const [roomId, setRoomId] = useState('');
  const router = useRouter();
  return <main className="room-entry"><section className="entry-card">
    <div className="entry-symbol" aria-hidden="true">◈</div><h1>Idea Board</h1>
    <p>ひらめきを置いて、つないで、広げよう。</p>
    <form onSubmit={event => { event.preventDefault(); if (roomId.trim()) router.push(`/room/${encodeURIComponent(roomId.trim())}`); }}>
      <label htmlFor="room-id">ルームID</label>
      <input id="room-id" value={roomId} onChange={event => setRoomId(event.target.value)} maxLength={128} placeholder="例：my-room" required autoComplete="off" />
      <button type="submit" className="primary" disabled={!roomId.trim()}>ルームに参加</button>
    </form>
    <button type="button" className="new-room" onClick={() => router.push(`/room/${randomUUID()}`)}>新しいルームを作る</button>
    <Link href="/room/demo">サンプルボードを開く ↗</Link>
    <small>同じルームIDを使うと、みんなで共同編集できます。</small>
  </section></main>;
}
