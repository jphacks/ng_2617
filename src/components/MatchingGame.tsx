'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { BoardClient, BoardClientState } from '@/client/board-client';
import { MATCHING_DURATION_MS } from '@/domain/matching';
import { MatchingTextInput } from './MatchingTextInput';
import { BoardNotice } from './BoardNotice';

function AbortDialog({ ready, onContinue, onEnd }: { ready: boolean; onContinue: () => void; onEnd: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="import-dialog panel" aria-labelledby="matching-abort-title"
    onCancel={event => { event.preventDefault(); if (ready) onContinue(); }}>
    <h2 id="matching-abort-title">神経衰弱を終了しますか？</h2>
    <p>書きかけのアイデアもボードに残します。誰か1人が終了を選ぶと、全員のゲームが終了します。</p>
    <p className="muted">確認中も残り時間は進みます。</p>
    <div className="import-dialog-actions">
      <button type="button" disabled={!ready} onClick={onContinue} autoFocus>続ける</button>
      <button type="button" className="primary" disabled={!ready} onClick={onEnd}>終了する</button>
    </div>
  </dialog>;
}

export function MatchingGame({ client, state }: { client: BoardClient; state: BoardClientState }) {
  const game = state.board!.matching!;
  const timer = state.board!.timer;
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const tick = () => setClock(Date.now());
    tick(); const interval = setInterval(tick, 100); return () => clearInterval(interval);
  }, []);
  const remaining = timer.state === 'running' ? clock ? Math.max(0, timer.endsAt - clock - state.serverOffsetMs) : MATCHING_DURATION_MS : 0;
  const expired = remaining <= 0 || game.step === 'closing';
  const ready = state.status === 'ready';
  const ownTurn = game.selectorUserId === state.identity.userId;
  const own = game.drafts.find(draft => draft.userId === state.identity.userId);
  const input = state.matchingInput;
  const others = game.drafts.filter(draft => draft.userId !== state.identity.userId);
  const pendingSelection = state.pendingCommands.some(command => command.type === 'matching.select' && command.turnId === game.turnId);
  const stage = game.step === 'selecting' ? ownTurn ? 'あなたが選ぶ番' : `${game.selectorUserId.slice(0, 8)}さんが選択中`
    : game.step === 'closing' || expired ? '結果を反映中' : 'アイデア入力中';
  const shared = own && input && own.sequence >= input.sequence && own.card.text === input.text;
  const lastVisibleSlot = game.slots.reduce((last, id, index) => id ? index : last, -1);
  const saveState = !ready ? '未送信の変更があります。接続が戻るまで本文を保持します。'
    : input?.finalRequested ? '最終入力を共有中…' : expired ? '結果を反映中' : shared ? '共有済み' : '共有中…';

  return <main className="matching-screen">
    <header className="matching-header">
      <div className="matching-brand"><Link href="/" aria-label="ルーム一覧へ" onNavigate={client.leave}>◈</Link>
        <div><strong>Idea Board <span>神経衰弱</span></strong><small>ルーム：{state.identity.boardId}</small></div>
      </div>
      <div className="matching-stage" role="status" aria-live="polite">{stage}</div>
      <div className="matching-header-actions">
        <div className={`matching-timer ${remaining <= 3000 ? 'urgent' : ''}`} aria-label="共有タイマー">
          <small>{game.step === 'selecting' ? '単語を選択' : 'アイデア入力'}</small>
          <span aria-live="off">{Math.ceil(remaining / 1000)}<small>秒</small></span>
        </div>
        {state.status === 'offline' ? <button type="button" className="connection-dot" aria-label="再接続" title="再接続"
          style={{ border: 0, padding: 0 }} onClick={client.connect} />
          : <span className={`connection-dot ${ready ? 'connected' : ''}`} role="img" aria-label={ready ? '接続中' : '接続中…'} />}
        <button type="button" className="matching-abort" disabled={!ready || !!game.abortConfirmationId || game.finishAfterClosing}
          onClick={() => client.execute({ type: 'matching.abort.request', gameId: game.gameId })}>ゲームを中断</button>
      </div>
      <div className="matching-time-track" aria-hidden="true"><div style={{ width: `${remaining / MATCHING_DURATION_MS * 100}%` }} /></div>
    </header>

    {(!ready || state.error) && <BoardNotice noticeId={`connection:${state.status}:${state.errorSequence}`}
      className="matching-connection panel" role="alert">
      <span>{state.error || (state.status === 'loading' ? '再接続中…' : '接続が切れています。本文はこの端末に保持しています。')}</span>
      {state.status === 'offline' && <button type="button" className="primary" onClick={client.connect}>再接続</button>}
      {ready && state.error && state.pendingCommands.length > 0 && <button type="button" onClick={client.retryPending}>元の要求を再送</button>}
    </BoardNotice>}

    {game.step === 'selecting' ? <section className="matching-selection" aria-labelledby="matching-select-title">
      <div className="matching-intro"><p className="matching-eyebrow">WORD COMBINATION</p>
        <h1 id="matching-select-title">{ownTurn ? '2枚の単語を選んでください' : 'どんな組み合わせになるかな？'}</h1>
        <p>{ownTurn ? '気になるカードをめくって、アイデアのきっかけを見つけましょう。' : '担当者がカードを選んでいます。選ばれた2枚から、全員でアイデアを書きます。'}</p>
      </div>
      <div className="matching-selection-meta"><span>選択 <b>{game.selected.length} / 2</b></span>
        <span>表示中 {game.slots.filter(Boolean).length}枚 <span aria-hidden="true">·</span> 補充待ち {game.reserve.length}枚</span></div>
      <div className="matching-grid">
        {game.slots.slice(0, lastVisibleSlot + 1).map((id, index) => {
          const revealed = !!id && game.selected.includes(id);
          const copy = revealed ? game.copies.find(copy => copy.copyId === id) : undefined;
          return id ? <button type="button" key={index} className={`matching-word ${revealed ? 'revealed' : ''}`}
            aria-label={revealed ? `選択済み：${copy?.card.text}` : `裏向きのカード ${index + 1}`}
            disabled={!ready || !ownTurn || expired || revealed || pendingSelection}
            onClick={() => client.execute({ type: 'matching.select', gameId: game.gameId, turnId: game.turnId, copyId: id })}>
            {revealed ? <span>{copy?.card.text}</span> : <><span className="matching-card-mark" aria-hidden="true">✦</span><small aria-hidden="true">{String(index + 1).padStart(2, '0')}</small></>}
          </button> : <div key={index} className="matching-empty-slot" aria-hidden="true" />;
        })}
      </div>
      {game.notice && <BoardNotice noticeId={`matching:${game.turnId}:${game.notice}`} className="matching-notice">{game.notice}</BoardNotice>}
      <p className="matching-footnote">選び直しはできません。2枚選ぶと、10秒のアイデア入力が始まります。</p>
    </section> : <section className="matching-writing" aria-label="アイデアを入力">
      <div className="matching-workspace">
        <p className="matching-eyebrow">LET’S MAKE AN IDEA</p><h1>2つの単語から、ひとつのひらめき。</h1>
        <div className="matching-pair">
          {game.selected.map((id, index) => <div className="matching-pair-item" key={id}>
            {index > 0 && <span className="matching-times" aria-hidden="true">×</span>}
            <div className="matching-chosen-word">{game.copies.find(copy => copy.copyId === id)?.card.text}</div>
          </div>)}
        </div>
        {input ? <><label className="matching-input-label" htmlFor="matching-idea">自分のアイデア</label>
          <MatchingTextInput key={`${game.turnId}:${input.writerToken}`} value={input.text} expired={expired || input.finalRequested}
            onValueChange={text => client.updateMatchingDraft(text)} onFinalize={text => client.updateMatchingDraft(text, true)} />
          <p id="matching-save-state" className="matching-save-state">{saveState}</p>
          <p className="matching-footnote">入力は全員に共有され、時間終了でボードに追加されます。Enterで改行。</p>
        </> : <div className="matching-spectator panel"><strong>{own ? '別のタブで入力できます' : 'この手番は見学中です'}</strong>
          <p>{own ? 'このユーザーで最後に接続したタブに入力権があります。' : 'ほかの人のアイデアを見ながらお待ちください。次の手番から参加できます。'}</p></div>}
      </div>
      <aside className="matching-others"><div className="matching-others-heading"><h2>ほかのアイデア</h2><span>{others.length}件</span></div>
        <p>みんなのひらめきが、ここに集まります。</p>
        <div className="matching-other-list" aria-live="off">{others.map(draft => <article className="matching-other-idea panel" key={draft.card.cardId.uuid}>
          {draft.card.text || <span className="muted">入力待ち…</span>}
        </article>)}</div>
        {!others.length && <div className="matching-alone"><span aria-hidden="true">✧</span><p>あなたのペースで、ひらめきを言葉に。</p></div>}
      </aside>
    </section>}
    {game.abortConfirmationId && <AbortDialog key={game.abortConfirmationId} ready={ready}
      onContinue={() => client.execute({ type: 'matching.abort.cancel', gameId: game.gameId, confirmationId: game.abortConfirmationId! })}
      onEnd={() => client.execute({ type: 'matching.abort.confirm', gameId: game.gameId, confirmationId: game.abortConfirmationId! })} />}
  </main>;
}
