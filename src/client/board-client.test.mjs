import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoardClient } from './board-client.ts';

const identity = { boardId: 'board-1', userId: 'user-1', clientId: 'client-1' };
const card = {
  cardId: 'card-1', shape: 'rectangle', position: { x: 0, y: 0, z: 0 },
  color: '#ffffff', text: '確定済み', font: 'sans-serif',
};
const board = { boardId: identity.boardId, cards: [card] };
const locked = {
  ...board, cards: [{ ...card, editingUser: { userId: identity.userId } }],
};

function setup() {
  let nextId = 0;
  const commands = [];
  const subscriptions = [];
  const transport = {
    send: (command) => { commands.push(command); },
    subscribe(onEvent, onDisconnect) {
      const entry = { onEvent, onDisconnect, stopped: false };
      subscriptions.push(entry);
      return () => { entry.stopped = true; };
    },
  };
  const client = createBoardClient(identity, transport, () => `request-${++nextId}`);
  const emit = (event) => subscriptions.at(-1).onEvent(event);
  const snapshot = (value = board, revision = 0) =>
    emit({ type: 'board.snapshot', board: value, revision });
  const reply = (type, value, revision, extra = {}) => emit({
    type, board: value, revision, clientId: identity.clientId,
    cardId: card.cardId, requestId: commands.at(-1).requestId, ...extra,
  });
  function grant() {
    assert.equal(client.requestEdit(card.cardId), true);
    reply('edit.granted', locked, 1, { lockId: 'lock-1' });
  }
  client.connect();
  snapshot();
  return { client, transport, commands, subscriptions, emit, snapshot, reply, grant };
}

test('許可前の編集を防ぎ、下書きと送信を確定済みボードから分離する', () => {
  const { client, commands, reply } = setup();
  assert.equal(commands[0].type, 'board.get');
  assert.equal(client.requestEdit(card.cardId), true);
  assert.equal(client.requestEdit(card.cardId), false);
  assert.equal(client.updateDraft({ text: '未許可' }), false);
  assert.equal(client.commitEdit(), false);
  reply('edit.granted', locked, 1, { lockId: 'lock-1' });
  assert.equal(client.updateDraft({ text: '下書き', position: { x: 10, y: 20, z: 1 } }), true);
  assert.equal(client.getSnapshot().board.cards[0].text, '確定済み');
  const beforeCommit = client.getSnapshot();
  assert.equal(client.commitEdit(), true);
  assert.equal(client.commitEdit(), false);
  assert.equal(client.updateDraft({ text: '送信後' }), false);
  assert.equal(client.getSnapshot().board.cards[0].text, '確定済み');
  assert.equal(commands.at(-1).lockId, 'lock-1');
  assert.equal(commands.at(-1).content.text, '下書き');
  assert.equal('editingUser' in commands.at(-1).content, false);
  reply('edit.committed', { ...board, cards: [{ ...card, text: '下書き' }] }, 2);
  assert.equal(client.getSnapshot().edit.phase, 'idle');
  assert.equal(client.getSnapshot().board.cards[0].text, '下書き');
  assert.equal(client.getSnapshot().error, null);
  assert.equal(beforeCommit.edit.phase, 'editing');
  assert.equal(beforeCommit.board.cards[0].text, '確定済み');
});

test('同じユーザーの別端末への許可では編集を開始しない', () => {
  const { client, reply, snapshot } = setup();
  client.requestEdit(card.cardId);
  reply('edit.granted', locked, 1, { clientId: 'client-2', lockId: 'other-lock' });
  assert.equal(client.getSnapshot().edit.phase, 'requesting');
  reply('edit.rejected', locked, 1, { reason: '別の端末が編集中です' });
  assert.equal(client.getSnapshot().edit.phase, 'idle');
  assert.equal(client.getSnapshot().error, '別の端末が編集中です');
  assert.equal(client.requestEdit(card.cardId), false);
  snapshot(board, 2);
  assert.equal(client.requestEdit(card.cardId), true);
});

