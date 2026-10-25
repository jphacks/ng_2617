import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createBoardSvg } from './board-svg.ts';
import { board, word, block, arrow } from '../test/board-fixtures.mjs';

function svgDocument(board) { return new JSDOM(createBoardSvg(board), { contentType: 'image/svg+xml' }).window.document; }

test('SVGは日本語・改行・特殊文字・長文末尾・関連先・リアクションを欠落させない', () => {
  const long = '長文'.repeat(200) + '末尾確認';
  const value = board([word(1, { text: '日本語\n<&>"\'\u0000', color: '#123456' }), word(2, { text: long }),
    block(3, { text: 'まとめ', reactions: [{ reactionId: 'heart', userId: 'a' }] })], [arrow()]);
  const before = structuredClone(value);
  const doc = svgDocument(value);
  const text = doc.documentElement.textContent;
  assert.ok(text.includes('日本語')); assert.ok(text.includes('<&>"\'�'));
  assert.ok(text.includes('末尾確認')); assert.ok(text.includes('関連カード')); assert.ok(text.includes('❤️ 1'));
  assert.equal(doc.querySelectorAll('text').length > 10, true);
  assert.ok(doc.querySelector('rect[fill="#123456"]'));
  assert.equal(doc.querySelectorAll('[marker-end]').length, 1);
  assert.equal(doc.querySelectorAll('button, foreignObject, script').length, 0);
  assert.deepEqual(value, before);
});

test('SVG全体の範囲は負の座標・画面外カードと外側を通る矢印も含む', () => {
  const value = board([word(1, { position: { x: -700, y: -800, z: 1 } }), word(2, { position: { x: 2000, y: 1500, z: 0 } })],
    [arrow(1, { sourceAnchor: 'north', targetAnchor: 'east' })]);
  const doc = svgDocument(value);
  const [x, y, width, height] = doc.documentElement.getAttribute('viewBox').split(' ').map(Number);
  assert.ok(x < -700 && y < -824); assert.ok(x + width > 2234 && y + height > 1710);
  for (const rect of [...doc.querySelectorAll('rect')].slice(1)) {
    assert.ok(Number(rect.getAttribute('x')) >= x);
    assert.ok(Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')) <= x + width);
  }
  assert.ok(svgDocument(board([], [])).documentElement.textContent.includes('空のボード'));
});
