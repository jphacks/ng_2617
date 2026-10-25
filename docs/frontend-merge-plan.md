# Card型の変更案

この文書は、フロントの設計変更を共通モデル・バックエンドへ取り込むための設計メモである。実装済みの仕様ではない。今後、関連する変更案を段階的に整理する。

## 1. 目的と合意した方針

従来の付箋を **WordCard** と呼び、大きなカードである **BlockCard** を追加する。
共通項目は共有し、BlockCard専用の項目をWordCardに要求しない型に分ける。

| 項目 | WordCard | BlockCard |
| --- | --- | --- |
| `cardId` | `BoardObjectId` | `BoardObjectId` |
| `cardKind` | 種類を判別する値 | 種類を判別する値 |
| `shape` | `{ width, height }` | `{ width, height }` |
| `position` | `{ x, y, z }` | `{ x, y, z }` |
| `color` | 共通 | 共通 |
| `font` | 共通 | 共通 |
| `text` | 共通の本文 | 共通の本文 |
| `editingUser` | 共通・省略可 | 共通・省略可 |
| `relatedIds` | 持たない | 専用項目 |
| `reactions` | 持たない | 専用項目 |
| `summary` | 持たない | 持たない |

- `shape` は従来の文字列から、幅と高さを持つオブジェクトへ変更する。
- `font` は両方のカードで保持する。既存の共通Cardにはあるが、フロントの独自の送信用型にはないため、両者を揃える。
- 本文は両方とも `text` とし、BlockCardの `summary` は廃止する。
- `relatedIds` と `reactions` はBlockCardだけに定義する。
- ボード上のオブジェクトのIDはUUIDを格納する文字列とし、カード以外でも利用できる共通の `BoardObjectId` 型にまとめる。

## 2. 共通型の案

定義先は `src/domain/board.ts` を想定する。フロントとバックエンドが同じ型を参照し、ページ内に別の送信用Card型を重複定義しない。

以下の `cardKind` の値 `"word"`・`"block"` は命名案である。`relatedIds` は `BoardObjectId` の配列とし、同じボード内のWordCard・BlockCardを参照する。`reactions` の要素型は、現段階では既存のフロント実装に合わせた暫定案とする。

```ts
export type BoardObjectId = string;

export type User = Readonly<{
  userId: string;
}>;

export type CardShape = Readonly<{
  width: number;
  height: number;
}>;

export type CardPosition = Readonly<{
  x: number;
  y: number;
  z: number;
}>;

export type CardCommon = Readonly<{
  cardId: BoardObjectId;
  shape: CardShape;
  position: CardPosition;
  color: string;
  font: string;
  text: string;
  editingUser?: User;
}>;

export type WordCard = CardCommon & Readonly<{
  cardKind: "word";
}>;

export type BlockCard = CardCommon & Readonly<{
  cardKind: "block";
  relatedIds: readonly BoardObjectId[];
  reactions: readonly string[];
}>;

export type Card = WordCard | BlockCard;

export type Board = Readonly<{
  boardId: string;
  cards: readonly Card[];
}>;
```

`Board.cards` は2種類のカードを同じ配列で保持する案とする。
`cardKind` の固定値により種類を判別でき、BlockCardと判定した箇所でだけ専用項目へアクセスできる。
幅・高さの既定値や、BlockCardの大きさの制約は、この型だけでは定めない。

### BoardObjectIdの方針

- 値は `crypto.randomUUID()` 等で生成するUUID文字列とする。
- カード以外のボード上のオブジェクトにも使うID型とする。具体的なオブジェクトの型は後続で定める。
- `cardId` の型と `relatedIds` の要素型に適用する。フィールド名を `id` 等へ変更することは、今回の決定には含めない。
- `boardId` はボード自体のIDであり、今回の共通化の対象には含めない。ユーザー・端末・要求・ロックのIDも対象外とする。
- 単純な型エイリアスでは任意の文字列を代入できるため、UUID形式の保証は生成処理と受信時の検証で行う。ブランド型による他の文字列との区別を採用するかは別途検討する。
- 現在の固定値 `"1"`・`"card-1"` や `"card-" + UUID` はUUID文字列そのものではないため、既存データ・サンプル・生成処理の移行方針が必要。

## 3. 型で保証する範囲

