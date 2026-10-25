import assert from 'node:assert/strict';
import test from 'node:test';
import { generatedGuidance } from './generated-guidance.ts';
import { word } from '../test/board-fixtures.mjs';

test('案内はカード全体の位置・寸法・ズームを使い、一部だけ表示されても継続する', () => {
  const card = word(1, { position: { x: 100, y: 100, z: 0 } }); const bounds = { width: 800, height: 600 };
  assert.equal(generatedGuidance(card, { x: 0, y: 0, zoom: 1 }, bounds).visible, true);
  const partial = generatedGuidance(card, { x: 600, y: 0, zoom: 1 }, bounds);
  assert.equal(partial.visible, false); assert.ok(partial.x <= 765); assert.ok(partial.x >= 35);
  assert.equal(generatedGuidance(card, { x: -110, y: 0, zoom: 1 }, bounds).visible, false);
  assert.equal(generatedGuidance(card, { x: 0, y: 0, zoom: 2 }, bounds).visible, false);
  assert.equal(generatedGuidance(card, { x: 0, y: 0, zoom: .5 }, bounds).visible, true);
});
