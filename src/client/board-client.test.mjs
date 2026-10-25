import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoardClient } from './board-client.ts';
import { createBoardService } from '../server/board-service.ts';
import { getCard, objectKey } from '../domain/board.ts';
import { board, cid, commands as commandFactory, identity, snapshot, word } from '../test/board-fixtures.mjs';
import { deferred, flush } from '../test/fake-clock.mjs';

function setup(t) {
  const sent = []; const subscriptions = []; const service = createBoardService([board()]);
  t.after(() => service.dispose());
  const transport = { send(command) { sent.push(command); }, subscribe(onEvent, onDisconnect) {
    const entry = { onEvent, onDisconnect, stopped: false }; subscriptions.push(entry); return () => { entry.stopped = true; };
  } };
  let n = 0; const client = createBoardClient(identity, transport, () => `client-${++n}`);
  t.after(() => client.disconnect());
  const emit = event => subscriptions.at(-1).onEvent(event);
  const deliver = (command = sent.at(-1)) => { const result = service.executeCommand(command); emit(result.body); return result.body; };
  const current = () => client.getSnapshot();
  const request = (ids = cid(1), mode = 'text') => { assert.equal(client.requestEdit(ids, mode), true); return sent.at(-1); };
  const acquire = (ids, mode) => { request(ids, mode); return deliver(); };
  const draft = (id = cid(1)) => current().edit.drafts[objectKey(id)];
  const check = (lockId, ids = [cid(1)], extra = {}) => ({ ...service.getBoardSnapshot('board'), type: 'edit.check',
    userId: identity.userId, clientId: identity.clientId, cardIds: ids, lockId, checkId: 'check', ...extra });
  client.connect(); emit(service.getBoardSnapshot('board'));
  return { client, service, transport, sent, subscriptions, emit, deliver, current, request, acquire, draft, check };
}