- 両方のカードに、共通項目と `cardKind` を要求する。
- BlockCardには `relatedIds` と `reactions` を必須とする。関連先・反応がない場合は空配列にする案。
- WordCardとして扱うコードからはBlockCard専用項目へアクセスできない。
- TypeScriptは構造的な型付けを行うため、この案だけでは変数を経由した余分な項目の代入を完全には禁止できない。
- 専用項目の混入を型でも拒否する必要があれば、WordCardに `relatedIds?: never`・`reactions?: never` を加える方式を検討する。これは追加検討事項であり、上の型案には含めていない。
- HTTPで受け取るJSONには型による保証がないため、サーバーで種類別の実行時検証が必要。

## 4. 編集内容の型への影響

現在の `src/domain/board-protocol.ts` は次の定義を使っている。

```ts
type CardContent = Omit<Card, "cardId" | "editingUser">;
```

Cardをユニオン型にすると、通常の `Omit` ではBlockCard専用項目を保持できないため、種類ごとに適用する案とする。

```ts
export type CardContent =
  | Omit<WordCard, "cardId" | "editingUser">
  | Omit<BlockCard, "cardId" | "editingUser">;
```

カードIDと編集者を下書きから変更させない既存の方針は引き継ぐ。
`cardKind` を編集で変更できるかは別途決める。上の型だけでは、保存済みカードからの種類変更は禁止されない。

## 5. 後続の変更で確認する箇所

型の追加だけでは連携は完成しない。以下は影響箇所の記録であり、具体的な実装案は後続で整理する。

| 場所 | 必要な対応 |
| --- | --- |
| `src/domain/board.ts` | 共通項目、WordCard、BlockCard、Cardの定義 |
| `src/domain/board-protocol.ts` | 種類の区別と専用項目を保持する編集内容の型 |
| `src/client/board-client.ts` | 下書きの作成・更新時に専用項目を保持する |
| `src/client/http-board-transport.ts` | 種類に応じた受信データの検証 |
| `src/server/board-service.ts` | 入力検証、確定、取消、期限切れ解除で専用項目を保持する |
| `src/server/board-store.ts`・カード生成処理 | 既存カードにWordCardの種別と幅・高さを設定する |
| `yutan_test` の `src/app/page.tsx` | 独自型を共通型へ揃え、本文をtextへ統一し、BlockCard専用の操作を分ける |

特に `board-service.ts` の `withoutEditor()` は、現在は従来の項目だけでカードを再構築している。型だけを追加すると、編集取消・期限切れ解除の際に専用項目が失われるため、対応が必要。

## 6. BlockCardの関連付け

`relatedIds` は、同じボード内のカードへの参照を保持する。カードをBlockCardの中に所有・所属させるものではない。

| 項目 | 方針 |
| --- | --- |
| 参照元 | BlockCardのみ |
| 参照先 | 同じボード内のWordCard・BlockCard |
| 複数からの参照 | 1枚のカードを複数のBlockCardから参照できる |
| 重複 | 同じBlockCardの `relatedIds` 内では同じIDを重複させない |
| 自己参照 | 禁止。自分自身の `cardId` を `relatedIds` に含めない |
| 循環参照 | 許可。A → B → C → Aのような関係も保持できる |
| 関連付け時の位置 | 参照先カードの位置は変更しない |
| 関連解除 | 参照だけを外し、参照先カードは残す |
| カード削除 | 削除したカードのIDを、参照元の各BlockCardの `relatedIds` から除去する |
| BlockCard削除 | そのBlockCardが参照していたカードは残す。削除したBlockCardへの参照は上記の規則で除去する |
| 矢印との関係 | 関連付けとは別のデータとして扱う |

`BoardObjectId` 型だけでは、参照先が同じボードに存在するカードか、IDが重複していないか、自己参照でないかは保証できないため、更新時にサーバーで検証する必要がある。

関連付けは階層ではなく参照として扱うため、循環を理由に更新を拒否しない。将来、関連先を再帰的に表示したりAI向けに収集したりする場合は、訪問済みの `BoardObjectId` を記録し、同じカードを繰り返し処理しない。
カード削除に伴う参照除去についても、編集中のBlockCardの下書き・編集ロックとの整合性や、削除済みIDの再保存を防ぐ処理は後続の通信・更新設計で整理する。

## 7. 未確定の事項

- `cardKind` の正式な値。現案は `"word"`・`"block"`。
- 幅・高さの既定値、単位、許容範囲。従来の `shape: "rectangle"` 等からの移行方法。
- `reactions` は絵文字配列のままでよいか。ユーザー情報、重複、取り消しの扱い。
- WordCardとBlockCardの相互変換を許可するか。許可する場合の専用項目の扱い。
- 従来形式のデータ・要求を引き続き受け付けるか。

現時点では、カード型の分割と項目の配置が合意済みの方針であり、未確定事項は実装前に順次決める。
