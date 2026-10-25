'use client';

import { createContext, useContext, useRef } from 'react';
import { Handle, Position, NodeResizeControl, type Node, type NodeProps } from '@xyflow/react';
import type { Board, Card, CardId } from '@/domain/board';
import { CARD_SIZES, MAX_CARD_SIZE, REACTIONS, getCard, objectKey, sameObjectId } from '@/domain/board';
import type { BoardClient, BoardClientState } from '@/client/board-client';
import type { CardContent } from '@/domain/board-protocol';
import { CardTextInput } from './CardTextInput';

export type BoardNode = Node<{ card: Card }, 'card'>;
export const BoardContext = createContext<{
  client: BoardClient; state: BoardClientState; relatedTarget: CardId | null;
  editingEnabled: boolean;
  startRelated: (id: CardId) => void; selectRelated: (id: CardId) => void;
} | null>(null);

function autoFontSize(card: Card) {
  const charsPerLine = Math.max(6, Math.floor((card.shape.width - 28) / 18));
  const lines = card.text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).length / charsPerLine)), 0);
  const available = card.shape.height - (card.cardKind === 'block' ? 190 : 60);
  return Math.max(11, Math.min(card.cardKind === 'word' ? 20 : 16, Math.sqrt(Math.max(30, available) / (lines * 1.5)) * 6));
}
const anchors = [
  ['north', Position.Top], ['east', Position.Right], ['south', Position.Bottom], ['west', Position.Left],
] as const;

