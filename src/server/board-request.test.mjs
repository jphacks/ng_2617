import assert from 'node:assert/strict';
import test from 'node:test';
import { readBoardRequest, MAX_BOARD_REQUEST_BYTES } from './board-request.ts';

test('HTTP本文はContent-Lengthがなくても上限を超えた時点で中止し、不正JSONも拒否する', async () => {
  const request = body => new Request('http://localhost/api/boards/test', { method: 'POST', body });
  assert.deepEqual(await readBoardRequest(request('{"type":"board.import"}')), { value: { type: 'board.import' } });
  assert.equal((await readBoardRequest(request('{'))).status, 400);
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(MAX_BOARD_REQUEST_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close();
  } });
  assert.equal((await readBoardRequest(new Request('http://localhost', { method: 'POST', body: stream, duplex: 'half' }))).status, 413);
  assert.equal((await readBoardRequest(new Request('http://localhost', {
    method: 'POST', headers: { 'content-length': String(MAX_BOARD_REQUEST_BYTES + 1) }, body: '{}',
  }))).status, 413);
});
