import type { Anchor, Arrow, Board, BoardObjectId, Card, CardId, CardPosition, CardShape } from './board';
import { CARD_SIZES, MAX_CARD_SIZE, REACTIONS, TIMER_DURATION_MS, objectKey, sameObjectId } from './board.ts';
import { BOARD_FILE_FORMAT, BOARD_FILE_VERSION, MAX_BOARD_FILE_BYTES, MAX_BOARD_FILE_CARDS, MAX_BOARD_FILE_ARROWS, MAX_BOARD_FILE_COORDINATE, type BoardFile } from './board-file.ts';
import type { BoardCommand, BoardEvent, CardChange, CardPatch, GenerationState } from './board-protocol';
import { canonical } from './board-protocol.ts';
import { MATCHING_DURATION_MS, MATCHING_SLOT_COUNT, type MatchingGame } from './matching.ts';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export const validId = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 128;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(key => allowed.includes(key));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validObjectId(v: unknown, type?: BoardObjectId['type']): v is BoardObjectId {
  return record(v) && keys(v, ['type', 'uuid']) && (v.type === 'card' || v.type === 'arrow') &&
    (type === undefined || v.type === type) && typeof v.uuid === 'string' && uuid.test(v.uuid);
}
export const validCardId = (v: unknown): v is CardId => validObjectId(v, 'card');
export function validIds(v: unknown, type?: BoardObjectId['type'], allowEmpty = false): v is BoardObjectId[] {
  return Array.isArray(v) && (allowEmpty || v.length > 0) && v.length <= 10_000 &&
    v.every(id => validObjectId(id, type)) && new Set(v.map(objectKey)).size === v.length;
}
export function validPosition(v: unknown): v is CardPosition {
  return record(v) && keys(v, ['x', 'y', 'z']) && [v.x, v.y, v.z].every(finite);
}
export function validShape(v: unknown, kind?: Card['cardKind']): v is CardShape {
  return record(v) && keys(v, ['width', 'height']) && finite(v.width) && finite(v.height) &&
    v.width >= (kind ? CARD_SIZES[kind].minWidth : 160) && v.height >= (kind ? CARD_SIZES[kind].minHeight : 150) &&
    v.width <= MAX_CARD_SIZE && v.height <= MAX_CARD_SIZE;
}
export const validAnchor = (v: unknown): v is Anchor => ['north', 'east', 'south', 'west'].includes(v as string);
export const validLevel = (v: unknown) => ['low', 'mid', 'high'].includes(v as string);
export function validCard(v: unknown): v is Card {
  if (!record(v) || (v.cardKind !== 'word' && v.cardKind !== 'block') || !validCardId(v.cardId) ||
      !validShape(v.shape, v.cardKind) || !validPosition(v.position) || !text(v.color, 128) || !v.color ||
      !text(v.font, 256) || !text(v.text, 100_000) || (v.editingUser !== undefined &&
        (!record(v.editingUser) || !keys(v.editingUser, ['userId']) || !validId(v.editingUser.userId)))) return false;
  const common = ['cardId', 'cardKind', 'shape', 'position', 'color', 'font', 'text', 'editingUser'];
  if (v.cardKind === 'word') return keys(v, common);
  if (!keys(v, [...common, 'relatedIds', 'reactions']) || !validIds(v.relatedIds, 'card', true) ||
      v.relatedIds.some(id => sameObjectId(id, v.cardId as CardId)) || !Array.isArray(v.reactions)) return false;
  const seen = new Set<string>();
  return v.reactions.every(reaction => {
    if (!record(reaction) || !keys(reaction, ['reactionId', 'userId']) || !validId(reaction.userId) ||
        !REACTIONS.some(item => item.reactionId === reaction.reactionId)) return false;
    const key = JSON.stringify([reaction.userId, reaction.reactionId]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
export function validArrow(v: unknown): v is Arrow {
  return record(v) && keys(v, ['arrowId', 'sourceCardId', 'targetCardId', 'sourceAnchor', 'targetAnchor']) &&
    validObjectId(v.arrowId, 'arrow') && validCardId(v.sourceCardId) && validCardId(v.targetCardId) &&
    !sameObjectId(v.sourceCardId, v.targetCardId) && validAnchor(v.sourceAnchor) && validAnchor(v.targetAnchor);
}
export const arrowConnectionKey = (a: Arrow): string => JSON.stringify([objectKey(a.sourceCardId), objectKey(a.targetCardId), a.sourceAnchor, a.targetAnchor]);
export function validBoard(v: unknown): v is Board {
  if (!record(v) || !keys(v, ['boardId', 'cards', 'arrows', 'timer', 'matching', 'settings']) || !validId(v.boardId) ||
      (v.settings !== undefined && (!record(v.settings) || !keys(v.settings, ['autoGenerationEnabled']) || typeof v.settings.autoGenerationEnabled !== 'boolean')) ||
      !Array.isArray(v.cards) || !v.cards.every(validCard) || !Array.isArray(v.arrows) || !v.arrows.every(validArrow) ||
      !record(v.timer) || v.timer.durationMs !== (v.matching ? MATCHING_DURATION_MS : TIMER_DURATION_MS)) return false;
  const ids = new Set(v.cards.map(card => objectKey(card.cardId)));
  if (ids.size !== v.cards.length || new Set(v.arrows.map(a => objectKey(a.arrowId))).size !== v.arrows.length ||
      new Set(v.arrows.map(arrowConnectionKey)).size !== v.arrows.length) return false;
  if (v.cards.some(card => card.cardKind === 'block' && card.relatedIds.some((id: CardId) => !ids.has(objectKey(id)))) ||
      v.arrows.some(a => !ids.has(objectKey(a.sourceCardId)) || !ids.has(objectKey(a.targetCardId)))) return false;
  if (v.matching !== undefined && (!validMatching(v.matching, v.cards) ||
      (v.matching.step === 'closing' ? v.timer.state !== 'stopped' || v.timer.remainingMs !== 0 : v.timer.state !== 'running'))) return false;
  return v.timer.state === 'stopped'
    ? keys(v.timer, ['durationMs', 'state', 'remainingMs']) && finite(v.timer.remainingMs) && v.timer.remainingMs >= 0 && v.timer.remainingMs <= (v.timer.durationMs as number)
    : v.timer.state === 'running' && keys(v.timer, ['durationMs', 'state', 'endsAt']) && finite(v.timer.endsAt) && v.timer.endsAt >= 0;
}
function validMatching(v: unknown, cards: readonly Card[]): v is MatchingGame {
  if (!record(v) || !keys(v, ['gameId', 'turnId', 'step', 'selectorUserId', 'copies', 'slots', 'reserve', 'used',
    'selected', 'drafts', 'abortConfirmationId', 'finishAfterClosing', 'addedCardIds', 'notice']) ||
    ![v.gameId, v.turnId, v.selectorUserId].every(validId) || !['selecting', 'writing', 'closing'].includes(v.step as string) ||
    !text(v.notice, 1000) || (v.abortConfirmationId !== undefined && !validId(v.abortConfirmationId)) ||
    (v.finishAfterClosing !== undefined && typeof v.finishAfterClosing !== 'boolean') ||
    !Array.isArray(v.copies) || !Array.isArray(v.slots) || v.slots.length !== MATCHING_SLOT_COUNT ||
    !Array.isArray(v.reserve) || !Array.isArray(v.used) || !Array.isArray(v.selected) || !Array.isArray(v.drafts) ||
    !validIds(v.addedCardIds, 'card', true)) return false;
  const originals = new Map(cards.map(card => [objectKey(card.cardId), card]));
  const copies = new Map<string, Card>(); const sourceIds = new Set<string>();
  for (const copy of v.copies) {
    if (!record(copy) || !keys(copy, ['copyId', 'card']) || !validId(copy.copyId) || copies.has(copy.copyId) ||
      !validCard(copy.card) || copy.card.editingUser || canonical(copy.card) !== canonical(originals.get(objectKey(copy.card.cardId))) || sourceIds.has(objectKey(copy.card.cardId))) return false;
    copies.set(copy.copyId, copy.card); sourceIds.add(objectKey(copy.card.cardId));
  }
  const eligible = new Set([...copies].filter(([, card]) => card.cardKind === 'word' && card.text.trim()).map(([id]) => id));
  const pooled = [...v.slots.filter(id => id !== null), ...v.reserve, ...v.used];
  const slots = v.slots;
  if (pooled.some(id => typeof id !== 'string' || !eligible.has(id)) || new Set(pooled).size !== pooled.length || pooled.length !== eligible.size ||
    v.selected.some(id => typeof id !== 'string' || !slots.includes(id)) || new Set(v.selected).size !== v.selected.length ||
    (v.step === 'selecting' ? v.selected.length > 1 || v.drafts.length !== 0 : v.selected.length !== 2 || v.drafts.length === 0) ||
    (v.finishAfterClosing !== undefined && v.step !== 'closing') ||
    v.addedCardIds.some(id => originals.get(objectKey(id))?.cardKind !== 'block' || sourceIds.has(objectKey(id))) ||
    sourceIds.size + v.addedCardIds.length !== cards.length) return false;
  const users = new Set<string>(); const draftIds = new Set<string>();
  const related = v.selected.map(id => copies.get(id as string)!.cardId);
  return v.drafts.every(draft => {
    if (!record(draft) || !keys(draft, ['userId', 'writerClientId', 'writerToken', 'sequence', 'finalized', 'card']) ||
      ![draft.userId, draft.writerClientId, draft.writerToken].every(validId) || users.has(draft.userId as string) ||
      !Number.isSafeInteger(draft.sequence) || (draft.sequence as number) < 0 || typeof draft.finalized !== 'boolean' ||
      !validCard(draft.card) || draft.card.cardKind !== 'block' || draft.card.editingUser || draft.card.reactions.length ||
      originals.has(objectKey(draft.card.cardId)) || draftIds.has(objectKey(draft.card.cardId)) ||
      draft.card.relatedIds.length !== 2 || !draft.card.relatedIds.every(id => related.some(other => sameObjectId(id, other)))) return false;
    users.add(draft.userId as string); draftIds.add(objectKey(draft.card.cardId)); return true;
  });
}
/** ファイルとHTTPコマンドの両方で同じ検証を行う。実行時の属性は受け入れない。 */
export function validBoardFile(value: unknown): value is BoardFile {
  if (!record(value) || !keys(value, ['format', 'version', 'cards', 'arrows']) ||
      value.format !== BOARD_FILE_FORMAT || value.version !== BOARD_FILE_VERSION ||
      !Array.isArray(value.cards) || value.cards.length > MAX_BOARD_FILE_CARDS ||
      !Array.isArray(value.arrows) || value.arrows.length > MAX_BOARD_FILE_ARROWS ||
      value.cards.some(card => !record(card) || 'editingUser' in card || !validCard(card) ||
        Math.abs(card.position.x) > MAX_BOARD_FILE_COORDINATE || Math.abs(card.position.y) > MAX_BOARD_FILE_COORDINATE)) return false;
  if (!validBoard({ boardId: 'file', cards: value.cards, arrows: value.arrows,
    timer: { durationMs: TIMER_DURATION_MS, state: 'stopped', remainingMs: TIMER_DURATION_MS } })) return false;
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_BOARD_FILE_BYTES; }
  catch { return false; }
}
export function validPatch(v: unknown): v is CardPatch {
  return record(v) && keys(v, ['shape', 'position', 'color', 'font', 'text', 'relatedIds']) &&
    (v.shape === undefined || validShape(v.shape)) && (v.position === undefined || validPosition(v.position)) &&
    (v.color === undefined || (text(v.color, 128) && !!v.color)) && (v.font === undefined || text(v.font, 256)) &&
    (v.text === undefined || text(v.text, 100_000)) && (v.relatedIds === undefined || validIds(v.relatedIds, 'card', true));
}
function validChanges(v: unknown): v is CardChange[] {
  return Array.isArray(v) && v.length > 0 && v.length <= 10_000 && v.every(change => record(change) &&
    keys(change, ['cardId', 'patch']) && validCardId(change.cardId) && validPatch(change.patch)) &&
    new Set(v.map(change => objectKey(change.cardId))).size === v.length;
}
export const COMMAND_TYPES = [
  'board.get', 'edit.request', 'edit.commit', 'edit.cancel', 'edit.check.reply', 'card.create', 'objects.delete',
  'board.clear', 'board.restore-sample', 'board.settings.update', 'board.leave', 'reaction.add', 'reaction.remove', 'arrow.create', 'arrow.delete',
  'timer.start', 'timer.stop', 'timer.reset', 'generation.request', 'board.import',
  'matching.start', 'matching.select', 'matching.draft', 'matching.abort.request', 'matching.abort.confirm', 'matching.abort.cancel',
] as const;
/** 種類別の境界検証。編集内容と即時操作の属性は混ぜない。 */
export function validCommand(v: unknown): v is BoardCommand {
  if (!record(v) || ![v.boardId, v.userId, v.clientId, v.requestId].every(validId)) return false;
  const common = ['type', 'boardId', 'userId', 'clientId', 'requestId'];
  const only = (...fields: string[]) => keys(v, [...common, ...fields]);
  switch (v.type) {
    case 'matching.start': return only();
    case 'matching.select': return only('gameId', 'turnId', 'copyId') && [v.gameId, v.turnId, v.copyId].every(validId);
    case 'matching.draft': return only('gameId', 'turnId', 'writerToken', 'sequence', 'text', 'final') &&
      [v.gameId, v.turnId, v.writerToken].every(validId) && Number.isSafeInteger(v.sequence) && (v.sequence as number) > 0 &&
      text(v.text, 100_000) && typeof v.final === 'boolean';
    case 'matching.abort.request': return only('gameId') && validId(v.gameId);
    case 'matching.abort.confirm': case 'matching.abort.cancel': return only('gameId', 'confirmationId') && [v.gameId, v.confirmationId].every(validId);
    case 'board.settings.update': return only('autoGenerationEnabled') && typeof v.autoGenerationEnabled === 'boolean';
    case 'board.get': case 'board.clear': case 'board.restore-sample': case 'board.leave':
    case 'timer.start': case 'timer.stop': case 'timer.reset': return only();
    case 'edit.request': return only('cardIds') && validIds(v.cardIds, 'card');
    case 'edit.commit': return only('lockId', 'changes') && validId(v.lockId) && validChanges(v.changes);
    case 'edit.cancel': return only('lockId') && validId(v.lockId);
    case 'edit.check.reply': return validId(v.lockId) && validId(v.checkId) &&
      (v.state === 'cancelling' ? only('lockId', 'checkId', 'state') :
        (v.state === 'editing' || v.state === 'committing') && only('lockId', 'checkId', 'state', 'changes') && validChanges(v.changes));
    case 'board.import': return only('file') && validBoardFile(v.file);
    case 'card.create': return only('card') && validCard(v.card) && !v.card.editingUser && v.card.text === '' &&
      (v.card.cardKind === 'word' || (!v.card.relatedIds.length && !v.card.reactions.length));
    case 'objects.delete': return only('objectIds') && validIds(v.objectIds);
    case 'reaction.add': case 'reaction.remove': return only('cardId', 'reactionId') && validCardId(v.cardId) &&
      REACTIONS.some(r => r.reactionId === v.reactionId);
    case 'arrow.create': return only('arrow') && validArrow(v.arrow);
    case 'arrow.delete': return only('arrowId') && validObjectId(v.arrowId, 'arrow');
    case 'generation.request': return only('level') && validLevel(v.level);
    default: return false;
  }
}
function validGeneration(v: unknown): v is GenerationState {
  return record(v) && (v.status === 'idle' || (['running', 'completed', 'failed', 'discarded'].includes(v.status as string) &&
    validId(v.generationId) && validLevel(v.level) && (v.source === 'manual' || v.source === 'automatic') &&
    (v.message === undefined || text(v.message, 1000))));
}
export function validEvent(v: unknown): v is BoardEvent {
  if (!record(v) || !validBoard(v.board) || !Number.isSafeInteger(v.revision) || (v.revision as number) < 0 ||
      !finite(v.serverNow) || !Number.isSafeInteger(v.generationSequence) || (v.generationSequence as number) < 0 || !validGeneration(v.generation)) return false;
  if (v.type === 'board.snapshot' || v.type === 'generation.updated') return true;
  if (v.type === 'board.cards-generated') return validId(v.eventId) && validId(v.generationId) &&
    validIds(v.generatedCardIds, 'card', true) && v.generatedCardIds.every(id => v.board && (v.board as Board).cards.some(card => sameObjectId(card.cardId, id)));
  const loan = () => validIds(v.cardIds, 'card') && validId(v.lockId);
  if (v.type === 'edit.check' || v.type === 'edit.released') return loan() && validId(v.userId) && validId(v.clientId) &&
    (v.type === 'edit.check' ? validId(v.checkId) : v.reason === 'timeout');
  if (!validId(v.clientId) || !validId(v.requestId)) return false;
  switch (v.type) {
    case 'edit.granted': case 'edit.committed': case 'edit.cancelled': return loan();
    case 'edit.checked': return loan() && validId(v.checkId) && ['saved', 'released', 'committed', 'cancelled'].includes(v.outcome as string);
    case 'command.accepted': return COMMAND_TYPES.includes(v.commandType as BoardCommand['type']) && typeof v.changed === 'boolean';
    case 'command.rejected': return COMMAND_TYPES.includes(v.commandType as BoardCommand['type']) && text(v.reason, 1000);
    default: return false;
  }
}
