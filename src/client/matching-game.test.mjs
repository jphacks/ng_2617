import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoardService } from '../server/board-service.ts';
import { fakeClock } from '../test/fake-clock.mjs';
import { board, word, identity } from '../test/board-fixtures.mjs';
import { connectedClient, until } from '../test/transport-harness.mjs';
import { MATCHING_DURATION_MS as DURATION, MATCHING_FINALIZE_MS as FINALIZE } from '../domain/matching.ts';

async function setup(t, count = 4, intercept) {
  const clock = fakeClock(); const service = createBoardService([board(Array.from({ length: count }, (_, i) => word(i + 1)))], { now: clock.now, schedule: clock.schedule });
  const first = connectedClient(service, identity, intercept);
  const second = connectedClient(service, { ...identity, userId: 'other', clientId: 'other-client' });
  first.client.connect(); second.client.connect();
  await until(() => first.client.getSnapshot().status === 'ready' && second.client.getSnapshot().status === 'ready');
  t.after(() => { service.dispose(); first.client.disconnect(); second.client.disconnect(); });
  const state = () => first.client.getSnapshot(); const game = () => state().board.matching;
  const select = async id => {
    first.client.execute({ type: 'matching.select', gameId: game().gameId, turnId: game().turnId, copyId: id });
    await until(() => game().selected.includes(id));
  };
  const startWriting = async () => {
    first.client.execute({ type: 'matching.start' }); await until(() => !!game());
    const ids = game().slots.filter(Boolean).slice(0, 2); await select(ids[0]); await select(ids[1]);
    await until(() => !!state().matchingInput && !!second.client.getSnapshot().matchingInput);
  };
  return { clock, service, first, second, state, game, select, startWriting };
}

test('HTTP＋SSEの2端末で選択・途中入力・最終本文・終了後の案内を同期する', async t => {
  const s = await setup(t, 2); await s.startWriting();
  assert.equal(s.state().board.timer.durationMs, DURATION);
  s.first.client.updateMatchingDraft('アイデアの途中');
  await until(() => s.second.client.getSnapshot().board.matching.drafts[0].card.text === 'アイデアの途中');
  s.second.client.updateMatchingDraft('もうひとつのアイデア');
  await until(() => s.game().drafts[1].card.text === 'もうひとつのアイデア');
  assert.equal(s.first.client.execute({ type: 'timer.stop' }), false);
  assert.equal(s.first.client.requestEdit(s.state().board.cards[0].cardId), false);
  await s.clock.advance(DURATION);
  assert.equal(s.game().step, 'closing'); assert.equal(s.first.client.updateMatchingDraft('期限後'), false);
  s.first.client.updateMatchingDraft('日本語の最終本文', true);
  await until(() => s.game().drafts[0].finalized);
  await s.clock.advance(FINALIZE); await until(() => !s.game());
  assert.deepEqual(s.state().board, s.second.client.getSnapshot().board);
  assert.equal(s.state().board.cards.length, 4); assert.equal(s.state().board.cards[2].text, '日本語の最終本文');
  assert.equal(s.state().generatedCardIds.length, 2); assert.match(s.state().matchingNotice, /2件/);
  assert.equal(s.state().matchingInput, null); assert.equal(s.state().pendingCommands.length, 0);
});
test('接続中の同じ手番に再接続した場合だけローカルの未送信本文を再共有する', async t => {
  const s = await setup(t); await s.startWriting();
  s.first.streams.at(-1).onerror(); assert.equal(s.state().status, 'offline');
  assert.equal(s.first.client.updateMatchingDraft('切断中の本文'), false);
  assert.equal(s.state().matchingInput.text, '切断中の本文');
  s.first.client.connect(); await until(() => s.state().status === 'ready');
  await until(() => s.second.client.getSnapshot().board.matching.drafts[0].card.text === '切断中の本文');
  assert.equal(s.state().matchingInput.text, '切断中の本文');
  s.first.streams.at(-1).onerror(); await s.clock.advance(DURATION + FINALIZE);
  s.first.client.connect(); await until(() => s.state().status === 'ready');
  assert.equal(s.state().matchingInput, null); assert.equal(s.game().step, 'selecting');
  assert.equal(s.state().board.cards.at(-1).text, '切断中の本文');
});
test('途中参加は現在の入力を閲覧でき、同じユーザーの新タブには受理済み本文を引き継ぐ', async t => {
  const s = await setup(t); await s.startWriting(); s.first.client.updateMatchingDraft('引き継ぐ本文');
  await until(() => s.game().drafts[0].card.text === '引き継ぐ本文');
  const watcher = connectedClient(s.service, { ...identity, userId: 'watcher', clientId: 'watcher' });
  watcher.client.connect(); t.after(() => watcher.client.disconnect()); await until(() => watcher.client.getSnapshot().status === 'ready');
  assert.equal(watcher.client.getSnapshot().matchingInput, null);
  assert.equal(watcher.client.getSnapshot().board.matching.drafts[0].card.text, '引き継ぐ本文');
  const takeover = connectedClient(s.service, { ...identity, clientId: 'new-client' });
  takeover.client.connect(); t.after(() => takeover.client.disconnect()); await until(() => takeover.client.getSnapshot().status === 'ready');
  await until(() => !s.state().matchingInput);
  assert.equal(takeover.client.getSnapshot().matchingInput.text, '引き継ぐ本文');
  assert.equal(s.first.client.updateMatchingDraft('古いタブ'), false);
});
test('下書きのHTTP失敗と逆順応答でもローカルの最新本文を巻き戻さない', async t => {
  const requests = []; let rejectDraft = true;
  const s = await setup(t, 4, command => {
    if (command.type === 'matching.draft') {
      requests.push(command);
      if (rejectDraft) throw new Error('offline request');
    }
  });
  await s.startWriting(); s.first.client.updateMatchingDraft('保存されていない本文');
  await until(() => !!s.state().error); assert.equal(s.state().status, 'ready');
  assert.equal(s.state().matchingInput.text, '保存されていない本文');
  rejectDraft = false; s.first.client.updateMatchingDraft('最新の本文');
  await until(() => s.game().drafts[0].card.text === '最新の本文');
  s.first.client.retryPending(); await until(() => !s.state().pendingCommands.length);
  assert.equal(s.game().drafts[0].card.text, '最新の本文'); assert.equal(s.state().matchingInput.text, '最新の本文');
  assert.equal(requests[0].sequence, requests.at(-1).sequence);
});

test('0秒時点の最終本文は同じ入力権でclosing中に再接続すれば再送できる', async t => {
  let dropFinal = true;
  const s = await setup(t, 2, command => {
    if (command.type === 'matching.draft' && command.final && dropFinal) throw new Error('final response lost');
  });
  await s.startWriting(); s.first.client.updateMatchingDraft('変換途中');
  await until(() => s.game().drafts[0].card.text === '変換途中'); await s.clock.advance(DURATION);
  s.first.client.updateMatchingDraft('確定した日本語', true); await until(() => !!s.state().error);
  s.first.streams.at(-1).onerror(); dropFinal = false; s.first.client.connect();
  await until(() => s.state().status === 'ready' && s.game().drafts[0].finalized);
  await s.clock.advance(FINALIZE); await until(() => !s.game());
  assert.equal(s.state().board.cards.at(-1).text, '確定した日本語');
});