test('取消の通知が届くまでは編集権を保持し、下書きを確定しない', () => {
  const { client, grant, reply, commands } = setup();
  grant();
  client.updateDraft({ text: '破棄する下書き' });
  assert.equal(client.cancelEdit(), true);
  assert.equal(client.getSnapshot().edit.phase, 'cancelling');
  assert.equal(commands.at(-1).type, 'edit.cancel');
  assert.equal(client.requestEdit(card.cardId), false);
  reply('edit.cancelled', board, 2);
  assert.equal(client.getSnapshot().edit.phase, 'idle');
  assert.equal(client.getSnapshot().board.cards[0].text, '確定済み');
  assert.equal(client.getSnapshot().board.cards[0].editingUser, undefined);
});

test('他ボード・古い更新を無視し、他クライアントの確定を反映する', () => {
  const { client, snapshot, reply } = setup();
  const changed = { ...board, cards: [{ ...card, text: '他端末の更新' }] };
  reply('edit.committed', changed, 5, { clientId: 'client-2' });
  snapshot(board, 4);
  snapshot({ ...board, boardId: 'other-board' }, 100);
  assert.equal(client.getSnapshot().revision, 5);
  assert.equal(client.getSnapshot().board.cards[0].text, '他端末の更新');
  changed.cards[0].text = '受信元が後から変更';
  assert.equal(client.getSnapshot().board.cards[0].text, '他端末の更新');
});

test('要求IDが違う許可応答と、重複した許可応答は下書きを上書きしない', () => {
  const { client, reply } = setup();
  client.requestEdit(card.cardId);
  reply('edit.granted', locked, 1, { lockId: 'lock-1', requestId: 'old' });
  assert.equal(client.getSnapshot().edit.phase, 'requesting');
  reply('edit.granted', locked, 1, { lockId: 'lock-1' });
  client.updateDraft({ text: '作業中' });
  reply('edit.granted', locked, 1, { lockId: 'lock-1' });
  assert.equal(client.getSnapshot().edit.draft.text, '作業中');
});

test('切断後は編集を止め、古い接続の通知を無視して再取得する', () => {
  const { client, grant, subscriptions, snapshot, commands } = setup();
  grant();
  const previous = subscriptions.at(-1);
  previous.onDisconnect('接続が切れました');
  assert.equal(client.getSnapshot().status, 'offline');
  assert.equal(previous.stopped, true);
  assert.equal(client.commitEdit(), false);
  client.connect();
  assert.equal(client.getSnapshot().status, 'loading');
  assert.equal(commands.at(-1).type, 'board.get');
  previous.onEvent({ type: 'board.snapshot', board, revision: 100 });
  assert.equal(client.getSnapshot().revision, 1);
  snapshot(board, 2);
  assert.equal(client.getSnapshot().status, 'ready');
  assert.equal(client.getSnapshot().edit.phase, 'idle');
});

test('同期的・非同期的な送信失敗で処理待ち状態に残らない', async () => {
  for (const fail of [
    () => { throw new Error('offline'); },
    () => Promise.reject(new Error('offline')),
  ]) {
    const { client, transport } = setup();
    transport.send = fail;
    client.requestEdit(card.cardId);
    await Promise.resolve();
    assert.equal(client.getSnapshot().status, 'offline');
    assert.equal(client.getSnapshot().edit.phase, 'idle');
    assert.ok(client.getSnapshot().error);
  }
});

test('古い送信の失敗で再接続後の状態を壊さない', async () => {
  const { client, transport, snapshot } = setup();
  let reject;
  transport.send = () => new Promise((_, fail) => { reject = fail; });
  client.requestEdit(card.cardId);
  client.disconnect();
  transport.send = () => {};
  client.connect();
  snapshot(board, 2);
  reject(new Error('遅れて届く失敗'));
  await Promise.resolve();
  assert.equal(client.getSnapshot().status, 'ready');
});

