'use client';

import { randomUUID } from '@/domain/uuid';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MarkerType, SelectionMode, ConnectionMode,
  useReactFlow, useViewport, type NodeChange, type EdgeChange, type Edge, type Connection } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { createBoardClient, type BoardClient } from '@/client/board-client';
import { createHttpBoardTransport } from '@/client/http-board-transport';
import { useBoardClient } from '@/client/use-board-client';
import { generatedGuidance } from '@/client/generated-guidance';
import { CARD_SIZES, createEmptyCard, newArrowId, objectKey, getCard, sameObjectId, type BoardObjectId, type Card, type CardId, type RelationLevel } from '@/domain/board';
import { validAnchor } from '@/domain/board-validation';
import { BoardCard, BoardContext, previewCard, type BoardNode } from './BoardCard';
import { ImportBoardDialog } from './ImportBoardDialog';
import { BoardNotice } from './BoardNotice';
import type { BoardFile } from '@/domain/board-file';
import { downloadBoardJson, readBoardFile } from '@/client/board-file';
import { downloadBoardSvg } from '@/client/board-svg';

const nodeTypes = { card: BoardCard };
const COLORS = ['#FFF0A8', '#FFDCE5', '#D9E9FF', '#DDF5D7', '#EADFFF', '#FFFFFF'];
const COLOR_NAMES = ['黄色', 'ピンク', '青', '緑', '紫', '白'];
type Tool = 'select' | 'range' | 'note' | 'arrow' | 'reaction';
const TOOLS: readonly [Tool, string, string][] = [
  ['select', '↖', '選択・移動'], ['range', '⬚', '範囲選択'], ['note', '▤', '付箋を追加'], ['arrow', '↗', '矢印で接続'], ['reaction', '☺', 'リアクション'],
];

