'use client';

import { useEffect, useRef } from 'react';

export function BoardSettingsDialog({ enabled, pending, ready, onChange, onClose }: {
  enabled: boolean; pending: boolean; ready: boolean;
  onChange: (enabled: boolean) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="board-settings import-dialog panel" aria-labelledby="board-settings-title"
    onKeyDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="panel-title"><h2 id="board-settings-title">ボード設定</h2>
      <button type="button" aria-label="ボード設定を閉じる" onClick={onClose}>×</button></div>
    <label className="board-setting-toggle">
      <span>単語の自動生成</span>
      <input type="checkbox" role="switch" checked={enabled} disabled={!ready || pending}
        onChange={event => onChange(event.target.checked)} />
      <strong aria-hidden="true">{enabled ? 'ON' : 'OFF'}</strong>
    </label>
    <p>全員の編集が終了してから30秒後に、候補語を追加します。この設定はルームの参加者全員に適用されます。</p>
    <p className="muted">OFFでも、AIパネルの「単語を生成」は利用できます。</p>
    <div className="import-dialog-actions"><button type="button" onClick={onClose}>閉じる</button></div>
  </dialog>;
}