export function BoardCard({ data: { card }, selected }: NodeProps<BoardNode>) {
  const context = useContext(BoardContext)!;
  const { client, state, relatedTarget } = context;
  const suppressTextClick = useRef(false);
  const edit = state.edit;
  const key = objectKey(card.cardId);
  const owned = edit.phase !== 'idle' && edit.cardIds.some(id => sameObjectId(id, card.cardId));
  const editing = owned && edit.phase === 'editing' && edit.mode === 'text' && edit.intent === 'editing';
  const waiting = owned && edit.phase === 'requesting';
  const locked = !!card.editingUser && !owned;
  const canStart = context.editingEnabled && state.status === 'ready' && !locked && (edit.phase === 'idle' || editing);
  // モバイルSafariはreadOnlyな欄へ最初にフォーカスするとキーボードを開かない。
  // 欄はタップ時から有効にし、許可前の本文変更はCardTextInputで止める。
  const keyboardEnabled = !relatedTarget && (canStart || (waiting && edit.mode === 'text' && edit.intent === 'editing'));
  const canResize = state.status === 'ready' && selected && !relatedTarget &&
    (edit.phase === 'idle' || (owned && edit.mode === 'transform' && edit.intent === 'editing'));
  const size = CARD_SIZES[card.cardKind];
  const board = state.board as Board;
  function draft() {
    const current = client.getSnapshot().edit;
    return current.phase !== 'idle' ? current.drafts[key] : undefined;
  }
  function removeRelated(id: CardId) {
    const current = draft();
    if (current?.cardKind === 'block') client.updateDraft({ relatedIds: current.relatedIds.filter(item => !sameObjectId(item, id)) }, card.cardId);
  }
  function toggleReaction(reactionId: string) {
    if (card.cardKind !== 'block') return;
    const own = card.reactions.some(r => r.reactionId === reactionId && r.userId === state.identity.userId);
    client.execute({ type: own ? 'reaction.remove' : 'reaction.add', cardId: card.cardId, reactionId });
  }
  function resize(params: { x: number; y: number; width: number; height: number }) {
    client.updateDraft({ shape: { width: params.width, height: params.height }, position: { x: params.x, y: params.y, z: card.position.z } }, card.cardId);
  }
  return (
    <article className={`board-card ${card.cardKind} ${selected ? 'selected' : ''} ${locked ? 'locked' : ''}`}
      style={{ background: card.color, width: card.shape.width, height: card.shape.height, fontFamily: card.font }}
      aria-label={`${card.cardKind === 'word' ? '通常付箋' : '関連カード'}：${card.text || '無題'}`}>
      {canResize && (['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map(position => (
        <NodeResizeControl key={position} position={position} minWidth={size.minWidth} minHeight={size.minHeight}
          maxWidth={MAX_CARD_SIZE} maxHeight={MAX_CARD_SIZE} className="resize-corner" style={{ width: 9, height: 9 }}
          onResizeStart={() => { client.requestEdit(card.cardId, 'transform'); }}
          onResize={(_event, params) => resize(params)}
          onResizeEnd={(_event, params) => { resize(params); client.commitEdit(); }} />
      ))}
      <div className="card-drag-handle" title="ここをドラッグして移動">
        <span className="grip" />
        <span className="lock-label">{locked ? '🔒 別の端末が編集中' : waiting ? '編集許可を確認中…' : owned ? '編集中' : ''}</span>
      </div>
      {card.cardKind === 'block' && <div className="block-heading">関連カード</div>}
      {card.cardKind === 'block' && (
        <div className="related-area nodrag nowheel">
          <div className="related-chips">
            {card.relatedIds.map(id => {
              const related = getCard(board, id);
              return <div className="related-chip" key={objectKey(id)}>
                <i style={{ background: related?.color }} /><span>{related?.text || '無題のカード'}</span>
                <button type="button" disabled={!editing} aria-label={`${related?.text || '無題のカード'}の関連付けを解除`}
                  onClick={() => removeRelated(id)}>×</button>
              </div>;
            })}
            {!card.relatedIds.length && <p>複数のカードをここに関連付け</p>}
          </div>
          <button type="button" className="related-add" disabled={!canStart || !!relatedTarget}
            onClick={() => context.startRelated(card.cardId)}>
            {relatedTarget && sameObjectId(relatedTarget, card.cardId) ? '関連先のカードを選択中…' : '+ ボードからカードを選択'}
          </button>
        </div>
      )}
      {card.cardKind === 'block' && <label className="text-caption" htmlFor={`text-${card.cardId.uuid}`}>概要</label>}
      <CardTextInput id={`text-${card.cardId.uuid}`} className="card-text nodrag nopan nowheel" value={card.text}
        editSession={editing ? edit.lockId ?? null : null}
        style={{ fontSize: autoFontSize(card) }} aria-label={card.cardKind === 'word' ? '付箋の本文' : '関連カードの概要'}
        placeholder={card.cardKind === 'word' ? 'アイデアを入力' : 'アイデアをまとめる'} maxLength={100_000}
        readOnly={!keyboardEnabled} disabled={state.status !== 'ready' || locked} inputMode="text"
        onPointerDown={event => {
          suppressTextClick.current = !!relatedTarget;
          if (relatedTarget) { event.preventDefault(); event.stopPropagation(); context.selectRelated(card.cardId); }
          else if (keyboardEnabled) {
            event.stopPropagation();
          }
        }}
        onClick={event => {
          if (suppressTextClick.current) {
            suppressTextClick.current = false; event.preventDefault(); event.stopPropagation(); return;
          }
          if (!keyboardEnabled) return;
          event.stopPropagation();
          if (client.getSnapshot().edit.phase === 'idle') client.requestEdit(card.cardId);
        }}
        onFocus={() => { if (canStart && !relatedTarget && edit.phase === 'idle') client.requestEdit(card.cardId); }}
        onValueChange={text => { client.updateDraft({ text }, card.cardId); }} />
      {card.cardKind === 'block' && <div className="card-reactions nodrag" onClick={event => event.stopPropagation()}>
        {REACTIONS.map(reaction => {
          const count = card.reactions.filter(r => r.reactionId === reaction.reactionId).length;
          const own = card.reactions.some(r => r.reactionId === reaction.reactionId && r.userId === state.identity.userId);
          return <button key={reaction.reactionId} type="button" title={reaction.altText} aria-label={reaction.altText}
            aria-pressed={own} disabled={state.status !== 'ready'} onClick={() => toggleReaction(reaction.reactionId)}>
            {reaction.icon}{count > 0 && <small>{count}</small>}
          </button>;
        })}
      </div>}
      {editing && <div className="card-edit-options nodrag">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(card.color) ? card.color : '#ffffff'} aria-label="カードの色"
          onChange={event => client.updateDraft({ color: event.target.value }, card.cardId)} />
        <select aria-label="書体" value={card.font} onChange={event => client.updateDraft({ font: event.target.value }, card.cardId)}>
          <option value="sans-serif">ゴシック</option><option value="serif">明朝</option><option value="monospace">等幅</option>
        </select>
      </div>}
      {anchors.map(([anchor, position]) => (
        <Handle key={anchor} type="source" position={position} id={anchor} className="card-anchor" title={`${anchor}：ドラッグして接続`} />
      ))}
    </article>
  );
}

export function previewCard(card: Card, state: BoardClientState): Card {
  const edit = state.edit;
  if (edit.phase === 'idle' || edit.intent === 'cancelling') return card;
  const draft: CardContent | undefined = edit.drafts[objectKey(card.cardId)];
  if (!draft) return card;
  return { ...card, ...draft } as Card;
}
