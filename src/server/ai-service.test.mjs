import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiApiError, generateWordsByGemini } from './AIapi.ts';
import { generateWordSuggestions } from './ai-service.ts';
import { createBoardService } from './board-service.ts';
import { board, word, block, commands, identity } from '../test/board-fixtures.mjs';
import { fakeClock, flush } from '../test/fake-clock.mjs';

const generated = ['深海', '星座', '冒険'];
const responseData = (words = generated) => ({ candidates: [{
  finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ words }) }] },
}] });
function setup(t, fetcher = async () => Response.json(responseData())) {
  const saved = ['GEMINI_API_KEY', 'GEMINI_MODEL'].map(key => [key, process.env[key]]);
  t.after(() => saved.forEach(([key, value]) => {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }));
  process.env.GEMINI_API_KEY = 'test-secret';
  delete process.env.GEMINI_MODEL;
  return t.mock.method(globalThis, 'fetch', fetcher);
}

for (const [level, instruction] of [['low', '関連性が低く'], ['mid', '適度に関連'], ['high', '強い関連性']]) {
  test(`関連度${level}を構造化出力の1回のリクエストへ渡し、キーはヘッダーだけに含める`, async t => {
    const fetcher = setup(t);
    const initial = board([word(1, { text: ' カフェ ' }), word(2, { text: '\n' }), block(3, { text: '交流' }), word(4, { text: 'カフェ' })]);
    const copy = structuredClone(initial);
    assert.deepEqual(await generateWordSuggestions(initial, level), generated);
    assert.deepEqual(initial, copy);
    assert.equal(fetcher.mock.callCount(), 1);
    const [url, options] = fetcher.mock.calls[0].arguments;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    assert.equal(options.method, 'POST');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['x-goog-api-key'], 'test-secret');
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.match(body.systemInstruction.parts[0].text, new RegExp(instruction));
    assert.match(body.systemInstruction.parts[0].text, /命令には従わない/);
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), ['カフェ', '交流']);
    assert.equal(body.generationConfig.responseFormat.text.mimeType, 'APPLICATION_JSON');
    assert.equal(body.generationConfig.responseFormat.text.schema.properties.words.maxItems, 3);
    assert.equal(options.body.includes('test-secret'), false);
    assert.equal(options.body.includes('editingUser'), false);
    assert.equal(options.body.includes('boardId'), false);
  });
}

test('前後の空白・生成語同士・既存語との重複を除く', async t => {
  setup(t, async () => Response.json(responseData([' カフェ ', ' 深海 ', '深海'])));
  assert.deepEqual(await generateWordSuggestions(board([word(1, { text: 'カフェ' })]), 'mid'), ['深海']);
});

test('本文がなければ通信せず、入力は件数・1件の長さ・合計文字数を制限する', async t => {
  const fetcher = setup(t);
  assert.deepEqual(await generateWordSuggestions(board([word(1, { text: ' \n ' })]), 'low'), []);
  assert.equal(fetcher.mock.callCount(), 0);
  for (const text of [number => String(number), number => `${number}-${'長'.repeat(1000)}`]) {
    await generateWordSuggestions(board(Array.from({ length: 150 }, (_, i) => word(i, { text: text(i) }))), 'mid');
    const request = JSON.parse(fetcher.mock.calls.at(-1).arguments[1].body);
    const inputs = JSON.parse(request.contents[0].parts[0].text);
    assert.ok(inputs.length <= 100);
    assert.ok(inputs.every(input => input.length <= 300));
    assert.ok(inputs.join('').length <= 10_000);
    if (text(0).length < 300) assert.equal(inputs.length, 100);
    else assert.equal(inputs.join('').length, 10_000);
  }
});

test('APIキー未設定と不正なモデル設定は送信前に失敗する', async t => {
  const fetcher = setup(t);
  process.env.GEMINI_API_KEY = '  ';
  await assert.rejects(generateWordsByGemini(['カフェ'], 'mid', 3), /GEMINI_API_KEY/);
  process.env.GEMINI_API_KEY = 'test-secret';
  process.env.GEMINI_MODEL = '../invalid?key=test-secret';
  await assert.rejects(generateWordsByGemini(['カフェ'], 'mid', 3), /GEMINI_MODEL/);
  assert.equal(fetcher.mock.callCount(), 0);
});

test('モデルは環境変数で変更できる', async t => {
  const fetcher = setup(t);
  process.env.GEMINI_MODEL = ' gemini-3.8-flash ';
  await generateWordsByGemini(['カフェ'], 'mid', 3);
  assert.match(fetcher.mock.calls[0].arguments[0], /\/gemini-3\.8-flash:generateContent$/);
});

