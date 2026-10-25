import type { BoardFile } from './board-file';
import type { Arrow, ArrowId, Board, BoardObjectId, Card, CardId, BlockCard, WordCard, CardShape, CardPosition, RelationLevel } from './board';
import { objectKey } from './board.ts';

/** 識別情報であり、認証の代わりにはならない。 */
export type ClientIdentity = Readonly<{ boardId: string; userId: string; clientId: string }>;
export type CardContent = Omit<WordCard, 'cardId' | 'editingUser'> | Omit<BlockCard, 'cardId' | 'editingUser' | 'reactions'>;
/** 保存は変更属性のみ。位置保存で本文・リアクションを巻き戻さない。 */
export type CardPatch = Readonly<{
  shape?: CardShape; position?: CardPosition; color?: string; font?: string; text?: string; relatedIds?: readonly CardId[];
}>;
export type CardChange = Readonly<{ cardId: CardId; patch: CardPatch }>;
type Request = ClientIdentity & Readonly<{ requestId: string }>;
export type EditCommand = Request & (
  | { type: 'edit.request'; cardIds: readonly CardId[] }
  | { type: 'edit.commit'; lockId: string; changes: readonly CardChange[] }
  | { type: 'edit.cancel'; lockId: string }
  | ({ type: 'edit.check.reply'; lockId: string; checkId: string } & (
    | { state: 'editing' | 'committing'; changes: readonly CardChange[] }
    | { state: 'cancelling' }
  ))
);
export type ImmediateCommand = Request & (
  | { type: 'matching.start' }
  | { type: 'matching.select'; gameId: string; turnId: string; copyId: string }
  | { type: 'matching.draft'; gameId: string; turnId: string; writerToken: string; sequence: number; text: string; final: boolean }
  | { type: 'matching.abort.request'; gameId: string }
  | { type: 'matching.abort.confirm' | 'matching.abort.cancel'; gameId: string; confirmationId: string }
  | { type: 'card.create'; card: Card }
  | { type: 'objects.delete'; objectIds: readonly BoardObjectId[] }
  | { type: 'board.import'; file: BoardFile }
  | { type: 'board.clear' | 'board.restore-sample' }
  | { type: 'reaction.add' | 'reaction.remove'; cardId: CardId; reactionId: string }
  | { type: 'arrow.create'; arrow: Arrow }
  | { type: 'arrow.delete'; arrowId: ArrowId }
  | { type: 'timer.start' | 'timer.stop' | 'timer.reset' }
  | { type: 'generation.request'; level: RelationLevel }
);
export type BoardCommand = (Request & { type: 'board.get' }) | EditCommand | ImmediateCommand;
export type ImmediateOperation = ImmediateCommand extends infer C ? C extends ImmediateCommand ? Omit<C, keyof Request> : never : never;

export type GenerationState = Readonly<{ status: 'idle' }> | Readonly<{
  status: 'running' | 'completed' | 'failed' | 'discarded'; generationId: string;
  level: RelationLevel; source: 'manual' | 'automatic'; message?: string;
}>;
export type SnapshotData = Readonly<{
  board: Board; revision: number; serverNow: number;
  generation: GenerationState; generationSequence: number;
}>;
type Reply = Readonly<{ clientId: string; requestId: string }>;
type Loan = Readonly<{ cardIds: readonly CardId[]; lockId: string }>;
export type BoardEvent = SnapshotData & (
  | { type: 'board.snapshot' | 'generation.updated' }
  | (Reply & Loan & { type: 'edit.granted' | 'edit.committed' | 'edit.cancelled' })
  | (Reply & Loan & { type: 'edit.checked'; checkId: string; outcome: 'saved' | 'released' | 'committed' | 'cancelled' })
  | (Loan & { type: 'edit.check'; userId: string; clientId: string; checkId: string })
  | (Loan & { type: 'edit.released'; userId: string; clientId: string; reason: 'timeout' })
  | (Reply & { type: 'command.accepted'; commandType: BoardCommand['type']; changed: boolean })
  | (Reply & { type: 'command.rejected'; commandType: BoardCommand['type']; reason: string })
  | { type: 'board.cards-generated'; eventId: string; generationId: string; generatedCardIds: readonly CardId[] }
);

export function cardContent(card: Card): CardContent {
  const common = { cardKind: card.cardKind, shape: { ...card.shape }, position: { ...card.position }, color: card.color, font: card.font, text: card.text };
  return card.cardKind === 'word' ? { ...common, cardKind: 'word' }
    : { ...common, cardKind: 'block', relatedIds: structuredClone(card.relatedIds) };
}
/** JSONオブジェクトのキー順序に依存しない比較。 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const sameCardContent = (a: CardContent, b: CardContent): boolean => canonical(a) === canonical(b);
/** 対象集合・関連先集合の列挙順も、同一要求の意味を変えない。 */
export function commandFingerprint(command: BoardCommand): string {
  const normalized = structuredClone(command);
  if ('cardIds' in normalized) normalized.cardIds = [...normalized.cardIds].sort((a, b) => objectKey(a).localeCompare(objectKey(b)));
  if ('objectIds' in normalized) normalized.objectIds = [...normalized.objectIds].sort((a, b) => objectKey(a).localeCompare(objectKey(b)));
  if ('changes' in normalized) normalized.changes = normalized.changes.map(change => ({ ...change, patch: {
    ...change.patch, ...(change.patch.relatedIds && { relatedIds: [...change.patch.relatedIds].sort((a, b) => objectKey(a).localeCompare(objectKey(b))) }),
  } })).sort((a, b) => objectKey(a.cardId).localeCompare(objectKey(b.cardId)));
  return canonical(normalized);
}
export function contentPatch(base: CardContent, draft: CardContent): CardPatch {
  const patch: Record<string, unknown> = {};
  for (const key of ['shape', 'position', 'color', 'font', 'text'] as const) {
    if (canonical(base[key]) !== canonical(draft[key])) patch[key] = structuredClone(draft[key]);
  }
  if (base.cardKind === 'block' && draft.cardKind === 'block' &&
      canonical(base.relatedIds.map(objectKey).sort()) !== canonical(draft.relatedIds.map(objectKey).sort())) patch.relatedIds = structuredClone(draft.relatedIds);
  return patch;
}
