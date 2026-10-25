import { createBoard, createEmptyCard } from '../domain/board.ts';

export const cid = number => ({ type: 'card', uuid: `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}` });
export const aid = number => ({ ...cid(number), type: 'arrow' });
export const identity = { boardId: 'board', userId: 'user', clientId: 'client' };
export const word = (number = 1, patch = {}) => ({
  ...createEmptyCard('word', { x: number * 250, y: 100, z: number }, '#FFF0A8', cid(number)), text: `word-${number}`, ...patch,
});
export const block = (number = 3, patch = {}) => ({
  ...createEmptyCard('block', { x: number * 250, y: 100, z: number }, '#DDF5D7', cid(number)),
  text: 'ideas', relatedIds: [cid(1)], ...patch,
});
export const board = (cards = [word(), word(2), block()], arrows = []) => ({ ...createBoard('board'), cards, arrows });
export const arrow = (number = 1, patch = {}) => ({ arrowId: aid(number), sourceCardId: cid(1), targetCardId: cid(2), sourceAnchor: 'east', targetAnchor: 'west', ...patch });
export const snapshot = (value = board(), revision = 0, extra = {}) => ({
  type: 'board.snapshot', board: value, revision, serverNow: 0, generation: { status: 'idle' }, generationSequence: 0, ...extra,
});
export function commands(client = identity) {
  let request = 0;
  return (type, fields = {}) => ({ ...client, type, requestId: `request-${++request}`, ...fields });
}