export function Board({ boardId }: { boardId: string }) {
  const [client, setClient] = useState<BoardClient | null>(null);
  useEffect(() => {
    let userId = randomUUID();
    try { userId = localStorage.getItem('board-user-id') || userId; localStorage.setItem('board-user-id', userId); } catch { /* ストレージが無効でも、この端末で操作できる。 */ }
    const instance = createBoardClient({ boardId, userId, clientId: randomUUID() }, createHttpBoardTransport());
    // ブラウザの識別情報はマウント後に読み込む。SSRと初回描画は同じ読み込み表示にする。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClient(instance);
    return () => instance.disconnect();
  }, [boardId]);
  return client ? <ReactFlowProvider><BoardCanvas key={boardId} client={client} /></ReactFlowProvider>
    : <div className="board-loading" role="status">ボードを準備中…</div>;
}
function BoardCanvas({ client }: { client: BoardClient }) {
  const { state } = useBoardClient(client);
  const flow = useReactFlow<BoardNode>();
  const viewport = useViewport();
  const surface = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [tool, setTool] = useState<Tool>('select');
  const [cardKind, setCardKind] = useState<Card['cardKind']>('word');
  const [color, setColor] = useState(COLORS[0]);
  const [noteOptions, setNoteOptions] = useState(false);
  const [menu, setMenu] = useState(false);
  const [aiPanel, setAiPanel] = useState(false);
  const [help, setHelp] = useState(false);
  const [level, setLevel] = useState<RelationLevel>('mid');
  const [selectedIds, setSelection] = useState<Set<string>>(new Set());
  const [relatedCandidate, setRelatedTarget] = useState<CardId | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileReadVersion = useRef(0);
  const [candidate, setCandidate] = useState<{ name: string; file: BoardFile } | null>(null);
  const [fileMessage, setFileMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const [clock, setClock] = useState(0);
  const pointer = useRef<{ x: number; y: number; at: number; moved: boolean } | null>(null);
  const ready = state.status === 'ready';
  const edit = state.edit;
  const relatedTarget = relatedCandidate && edit.phase !== 'idle' && edit.cardIds.some(id => sameObjectId(id, relatedCandidate)) ? relatedCandidate : null;
  const editing = edit.phase !== 'idle';
  const generating = state.generation.status === 'running';
  const board = state.board;
  const selection = useMemo(() => {
    const existing = new Set([...(board?.cards.map(card => objectKey(card.cardId)) ?? []),
      ...(board?.arrows.map(arrow => objectKey(arrow.arrowId)) ?? [])]);
    return new Set([...selectedIds].filter(id => existing.has(id)));
  }, [board, selectedIds]);

  useEffect(() => {
    const interval = setInterval(() => setClock(Date.now()), 250);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => {
    if (!surface.current) return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0].contentRect; setBounds({ width: rect.width, height: rect.height });
    });
    observer.observe(surface.current); return () => observer.disconnect();
  }, []);
  const nodes: BoardNode[] = useMemo(() => {
    if (!board) return [];
    const provisional = state.pendingCommands.flatMap(command => command.type === 'card.create' && !getCard(board, command.card.cardId) ? [command.card] : []);
    return [...board.cards, ...provisional].map(saved => {
    const card = previewCard(saved, state);
    const ownTransform = edit.phase !== 'idle' && edit.mode === 'transform' && edit.cardIds.some(id => sameObjectId(id, card.cardId));
    return { id: objectKey(card.cardId), type: 'card', data: { card }, position: { x: card.position.x, y: card.position.y },
      style: { width: card.shape.width, height: card.shape.height, ...(!getCard(board, card.cardId) && { opacity: .5, pointerEvents: 'none' }) }, width: card.shape.width, height: card.shape.height,
      zIndex: card.position.z, selected: selection.has(objectKey(card.cardId)), dragHandle: '.card-drag-handle',
      draggable: ready && !relatedTarget && tool === 'select' && (!saved.editingUser || ownTransform) &&
        (edit.phase === 'idle' || (ownTransform && edit.intent === 'editing')) };
  }); }, [board, state, edit, selection, ready, relatedTarget, tool]);
  const edges: Edge[] = board?.arrows.map(arrow => ({ id: objectKey(arrow.arrowId), source: objectKey(arrow.sourceCardId),
    target: objectKey(arrow.targetCardId), sourceHandle: arrow.sourceAnchor, targetHandle: arrow.targetAnchor,
    selected: selection.has(objectKey(arrow.arrowId)), type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed, color: '#64748b' },
    style: { stroke: selection.has(objectKey(arrow.arrowId)) ? '#4778e6' : '#64748b', strokeWidth: 2 } })) ?? [];
  const guides = useMemo(() => bounds.width && bounds.height ? state.generatedCardIds.flatMap(id => {
    const card = board && getCard(board, id);
    return card ? [{ card, ...generatedGuidance(previewCard(card, state), viewport, bounds) }] : [];
  }) : [], [board, bounds, viewport, state]);
  useEffect(() => {
    const visible = guides.filter(guide => guide.visible).map(guide => guide.card.cardId);
    if (visible.length) client.dismissGuidance(visible);
  }, [client, guides]);

  const importPending = state.importState.status === 'pending';
  const fileBusy = !ready || editing || importPending || readingFile || state.pendingCommands.length > 0;
  const syncError = state.importState.status === 'rejected' && state.error === state.importState.message ? null : state.error;
  function exportFile(kind: 'json' | 'svg') {
    if (!board || fileBusy) return;
    try {
      if (kind === 'json') downloadBoardJson(board); else downloadBoardSvg(board);
      setFileMessage({ error: false, text: `${kind.toUpperCase()}ファイルを出力しました。` });
      setMenu(false);
    } catch (error) {
      setFileMessage({ error: true, text: error instanceof Error ? error.message : 'ファイルを出力できませんでした。' });
    }
  }
  async function selectFile(file: File | undefined) {
    if (!file) return;
    const version = ++fileReadVersion.current;
    setReadingFile(true); setFileMessage(null); setMenu(false);
    try {
      const parsed = await readBoardFile(file);
      if (fileReadVersion.current === version) setCandidate({ name: file.name, file: parsed });
    } catch (error) {
      if (fileReadVersion.current === version) setFileMessage({ error: true,
        text: error instanceof Error ? error.message : 'ファイルを読み込めませんでした。' });
    } finally { if (fileReadVersion.current === version) setReadingFile(false); }
  }
  function confirmImport() {
    if (!candidate) return;
    if (!client.execute({ type: 'board.import', file: candidate.file })) {
      setFileMessage({ error: true, text: '編集や送信が完了し、接続が戻ってから再度読み込んでください。' });
    } else setFileMessage(null);
    setCandidate(null);
  }
  function focusCard(id: CardId) { document.getElementById(`text-${id.uuid}`)?.focus(); }
  function startRelated(id: CardId) {
    const current = client.getSnapshot().edit;
    if (current.phase === 'idle' && !client.requestEdit(id)) return;
    if (current.phase !== 'idle' && !current.cardIds.some(cardId => sameObjectId(cardId, id))) return;
    setRelatedTarget(id);
  }
  function selectRelated(id: CardId) {
    if (!relatedTarget || sameObjectId(id, relatedTarget)) return;
    const current = client.getSnapshot().edit;
    if (current.phase !== 'editing') return;
    const draft = current.drafts[objectKey(relatedTarget)];
    if (draft?.cardKind !== 'block') return;
    const relatedIds = draft.relatedIds.some(item => sameObjectId(item, id)) ? draft.relatedIds : [...draft.relatedIds, id];
    client.updateDraft({ relatedIds }, relatedTarget);
    const target = relatedTarget; setRelatedTarget(null); focusCard(target);
  }
  function deleteSelected() {
    if (!board) return;
    const ids: BoardObjectId[] = [...board.cards.map(card => card.cardId), ...board.arrows.map(arrow => arrow.arrowId)].filter(id => selection.has(objectKey(id)));
    if (ids.length) client.execute({ type: 'objects.delete', objectIds: ids });
  }
  // キー削除とゴミ箱は同じ操作を使用する。入力欄のBackspaceは文字削除。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || (event.target instanceof Element && event.target.closest('dialog'))) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (relatedTarget) { const target = relatedTarget; setRelatedTarget(null); focusCard(target); }
        else client.cancelEdit();
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault(); setRelatedTarget(null); client.commitEdit();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') &&
        !(event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]'))) {
        event.preventDefault(); deleteSelected();
      }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });
  function onNodesChange(changes: NodeChange<BoardNode>[]) {
    const selected = changes.filter(change => change.type === 'select');
    if (selected.length) setSelection(previous => {
      const next = new Set(previous); for (const change of selected) if (change.type === 'select') {
        if (change.selected) next.add(change.id); else next.delete(change.id);
      } return next;
    });
    const current = client.getSnapshot();
    if (current.edit.phase === 'idle' || current.edit.mode !== 'transform') return;
    for (const change of changes) if (change.type === 'position' && change.position) {
      const id = current.edit.cardIds.find(id => objectKey(id) === change.id);
      const saved = id && current.board && getCard(current.board, id);
      if (id && saved) client.updateDraft({ position: { ...change.position, z: saved.position.z } }, id);
    }
  }
  function onEdgesChange(changes: EdgeChange[]) {
    setSelection(previous => {
      const next = new Set(previous);
      for (const change of changes) if (change.type === 'select') {
        if (change.selected) next.add(change.id); else next.delete(change.id);
      } return next;
    });
  }
  function connect(connection: Connection) {
    if (!board || !validAnchor(connection.sourceHandle) || !validAnchor(connection.targetHandle)) return;
    const source = board.cards.find(card => objectKey(card.cardId) === connection.source);
    const target = board.cards.find(card => objectKey(card.cardId) === connection.target);
    if (source && target) client.execute({ type: 'arrow.create', arrow: { arrowId: newArrowId(), sourceCardId: source.cardId,
      targetCardId: target.cardId, sourceAnchor: connection.sourceHandle, targetAnchor: connection.targetHandle } });
  }
  function blankTap(x: number, y: number) {
    const current = client.getSnapshot();
    if (current.edit.phase !== 'idle') { setRelatedTarget(null); client.commitEdit(); return; }
    if (!ready || tool !== 'note') return;
    const point = flow.screenToFlowPosition({ x, y }); const shape = CARD_SIZES[cardKind];
    const z = board?.cards.reduce((max, card) => Math.max(max, card.position.z), -1) ?? -1;
    client.execute({ type: 'card.create', card: createEmptyCard(cardKind, { x: point.x - shape.width / 2, y: point.y - shape.height / 2, z: z + 1 }, color) });
    setTool('select'); setNoteOptions(false);
  }
  const timer = board?.timer;
  const remaining = timer?.state === 'running' && clock ? Math.max(0, timer.endsAt - clock - state.serverOffsetMs) : timer?.state === 'stopped' ? timer.remainingMs : 300_000;
  const seconds = Math.ceil(remaining / 1000);
  const timerLabel = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  const relatedActive = relatedTarget && edit.phase !== 'idle' && edit.cardIds.some(id => sameObjectId(id, relatedTarget));
  let guide = 'ドラッグで移動 · ホイールでズーム · Shiftで複数選択';
  if (relatedActive) guide = '関連先のカードを選択 · Escapeで選択だけを中止';
  else if (editing) guide = edit.phase === 'requesting' ? '編集許可を確認中…' : edit.phase === 'saving' ? '保存の確定を待っています…'
    : edit.phase === 'cancelling' ? '取消の確定を待っています…' : '空白をタップ / Ctrl・⌘＋Enterで確定 · Escapeで取消 · Enterで改行';
  else if (tool === 'note') guide = 'キャンバスをタップして付箋を配置';
  else if (tool === 'arrow') guide = 'カードの辺の点から別のカードの点へドラッグして接続';
  else if (tool === 'reaction') guide = '関連カードをクリックして「いいね」を切り替え';
  else if (tool === 'range') guide = 'ドラッグで範囲選択 · ゴミ箱 / Deleteで削除';

  return <BoardContext.Provider value={{ client, state, relatedTarget: relatedActive ? relatedTarget : null, editingEnabled: tool === 'select', startRelated, selectRelated }}>
    <main className="board-surface" ref={surface}
      onPointerDownCapture={event => {
        pointer.current = event.button === 0 && event.target instanceof Element && event.target.classList.contains('react-flow__pane')
          ? { x: event.clientX, y: event.clientY, at: Date.now(), moved: false } : null;
      }}
      onPointerMoveCapture={event => { if (pointer.current && Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 6) pointer.current.moved = true; }}
      onPointerCancelCapture={() => { pointer.current = null; }}
      onPointerUpCapture={event => {
        const start = pointer.current; pointer.current = null;
        if (start && !start.moved && Date.now() - start.at < 250 && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 6 &&
          event.target instanceof Element && event.target.classList.contains('react-flow__pane')) blankTap(event.clientX, event.clientY);
      }}>
      {board && <ReactFlow<BoardNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={connect}
        onNodeDragStart={(_event, node, dragged) => {
          const ids = (dragged.length ? dragged : [node]).map(node => node.data.card.cardId);
          client.requestEdit(ids, 'transform');
        }}
        onNodeDragStop={(_event, node, dragged) => {
          for (const moved of dragged.length ? dragged : [node]) client.updateDraft({ position: { ...moved.position, z: moved.data.card.position.z } }, moved.data.card.cardId);
          client.commitEdit();
        }}
        onNodeClick={(event, node) => {
          if (event.target instanceof Element && event.target.closest('button,input,select')) return;
          if (relatedActive) selectRelated(node.data.card.cardId);
          else if (tool === 'reaction' && node.data.card.cardKind === 'block') {
            const card = node.data.card; const own = card.reactions.some(r => r.reactionId === 'thumbs-up' && r.userId === state.identity.userId);
            client.execute({ type: own ? 'reaction.remove' : 'reaction.add', cardId: card.cardId, reactionId: 'thumbs-up' });
          }
        }}
        nodesConnectable={ready && (tool === 'arrow' || tool === 'select') && !relatedActive} connectionMode={ConnectionMode.Loose}
        elementsSelectable={!relatedActive && (tool === 'select' || tool === 'range')} selectionOnDrag={tool === 'range'}
        panOnDrag={tool !== 'range'} selectionMode={SelectionMode.Partial} multiSelectionKeyCode="Shift" deleteKeyCode={null}
        fitView fitViewOptions={{ padding: 0.25 }} minZoom={0.2} maxZoom={2}>
        <Background variant={BackgroundVariant.Lines} color="#dce2eb" gap={30} size={1} />
        <Controls position="bottom-left" showInteractive={false} fitViewOptions={{ padding: 0.25 }} />
      </ReactFlow>}
      {!board && <div className="board-loading" role="status">{state.status === 'offline' ? 'ボードに接続できませんでした' : 'ボードを読み込み中…'}</div>}
      {ready && board && !board.cards.length && <div className="empty-board"><b>最初のアイデアを置いてみましょう</b><p>左の「付箋を追加」から配置できます。</p></div>}
      <header className="board-brand panel"><Link href="/" aria-label="ルーム一覧へ">◈</Link><div><strong>Idea Board</strong><small>ルーム：{state.identity.boardId}</small></div>
        <span className={`connection-dot ${ready ? 'connected' : ''}`} title={ready ? '同期中' : '未接続'} />
      </header>
      <nav className="board-toolbar panel" aria-label="ボードのツール">
        {TOOLS.map(([value, icon, label]) => <button key={value} type="button" className={tool === value ? 'active' : ''}
          title={label} aria-label={label} aria-pressed={tool === value} disabled={!ready}
          onClick={() => { setTool(value); setNoteOptions(value === 'note' ? !noteOptions : false); }}><span aria-hidden="true">{icon}</span></button>)}
        <hr /><button type="button" aria-label="選択したカード・矢印を削除" title="選択したカード・矢印を削除" disabled={!ready || !selection.size} onClick={deleteSelected}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7H20M9 7V4H15V7M7 7L8 20H16L17 7M10 10V17M14 10V17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </nav>
      {noteOptions && <aside className="note-options panel">
        <strong>付箋を追加</strong><div className="kind-options">
          {(['word', 'block'] as const).map(kind => <button type="button" key={kind} aria-pressed={cardKind === kind} onClick={() => setCardKind(kind)}>{kind === 'word' ? '通常付箋' : '関連カード'}</button>)}
        </div><p>付箋の色</p><div className="color-options">{COLORS.map((item, index) => <button type="button" key={item} style={{ background: item }} title={COLOR_NAMES[index]}
          aria-label={COLOR_NAMES[index]} aria-pressed={color === item} onClick={() => setColor(item)} />)}</div>
        <p className="muted">キャンバスをタップして配置</p>
      </aside>}
      <div className="board-top-right">
        <div className="timer-panel panel"><span aria-hidden="true">◷</span><output aria-label="共有タイマー">{timerLabel}</output>
          <button type="button" disabled={!ready || (timer?.state === 'stopped' && !timer.remainingMs)} onClick={() => client.execute({ type: timer?.state === 'running' ? 'timer.stop' : 'timer.start' })}>{timer?.state === 'running' ? '停止' : '開始'}</button>
          <button type="button" disabled={!ready} onClick={() => client.execute({ type: 'timer.reset' })}>リセット</button>
        </div>
        <button className="menu-toggle panel" type="button" aria-label="メニュー" aria-expanded={menu} onClick={() => setMenu(!menu)}>☰</button>
        {menu && <div className="board-menu panel">
          <button type="button" disabled={fileBusy || !board} onClick={() => exportFile('json')}>JSONで保存</button>
          <button type="button" disabled={fileBusy || !board} onClick={() => exportFile('svg')}>SVGで出力</button>
          <button type="button" disabled={fileBusy} onClick={() => fileInput.current?.click()}>JSONを読み込む</button>
          <button type="button" disabled={!ready} onClick={() => { client.execute({ type: 'board.clear' }); setMenu(false); }}>キャンバスをクリア</button>
          <button type="button" disabled={!ready} onClick={() => { client.execute({ type: 'board.restore-sample' }); setMenu(false); }}>サンプルに戻す</button>
          <button type="button" onClick={() => { setHelp(!help); setMenu(false); }}>操作ガイド</button>
        </div>}
      </div>
      <input ref={fileInput} type="file" accept=".json,application/json" aria-label="読み込むボードのJSONファイル" hidden
        onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void selectFile(file); }} />
      {candidate && <ImportBoardDialog candidate={candidate} onCancel={() => setCandidate(null)} onConfirm={confirmImport} />}
      {fileMessage && <BoardNotice noticeId={fileMessage} persistent={fileMessage.error}
        className="file-message panel" role={fileMessage.error ? 'alert' : 'status'}>{fileMessage.text}</BoardNotice>}
      {!fileMessage && readingFile && <div className="file-message panel" role="status">ファイルを確認中…</div>}
      {state.importState.status !== 'idle' && <BoardNotice
        noticeId={`import:${state.importState.requestId}:${state.importState.status}`}
        persistent={state.importState.status !== 'succeeded'} hidden={!!fileMessage || readingFile || !!candidate}
        className="file-message panel" role={state.importState.status === 'rejected' ? 'alert' : 'status'}>
        {state.importState.status === 'pending' ? '読み込み結果を確認中です。通信が切れた場合も元の要求で再確認します。' : state.importState.message}
      </BoardNotice>}
      {(syncError || !ready || state.pendingCommands.length > 0) && <div className="sync-message panel" role={syncError ? 'alert' : 'status'}>
        <span>{syncError || (ready ? `${state.pendingCommands.length}件の応答を確認中…` : state.status === 'loading' ? 'サーバーに接続中…' : '接続が切れています。')}</span>
        {state.status === 'offline' && <button type="button" onClick={client.connect}>再接続</button>}
        {ready && state.error && state.pendingCommands.length > 0 && <button type="button" onClick={client.retryPending}>元の要求を再送</button>}
      </div>}
      {editing && edit.mode === 'text' && <div className="edit-actions panel">
        <span>{edit.phase === 'requesting' ? '編集許可を確認中' : edit.phase === 'saving' ? '保存中…' : edit.phase === 'cancelling' ? '取消中…' : '下書きを編集中'}</span>
        <button type="button" className="primary" disabled={edit.phase !== 'editing'} onClick={() => { setRelatedTarget(null); client.commitEdit(); }}>確定</button>
        <button type="button" disabled={edit.phase === 'saving' || edit.phase === 'cancelling'} onClick={() => { setRelatedTarget(null); client.cancelEdit(); }}>取消</button>
      </div>}
      <div className="operation-guide" role="status">{guide}</div>
      {guides.map(item => !item.visible && <button key={objectKey(item.card.cardId)} type="button" className="generated-guide"
        style={{ left: item.x, top: item.y }} title={`生成された「${item.card.text}」へ移動`} aria-label={`生成された「${item.card.text}」へ移動`}
        onClick={() => flow.fitView({ nodes: [{ id: objectKey(item.card.cardId) }], padding: 0.6, duration: 350 })}>
        <span style={{ transform: `rotate(${item.angle}deg)` }}>➜</span>
      </button>)}
      <button type="button" className="ai-toggle" aria-expanded={aiPanel} onClick={() => setAiPanel(!aiPanel)}>✦ {generating ? '生成中…' : 'AI'}</button>
      {aiPanel && <aside className="ai-panel panel"><div className="panel-title"><strong>関連語を生成</strong><button type="button" aria-label="AIパネルを閉じる" onClick={() => setAiPanel(false)}>×</button></div>
        <p>関連性の度合い</p>
        {([['low', '低', '元の単語から遠い'], ['mid', '中', '同じジャンルの関連語'], ['high', '高', '強く関連する単語']] as const).map(([value, label, description]) =>
          <button type="button" className="level-option" key={value} aria-pressed={level === value} disabled={generating} onClick={() => setLevel(value)}><b>{label}</b><small>{description}</small></button>)}
        <button type="button" className="primary generate-button" disabled={!ready || generating} onClick={() => client.execute({ type: 'generation.request', level })}>{generating ? '候補を生成中…' : '単語を生成'}</button>
        <small className="muted">現在はモックの候補語を使用しています。</small>
      </aside>}
      {state.generation.status !== 'idle' && <BoardNotice noticeId={`generation:${state.generation.generationId}:${state.generation.status}`}
        persistent={state.generation.status === 'running' || state.generation.status === 'failed'}
        className={`generation-message panel ${state.generation.status}`} role={state.generation.status === 'failed' ? 'alert' : 'status'}>
        {state.generation.status === 'running' ? '✦ ボードから候補語を生成中…' : state.generation.message}
      </BoardNotice>}
      {help && <aside className="help-panel panel"><div className="panel-title"><strong>操作ガイド</strong><button type="button" aria-label="ガイドを閉じる" onClick={() => setHelp(false)}>×</button></div>
        <p>本文欄をクリックして編集。Enterで改行、空白をタップかCtrl / ⌘＋Enterで確定、Escapeで取消します。</p>
        <p>上部のつまみで移動。Shiftで複数選択し、まとめて移動できます。選択したカードの四隅でサイズを変更します。</p>
        <p>関連カードには通常付箋・関連カードの両方を関連付けできます。選択中のEscapeは関連先の選択だけを中止します。</p>
        <p>リアクション・矢印・タイマーは全員に同期します。全員の編集終了から30秒後に候補が追加されます。</p>
      </aside>}
    </main>
  </BoardContext.Provider>;
}
