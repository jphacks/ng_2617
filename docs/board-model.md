# ボードの共通モデル

`src/domain/board.ts` に、クライアントとサーバーの両方から使う型と操作を置く。
React・Next.js・React Flow・データベースには依存しない。
`'use client'` や `'use server'` は付けない。各実行環境から直接 import する。

## データと操作

- `Board`：`boardId` とカードの配列。
- `Card`：`cardId` と設計メモの6属性。
- `User`：現時点では `userId` のみ。
- `createBoard` / `getCard` / `addCard` / `replaceCard` / `removeCard`：生成・参照・追加・置換・削除。

クラスではなくプレーンなオブジェクトを使うため、JSONで送受信・保存できる。
更新関数は元のボードを変更せず、新しいボードを返す。
型はネストした座標・ユーザー・カード配列まで読み取り専用にしている。
実行時の凍結やコピーは行わないため、呼び出し側も渡したデータを直接書き換えない。
カードIDの重複と、存在しないカードの置換・削除はエラーにする。

```ts
import { createBoard, addCard, replaceCard } from '@/domain/board';

const emptyBoard = createBoard('board-1');
const board = addCard(emptyBoard, {
  cardId: 'card-1',
  shape: 'rectangle',
  position: { x: 250, y: 150, z: 0 },
  color: '#ffffff',
  text: 'カフェ',
  font: 'sans-serif',
});

// サーバーから受け取った確定済みカードを適用する場合も同じ操作を使う。
const nextBoard = replaceCard(board, {
  ...board.cards[0],
  text: '新しいカフェ',
});
```

## 画面との接続

現在の `src/app/page.tsx` はクライアント基盤を通じてサーバーのボードを取得し、カードから
React Flow のノードへ変換する。`cardId` を `id`、`text` を `data.label`、
座標の `x`・`y` を `position` に対応させる。
形状・色・フォント・描画順は表示側でノードの種類やスタイルに変換する。
選択状態や表示範囲など、画面固有の情報は共通モデルに含めない。

将来のサーバーは、編集権を確認し、変更を確定した後で同じ更新関数を使う。
この関数をクライアントでも使えることは、サーバーの編集許可を代替しない。
編集中の下書きはボードとは別に保持し、確定通知でボードを更新する。
`editingUser` は編集者の表示情報であり、端末単位のロックを保証するものではない。
ロック解除後のカードには `editingUser` を含めず、カード全体を置換する。

## 今回の範囲と未決定事項

取得専用のサーバー・HTTP通信・画面への接続を追加済み。詳細は [board-server.md](./board-server.md) を参照。
編集用サーバーと永続化はまだ実装していない。
形状・色・フォントは暫定的に文字列として扱う。上の値は使用例であり、許容値の仕様ではない。
`z` は保持するだけで、大小と前後の対応はまだ決めていない。
`Board` 自体には更新番号を含めない。クライアント基盤では、暫定的に同期イベント側に
ボード単位の `revision` を追加している。詳細は [board-client.md](./board-client.md) を参照。
IDは呼び出し側で生成する。通信から受け取る値の実行時検証は、通信層を作る際に追加する。
別のサーバー用プロジェクトへ分離するときは、このモジュールを共通パッケージへ移せる。

## 動作確認

TypeScriptを直接実行できるNode.js（22.18以降）で以下を実行する。

```sh
node --test src/domain/board.test.mjs
```