test('許可前は本文編集を防ぎ、下書きと確定済みボードを分離して保存する', t => {
  const s = setup(t); s.request();
  assert.equal(s.client.updateDraft({ text: 'not granted' }), false);
  assert.equal(s.client.requestEdit(cid(2)), false);
  s.deliver(); assert.equal(s.client.updateDraft({ text: 'draft' }), true);
  assert.equal(getCard(s.current().board, cid(1)).text, 'word-1');
  const before = s.current(); s.client.commitEdit(); assert.equal(s.current().edit.phase, 'saving');
  assert.deepEqual(s.sent.at(-1).changes, [{ cardId: cid(1), patch: { text: 'draft' } }]);
  assert.equal(s.client.updateDraft({ text: 'after commit' }), false);
  s.deliver(); assert.equal(s.current().edit.phase, 'idle'); assert.equal(s.current().pendingCommands.length, 0);
  assert.equal(getCard(s.current().board, cid(1)).text, 'draft'); assert.equal(before.edit.phase, 'editing');
});
test('複数の仮移動は許可前から表示し、先に離しても許可後に一括確定する', t => {
  const s = setup(t); const request = s.request([cid(1), cid(2)], 'transform');
  s.client.updateDraft({ position: { x: 10, y: 20, z: 1 } }, cid(1));
  s.client.updateDraft({ position: { x: 30, y: 40, z: 2 }, shape: { width: 300, height: 250 } }, cid(2));
  assert.equal(s.current().edit.phase, 'requesting'); assert.equal(s.draft().position.x, 10);
  assert.equal(s.client.updateDraft({ text: 'not allowed' }), false);
  s.client.commitEdit(); assert.equal(s.sent.at(-1).type, 'edit.request');
  s.deliver(request); assert.equal(s.current().edit.phase, 'saving'); assert.equal(s.sent.at(-1).type, 'edit.commit');
  s.deliver(); assert.equal(s.current().edit.phase, 'idle'); assert.equal(s.current().revision, 2);
  assert.equal(getCard(s.current().board, cid(1)).position.x, 10); assert.equal(getCard(s.current().board, cid(2)).shape.width, 300);
});
test('許可待ちの移動量は許可時の最新位置へ合成し、最新本文を上書きしない', t => {
  const s = setup(t); const request = s.request(cid(1), 'transform');
  s.client.updateDraft({ position: { x: 260, y: 110, z: 1 } });
  const grant = s.service.executeCommand(request).body;
  const latest = { ...grant.board, cards: grant.board.cards.map(card => card.cardId.uuid === cid(1).uuid ? { ...card, position: { x: 300, y: 200, z: 1 }, text: 'latest' } : card) };
  s.emit(snapshot(latest, 2)); s.emit(grant);
  assert.equal(s.current().revision, 2); assert.equal(s.current().edit.phase, 'editing');
  assert.deepEqual(s.draft().position, { x: 310, y: 210, z: 1 }); assert.equal(s.draft().text, 'latest');
});
test('取得拒否は仮表示を破棄して最新の確定位置へ戻す', t => {
  const s = setup(t); const request = s.request(cid(1), 'transform'); s.client.updateDraft({ position: { x: 1, y: 2, z: 1 } });
  const other = commandFactory({ ...identity, clientId: 'other' });
  const grant = s.service.executeCommand(other('edit.request', { cardIds: [cid(1)] })).body;
  s.service.executeCommand(other('edit.commit', { lockId: grant.lockId, changes: [{ cardId: cid(1), patch: { position: { x: 500, y: 500, z: 1 } } }] }));
  s.service.executeCommand(other('edit.request', { cardIds: [cid(1)] }));
  s.deliver(request); assert.equal(s.current().edit.phase, 'idle'); assert.equal(getCard(s.current().board, cid(1)).position.x, 500);
  assert.ok(s.current().error);
});
test('許可前の取消は遅い許可を受けた後に取消要求で解除し、移動を確定しない', t => {
  const s = setup(t); const request = s.request([cid(1), cid(2)], 'transform');
  s.client.updateDraft({ position: { x: 5, y: 5, z: 1 } }); s.client.cancelEdit(); s.deliver(request);
  assert.equal(s.sent.at(-1).type, 'edit.cancel'); assert.equal(s.current().edit.phase, 'cancelling');
  s.deliver(); assert.equal(s.current().edit.phase, 'idle'); assert.equal(getCard(s.current().board, cid(1)).position.x, 250);
});
test('HTTPの同期・非同期エラーでもSSE・下書き・最終要求を保持し、同IDで再送する', async t => {
  for (const operation of ['commitEdit', 'cancelEdit']) {
    const s = setup(t); const grant = s.acquire(); s.client.updateDraft({ text: 'final' });
    const job = deferred(); s.transport.send = command => { s.sent.push(command); return job.promise; };
    s.client[operation](); const original = structuredClone(s.sent.at(-1)); job.reject(new Error('timeout')); await flush();
    assert.equal(s.current().status, 'ready'); assert.equal(s.subscriptions.at(-1).stopped, false);
    assert.equal(s.current().edit.phase, operation === 'commitEdit' ? 'saving' : 'cancelling');
    s.emit(s.check(grant.lockId));
    assert.equal(s.sent.at(-1).state, operation === 'commitEdit' ? 'committing' : 'cancelling');
    if (operation === 'commitEdit') assert.equal(s.sent.at(-1).changes[0].patch.text, 'final');
    s.transport.send = command => s.sent.push(command); s.client.retryPending();
    assert.deepEqual(s.sent.findLast(command => command.type === original.type), original);
  }
  const s = setup(t); s.transport.send = () => { throw new Error('network'); }; s.request();
  assert.equal(s.current().status, 'ready'); assert.equal(s.current().edit.phase, 'requesting');
});
test('新しいボードが先着しても古い個別応答で巻き戻らず、要求完了を判定する', t => {
  const s = setup(t); const grant = s.acquire(); s.client.updateDraft({ text: 'draft' });
  s.client.commitEdit(); const result = s.service.executeCommand(s.sent.at(-1)).body;
  const latest = { ...result.board, timer: { durationMs: 300000, state: 'running', endsAt: 300000 } };
  s.emit(snapshot(latest, 10)); assert.equal(s.current().edit.phase, 'saving'); s.emit(result);
  assert.equal(s.current().edit.phase, 'idle'); assert.equal(s.current().revision, 10);
  assert.equal(s.current().board.timer.state, 'running');
  s.emit(grant); assert.equal(s.current().edit.phase, 'idle');
});
test('途中保存中の後続入力と、元の値に戻す入力を古い応答で失わない', t => {
  for (const next of ['later input', 'word-1']) {
    const s = setup(t); const grant = s.acquire(); s.client.updateDraft({ text: 'interim' });
    s.emit(s.check(grant.lockId)); const reply = s.sent.at(-1);
    s.client.updateDraft({ text: next });
    const saved = { ...s.current().board, cards: s.current().board.cards.map(card => card.cardId.uuid === cid(1).uuid ? { ...card, text: 'interim' } : card) };
    s.emit(snapshot(saved, 2, { type: 'edit.checked', clientId: identity.clientId, requestId: reply.requestId,
      lockId: grant.lockId, cardIds: [cid(1)], checkId: 'check', outcome: 'saved' }));
    assert.equal(s.draft().text, next);
    s.emit(s.check(grant.lockId, [cid(1)], { checkId: 'next', board: saved, revision: 2 }));
    assert.equal(s.sent.at(-1).changes[0].patch.text, next);
  }
});
test('問い合わせは端末・ユーザー・対象集合・ロックを照合し、重複返答しない', t => {
  const s = setup(t); const grant = s.acquire(); const count = s.sent.length;
  for (const extra of [{ clientId: 'other' }, { userId: 'other' }, { cardIds: [cid(2)] }, { lockId: 'other' }]) s.emit(s.check(grant.lockId, [cid(1)], extra));
  assert.equal(s.sent.length, count); s.emit(s.check(grant.lockId)); const replyCount = s.sent.length;
  s.emit(s.check(grant.lockId)); assert.equal(s.sent.length, replyCount);
});
test('許可応答が欠けても問い合わせから仮移動の確定・取消を回収できる', t => {
  for (const cancel of [false, true]) {
    const s = setup(t); const request = s.request(cid(1), 'transform');
    s.client.updateDraft({ position: { x: 10, y: 20, z: 1 } });
    if (cancel) s.client.cancelEdit(); else s.client.commitEdit();
    const grant = s.service.executeCommand(request).body; s.emit(s.check(grant.lockId));
    assert.equal(s.sent.at(-1).type, 'edit.check.reply'); assert.equal(s.sent.at(-1).state, cancel ? 'cancelling' : 'committing');
    assert.equal(s.current().pendingCommands.some(command => command.requestId === request.requestId), false);
  }
});
test('リアクションと削除済み参照の更新を下書き・位置保存で巻き戻さない', t => {
  const s = setup(t); s.acquire(cid(3));
  s.client.updateDraft({ relatedIds: [cid(1), cid(2)] });
  const other = commandFactory({ ...identity, clientId: 'other' });
  s.service.executeCommand(other('reaction.add', { cardId: cid(3), reactionId: 'heart' }));
  s.service.executeCommand(other('objects.delete', { objectIds: [cid(1)] })); s.emit(s.service.getBoardSnapshot('board'));
  assert.deepEqual(s.draft(cid(3)).relatedIds, [cid(2)]);
  s.client.commitEdit(); s.deliver();
  assert.deepEqual(getCard(s.current().board, cid(3)).relatedIds, [cid(2)]);
  assert.equal(getCard(s.current().board, cid(3)).reactions.length, 1);
});
test('生成状態の順序はrevisionと分離し、同revisionの未処理生成通知も案内へ渡す', t => {
  const s = setup(t); const generated = { ...board(), cards: [...board().cards, word(4)] };
  const running = { status: 'running', generationId: 'g2', level: 'high', source: 'manual' };
  s.emit(snapshot(generated, 5, { generationSequence: 3, generation: running }));
  const event = snapshot(generated, 5, { type: 'board.cards-generated', eventId: 'event', generationId: 'g1', generatedCardIds: [cid(4)], generationSequence: 2,
    generation: { ...running, status: 'completed', generationId: 'g1' } });
  s.emit(event); assert.equal(s.current().generation.generationId, 'g2'); assert.equal(s.current().generation.status, 'running');
  assert.deepEqual(s.current().generatedCardIds, [cid(4)]);
  s.client.dismissGuidance([cid(4)]); s.emit(event); assert.deepEqual(s.current().generatedCardIds, []);
  s.emit(snapshot(board(), 6)); s.emit({ ...event, eventId: 'late' }); assert.deepEqual(s.current().generatedCardIds, []);
});
test('初期化前の通知を順序を保って反映し、初期取得に含まれる生成は案内しない', t => {
  const s = setup(t); s.client.disconnect(); s.client.connect();
  const generated = { ...board(), cards: [...board().cards, word(4)] };
  s.emit(snapshot(generated, 2, { type: 'board.cards-generated', eventId: 'early', generationId: 'g', generatedCardIds: [cid(4)] }));
  assert.equal(s.current().status, 'loading'); s.emit(snapshot(generated, 2));
  assert.equal(s.current().status, 'ready'); assert.deepEqual(s.current().generatedCardIds, []);
  s.client.disconnect(); s.client.connect();
  s.emit(snapshot(generated, 3, { type: 'board.cards-generated', eventId: 'new', generationId: 'g2', generatedCardIds: [cid(4)] }));
  s.emit(snapshot(board(), 2)); assert.equal(s.current().revision, 3); assert.deepEqual(s.current().generatedCardIds, [cid(4)]);
});
test('切断後は再同期し、古い接続・古い送信失敗・他ボードのイベントを無視する', async t => {
  const s = setup(t); s.acquire(); const old = s.subscriptions.at(-1); const job = deferred();
  s.transport.send = () => job.promise; s.client.commitEdit(); old.onDisconnect('offline');
  assert.equal(s.current().status, 'offline'); assert.equal(s.current().edit.phase, 'idle');
  s.transport.send = command => s.sent.push(command); s.client.connect();
  old.onEvent(snapshot(board(), 999)); s.emit(snapshot(board(), 0));
  job.reject(new Error('old')); await flush(); s.emit(snapshot({ ...board(), boardId: 'other' }, 100));
  assert.equal(s.current().revision, 0); assert.equal(s.current().status, 'ready');
});
test('下書きからID・種類・リアクションを混入させず、不正座標を拒否する', t => {
  const s = setup(t); s.acquire();
  for (const patch of [{ cardId: cid(99) }, { reactions: [] }, { cardKind: 'block' }, { position: { x: NaN, y: 0, z: 0 } }]) {
    assert.equal(s.client.updateDraft(patch), false);
  }
  assert.equal(s.current().edit.phase, 'editing');
});
