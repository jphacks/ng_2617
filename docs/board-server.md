# ボード取得・編集サーバー

Next.jsのRoute Handlerで、取得と編集のHTTP APIを実装している。
追加のサーバープロセスやパッケージは不要。

## 起動

```sh
npm run dev
```

画面は `http://localhost:3000`。現時点の画面は取得・再取得のみで、編集フォームはまだない。
以下のAPIは編集に対応済みで、クライアントの `requestEdit` / `commitEdit` / `cancelEdit` からも呼べる。

## API

| メソッド・URL | 要求 | 結果 |
| --- | --- | --- |
| `GET /api/boards/:boardId` | 本文なし | `board.snapshot` |
| `POST /api/boards/:boardId` | `type: "edit.request"` | `edit.granted` と `lockId` |
| 同上 | `type: "edit.commit"` | `edit.committed` |
| 同上 | `type: "edit.cancel"` | `edit.cancelled` |

POSTは `Content-Type: application/json` と、既存の `BoardCommand` 形式で送る。
URLと本文の `boardId` は一致させる。応答は全体ボード・更新番号・要求ID等を含む。
GET・POSTともに結果をキャッシュしない。

編集許可の例：

```sh
curl -X POST http://localhost:3000/api/boards/demo \
  -H 'Content-Type: application/json' \
  -d '{"type":"edit.request","boardId":"demo","cardId":"1","userId":"user-1","clientId":"tab-1","requestId":"request-1"}'
```

確定時は取得した `lockId` と、同じ `userId`・`clientId` を送る。
`content` は差分ではなく5属性の全体で、`cardId`・`editingUser` は含めない。

```json
{
  "type": "edit.commit",
  "boardId": "demo",
  "cardId": "1",
  "userId": "user-1",
  "clientId": "tab-1",
  "requestId": "request-2",
  "lockId": "編集許可で受け取った値",
  "content": {
    "shape": "rectangle",
    "position": { "x": 250, "y": 150, "z": 0 },
    "color": "#ffffff",
    "text": "更新後のカード",
    "font": "sans-serif"
  }
}
```

取消は `type: "edit.cancel"` とし、確定要求から `content` を除いた形式で送る。
要求ごとに新しい `requestId` を使う。要求の自動再送・重複成功応答の再現は未実装。

## 更新関数

`src/server/board-store.ts` が実際のメモリ上のサービスを1つ生成し、次の関数を公開する。

- `getBoardSnapshot(boardId)`：ボードと更新番号のコピーを取得する。
- `requestEdit(command)`：カード単位の編集権を取得する。
- `commitEdit(command)`：編集権を検証し、内容確定とロック解除を行う。
- `cancelEdit(command)`：内容を保持したままロックを解除する。
- `executeEdit(input, expectedBoardId?)`：未検証の入力を検証して、上記の編集操作へ振り分けるAPI用の入口。

編集関数は `{ status, body }` を返す。実装本体の `src/server/board-service.ts` は
`createBoardService(initialBoards, options)` で独立した保存領域を作れるため、テストでは実データを使わない。
クライアントへのインポートを防ぐ `server-only` は、実データを保持する `board-store.ts` に指定している。

同一ユーザーの別端末も排他対象とし、ユーザー・端末・ランダムな編集権IDをすべて照合する。
検証から確定まで同期処理で実行し、カード更新とロック解除の間に別の要求を挟まない。
更新ごとにボードの `revision` を増やし、確定イベントにはロック解除後のカードを含める。
保存する入力と返すスナップショットはコピーする。

## 検証・エラー

| ステータス | 内容 |
| --- | --- |
| 200 | 取得・許可・確定・取消に成功 |
| 400 | JSON、属性の型・サイズ、座標、ボードID等が不正 |
| 403 | 編集権ID・端末・ユーザーが不一致、または期限切れ |
| 404 | ボードまたはカードが存在しない |
| 409 | 既に編集権が取得されている |
| 415 | POSTのContent-Typeがapplication/jsonではない |

カードに関する拒否は `edit.rejected` と最新のボードを返す。
入力不正や存在しないボードは `{ error: string }` を返す。
文字列IDは空白だけを不可とし128文字まで、本文は100,000文字まで、座標は有限数に制限する。
contentにIDや編集者を混入させる更新は拒否する。

HTTPアダプターは、編集拒否の403・404・409もイベントとしてクライアント状態管理へ届ける。
応答の種類・ボードID・端末ID・要求ID・カードIDを照合し、取り違えた応答を適用しない。
通信には10秒のタイムアウトを設定し、購読解除時は送信を中断する。

## 編集権の有効期限

有効期限は暫定で5分。延長は未実装。
GETまたは編集要求が来た際に期限切れを判定し、ロックを解除して更新番号を進める。
期限切れの変更は受け付けないため、再度編集許可を取得する。
定期タイマーや期限切れの自動通知はなく、アクセス時に解除する方式。

## 現在の範囲

単一プロセスのメモリにデモボードを保持する。
再起動・モジュール再読み込みで初期化され、複数プロセス間では共有されない。
ボード新規作成、永続保存、認証、他端末へのリアルタイム配信、編集UIは未実装。
ユーザーID・端末IDは申告値であり、ユーザー認証の代わりにはならない。
他端末は再取得することで変更を受け取る。編集中の下書きはサーバーへ逐次送らない。

## 検証

```sh
node --test src/server/*.test.mjs src/client/*.test.mjs src/domain/*.test.mjs
npx tsc --noEmit --incremental false
npm run lint
```

編集確定、取消、競合、不正な編集権、期限切れ、入力検証、ボード間の分離と
HTTPアダプターからクライアント状態への反映をテストする。
