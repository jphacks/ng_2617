import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { randomUUID } from './uuid.ts';
import { newCardId, newArrowId } from './board.ts';

test('HTTP環境のようにrandomUUIDがない場合もルーム・付箋・矢印用のUUIDを生成できる', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
  } });
  t.after(() => Object.defineProperty(globalThis, 'crypto', descriptor));
  const ids = [randomUUID(), newCardId().uuid, newArrowId().uuid];
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(new Set(ids).size, ids.length);
});