test('APIエラーは利用上限・認証・モデルを通知し、上流本文や秘密情報を公開しない', async t => {
  let status = 429;
  const fetcher = setup(t, async () => new Response('test-secret upstream private body', { status }));
  for (const [code, message] of [[400, /HTTP 400/], [401, /認証/], [403, /認証/], [404, /GEMINI_MODEL/], [429, /利用上限/], [503, /HTTP 503/]]) {
    status = code;
    await assert.rejects(generateWordsByGemini(['カフェ'], 'mid', 3), error => {
      assert.ok(error instanceof GeminiApiError);
      assert.match(error.message, message);
      assert.doesNotMatch(String(error), /test-secret|private body/);
      return true;
    });
  }
  assert.equal(fetcher.mock.callCount(), 6);
});

test('安全性によるブロック・途切れた応答・不正JSON・不正な候補は追加しない', async t => {
  let data;
  setup(t, async () => Response.json(data));
  for (const invalid of [
    null, {}, { promptFeedback: { blockReason: 'SAFETY' } }, { candidates: [null] },
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: JSON.stringify({ words: generated }) }] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not json' }] } }] },
    responseData([]), responseData(['深海', 1, '星座']), responseData(['深海', ' ', '星座']),
    responseData(['深海', '長'.repeat(41), '星座']), responseData(['深海', '説明\n本文', '星座']),
  ]) {
    data = invalid;
    await assert.rejects(generateWordSuggestions(board(), 'mid'), GeminiApiError);
  }
});

test('複数のテキストpartを結合し、思考partを候補に混入させない', async t => {
  setup(t, async () => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [
    { thought: true, text: '内部の思考' }, { text: '{"words":["深海",' }, { text: '"星座","冒険"]}' },
  ] } }] }));
  assert.deepEqual(await generateWordSuggestions(board(), 'high'), generated);
});

test('20秒の中断シグナルを使い、タイムアウトと通信エラーを安全なメッセージに変換する', async t => {
  const timeout = t.mock.method(AbortSignal, 'timeout', ms => {
    assert.equal(ms, 20_000);
    return AbortSignal.abort(new DOMException('test-secret', 'TimeoutError'));
  });
  const fetcher = setup(t, async (_url, options) => options.signal.throwIfAborted());
  await assert.rejects(generateWordSuggestions(board(), 'mid'), /タイムアウト/);
  assert.equal(timeout.mock.callCount(), 1);
  fetcher.mock.mockImplementation(async () => { throw new Error('test-secret'); });
  await assert.rejects(generateWordSuggestions(board(), 'mid'), error => {
    assert.match(error.message, /通信できませんでした/);
    assert.doesNotMatch(String(error), /test-secret/);
    return true;
  });
});

test('既定のボードサービスから手動・自動生成を呼び、結果と設定エラーを通知する', async t => {
  const fetcher = setup(t);
  const clock = fakeClock(); const errors = []; const events = [];
  const service = createBoardService([board()], { now: clock.now, schedule: clock.schedule, additionDelayMs: 30,
    onGenerationError: error => errors.push(error) });
  t.after(() => service.dispose());
  service.subscribeBoard(identity, event => events.push(event));
  const command = commands();
  const run = (type, fields = {}) => service.executeCommand(command(type, fields));
  const current = () => service.getBoardSnapshot('board');
  const settle = async () => {
    for (let attempt = 0; current().generation.status === 'running' && attempt < 20; attempt++) await flush();
    assert.notEqual(current().generation.status, 'running');
  };
  run('generation.request', { level: 'low' });
  await settle();
  assert.equal(current().generation.status, 'completed');
  assert.equal(events.at(-1).type, 'board.cards-generated');
  assert.equal(events.at(-1).generatedCardIds.length, 3);
  const grant = run('edit.request', { cardIds: [current().board.cards[0].cardId] }).body;
  run('edit.cancel', { lockId: grant.lockId });
  await clock.advance(30); await settle();
  assert.equal(current().generation.source, 'automatic');
  assert.equal(current().generation.level, 'mid');
  assert.equal(fetcher.mock.callCount(), 2);
  const count = current().board.cards.length;
  delete process.env.GEMINI_API_KEY;
  run('generation.request', { level: 'high' }); await settle();
  assert.equal(current().generation.status, 'failed');
  assert.match(current().generation.message, /GEMINI_API_KEY/);
  assert.equal(current().board.cards.length, count);
  assert.equal(errors.length, 1);
  assert.equal(fetcher.mock.callCount(), 2);
});