test('編集権の消失を検出し、状態購読を解除できる', () => {
  const { client, grant, snapshot } = setup();
  let calls = 0;
  const stop = client.subscribe(() => { calls += 1; });
  grant();
  assert.ok(calls > 0);
  snapshot(board, 2);
  assert.equal(client.getSnapshot().edit.phase, 'idle');
  assert.ok(client.getSnapshot().error);
  stop();
  const before = calls;
  snapshot(board, 3);
  assert.equal(calls, before);
});

test('下書きからIDや編集者を変更できず、不正な座標を拒否する', () => {
  const { client, grant } = setup();
  grant();
  client.updateDraft({ cardId: 'other', editingUser: { userId: 'other' }, text: '' });
  assert.equal(client.getSnapshot().edit.cardId, card.cardId);
  assert.equal('editingUser' in client.getSnapshot().edit.draft, false);
  assert.equal(client.getSnapshot().edit.draft.text, '');
  assert.equal(client.updateDraft({ position: { x: NaN, y: 0, z: 0 } }), false);
});

test('自分の応答が新しいスナップショットより遅れた場合、応答待ちに残さない', () => {
  const { client, snapshot, reply } = setup();
  client.requestEdit(card.cardId);
  snapshot(locked, 2);
  reply('edit.granted', locked, 1, { lockId: 'expired-lock' });
  assert.equal(client.getSnapshot().status, 'offline');
  assert.equal(client.getSnapshot().revision, 2);
  assert.equal(client.getSnapshot().edit.phase, 'idle');
});

function checkEvent(extra = {}) {
  return {
    type: 'edit.check', board: locked, revision: 1, userId: identity.userId,
    clientId: identity.clientId, cardId: card.cardId, lockId: 'lock-1', checkId: 'check-1', ...extra,
  };
}

test('期限確認で未保存の下書きを返し、途中保存の応答で入力中の内容を上書きしない', () => {
  const { client, grant, emit, reply, commands } = setup();
  grant();
  client.updateDraft({ text: '途中保存', position: { x: 10, y: 20, z: 0 } });
  emit(checkEvent());
  const sent = commands.at(-1);
  assert.equal(sent.type, 'edit.check.reply');
  assert.equal(sent.changed, true);
  assert.equal(sent.content.text, '途中保存');
  assert.equal(sent.checkId, 'check-1');
  assert.equal(client.getSnapshot().edit.phase, 'editing');
  const count = commands.length;
  emit(checkEvent());
  assert.equal(commands.length, count);
  client.updateDraft({ text: '応答待ちの間の入力' });
  const saved = { ...locked, cards: [{ ...locked.cards[0], ...sent.content }] };
  reply('edit.checked', saved, 2, { lockId: 'lock-1', checkId: 'check-1', outcome: 'saved' });
  assert.equal(client.getSnapshot().board.cards[0].text, '途中保存');
  assert.equal(client.getSnapshot().edit.draft.text, '応答待ちの間の入力');
  emit(checkEvent({ board: saved, revision: 2, checkId: 'check-2' }));
  assert.equal(commands.at(-1).content.text, '応答待ちの間の入力');
  assert.equal(client.commitEdit(), true);
});

test('入力を元に戻した下書きは変更なしと返し、サーバー側解除で編集を終了する', () => {
  const { client, grant, emit, reply, commands } = setup();
  grant();
  client.updateDraft({ text: 'temporary' });
  client.updateDraft({ text: card.text });
  emit(checkEvent());
  assert.equal(commands.at(-1).changed, false);
  assert.equal('content' in commands.at(-1), false);
  reply('edit.checked', board, 2, { lockId: 'lock-1', checkId: 'check-1', outcome: 'released' });
  assert.equal(client.getSnapshot().edit.phase, 'idle');
  assert.equal(client.getSnapshot().error, null);
});

test('期限確認には端末・ユーザー・カード・ロックが一致した場合だけ返答する', () => {
  const { client, grant, emit, commands } = setup();
  grant();
  const count = commands.length;
  for (const mismatch of [{ clientId: 'other' }, { userId: 'other' }, { cardId: 'other' }, { lockId: 'old' }]) {
    emit(checkEvent(mismatch));
  }
  assert.equal(commands.length, count);
  assert.equal(client.getSnapshot().edit.phase, 'editing');
});

