# ボードの共通モデル

実装は `src/domain/board.ts`。フロント・サーバーとも同じ型を使用する。詳細と採用値は [implementation.md](./implementation.md) を参照。

| 型 | 内容 |
| --- | --- |
| BoardObjectId | `{ type: 'card' \| 'arrow', uuid: string }` |
| CardId / ArrowId | 種別を限定したID。UUIDに接頭辞を付けない |
| CardCommon | cardId、shape `{width,height}`、position `{x,y,z}`、color、font、text、任意のeditingUser |
| WordCard | `cardKind: 'word'` と共通項目 |
| BlockCard | `cardKind: 'block'` と共通項目、relatedIds、reactions |
| CardReaction | `{ reactionId, userId }`。種類ごと・ユーザーごとに1件 |
| Arrow | arrowId、sourceCardId、targetCardId、sourceAnchor、targetAnchor |
| Anchor | north / east / south / west |
| BoardTimer | 初期5分。停止中はremainingMs、実行中はendsAtを保持 |
| Board | boardId、cards、arrows、timer |

本文はどちらもtext。summaryや画面専用の送信用カード型は作らない。リアクションはBlockCard専用で、固定定義REACTIONSを共用する。

IDは `sameObjectId` で内容を比較する。React FlowやMap/Setには `objectKey` の `card:UUID` / `arrow:UUID` を使う。オブジェクト参照の一致に依存しない。

`createBoard`、`createEmptyCard`、`addCard`、`getCard`、`replaceCard`、`removeObjects`、`removeCard` は純粋操作。削除は参照と接続矢印も一括除去する。ロック・revision・配信はサーバー側の責務。
`createSample` はカード・矢印・参照に新しいUUIDを発行する。`isEmpty` はカード枚数でなく、すべてのtext.trim()が空かを判定する。

`src/domain/board-validation.ts` で種類、UUID形式、有限座標、寸法、一意性、参照、固定Reaction、矢印の接続規則を実行時検証する。関連付けは同じボード内のカードへの参照で、所有や階層ではない。自己参照・重複は禁止、循環は許可する。矢印は関連付けから独立し、自己接続と同一端点・同一Anchorの重複は禁止する。

保存属性は `CardPatch`。kind、ID、editingUser、reactionsはパッチに含めない。位置だけの保存で他の属性を上書きしない。確定時は最新のリアクションを保持し、削除済みの関連先を除去する。

```sh
node --test src/domain/board.test.mjs
```
