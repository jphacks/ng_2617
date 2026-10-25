'use client';

import { useEffect, useRef } from 'react';
import type { BoardFile } from '@/domain/board-file';

export function ImportBoardDialog({ candidate, onCancel, onConfirm }: {
  candidate: { name: string; file: BoardFile }; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="import-dialog panel" aria-labelledby="import-title"
    onKeyDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); onCancel(); }}>
    <h2 id="import-title">ボードを読み込みますか？</h2>
    <p className="import-filename">{candidate.name}</p>
    <p>カード {candidate.file.cards.length}枚・矢印 {candidate.file.arrows.length}本</p>
    <p>このルームのカードと矢印を置き換えます。参加者全員のボードに反映されます。必要な内容は先にJSONで保存してください。</p>
    <p>共有タイマーはそのまま維持されます。誰かが編集中の場合は読み込めません。</p>
    <div className="import-dialog-actions"><button type="button" onClick={onCancel} autoFocus>取消</button>
      <button type="button" className="primary" onClick={onConfirm}>置き換えて読み込む</button></div>
  </dialog>;
}