test('確定・取消の送信中は期限確認に返答せず、通常操作の完了を待つ', () => {
  for (const operation of ['commitEdit', 'cancelEdit']) {
    const { client, grant, emit, commands } = setup();
    grant();
    client[operation]();
    const count = commands.length;
    emit(checkEvent());
    assert.equal(commands.length, count);
    assert.equal(client.getSnapshot().edit.phase, operation === 'commitEdit' ? 'saving' : 'cancelling');
  }
});

test('別カードの新しい通知が先着しても有効な期限確認には最新の保存内容を基準に返答する', () => {
  const { client, grant, emit, snapshot, commands } = setup();
  grant();
  client.updateDraft({ text: 'new draft' });
  snapshot({ ...locked, cards: [...locked.cards, { ...card, cardId: 'other' }] }, 3);
  emit(checkEvent());
  assert.equal(commands.at(-1).type, 'edit.check.reply');
  assert.equal(commands.at(-1).content.text, 'new draft');
  assert.equal(client.getSnapshot().revision, 3);
  assert.equal(client.getSnapshot().board.cards.length, 2);
});

test('古い問い合わせへの拒否と通常取消後の途中保存応答でロックを復活させない', () => {
  const { client, grant, emit, reply, commands } = setup();
  grant();
  client.updateDraft({ text: 'draft' });
  emit(checkEvent());
  const checkReply = commands.at(-1);
  reply('edit.rejected', locked, 1, { reason: '期限確認終了' });
  assert.equal(client.getSnapshot().edit.phase, 'editing');
  client.cancelEdit();
  reply('edit.cancelled', board, 3);
  emit({
    ...checkReply, type: 'edit.checked', outcome: 'saved', revision: 2,
    board: { ...locked, cards: [{ ...locked.cards[0], text: 'draft' }] },
  });
  assert.equal(client.getSnapshot().status, 'ready');
  assert.equal(client.getSnapshot().edit.phase, 'idle');
  assert.equal(client.getSnapshot().revision, 3);
});

test('SSEで処理済みの許可にHTTP応答が遅れても、編集中の下書きを維持する', () => {
  const { client, grant, reply, snapshot } = setup();
  grant();
  client.updateDraft({ text: 'draft' });
  snapshot(locked, 2);
  reply('edit.granted', locked, 1, { lockId: 'lock-1' });
  assert.equal(client.getSnapshot().status, 'ready');
  assert.equal(client.getSnapshot().edit.draft.text, 'draft');
});

test('無応答によるロック解除通知で下書きを閉じ、再取得では再起動後のrevisionも受け入れる', () => {
  const { client, grant, emit, snapshot } = setup();
  grant();
  emit({
    type: 'edit.released', board, revision: 2, userId: identity.userId,
    clientId: identity.clientId, cardId: card.cardId, lockId: 'lock-1', reason: 'timeout',
  });
  assert.equal(client.getSnapshot().edit.phase, 'idle');
  assert.match(client.getSnapshot().error, /解除/);
  client.disconnect();
  client.connect();
  snapshot(board, 0);
  assert.equal(client.getSnapshot().status, 'ready');
  assert.equal(client.getSnapshot().revision, 0);
});

test('通常確定・取消の完了より先に解除後のスナップショットが届いても成功を誤認しない', () => {
  for (const operation of ['commitEdit', 'cancelEdit']) {
    const { client, grant, snapshot, reply } = setup();
    grant();
    client[operation]();
    snapshot(board, 2);
    assert.equal(client.getSnapshot().edit.phase, operation === 'commitEdit' ? 'saving' : 'cancelling');
    reply(operation === 'commitEdit' ? 'edit.committed' : 'edit.cancelled', board, 2);
    assert.equal(client.getSnapshot().edit.phase, 'idle');
    assert.equal(client.getSnapshot().error, null);
  }
});
