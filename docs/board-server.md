# ボード取得・編集サーバー

Next.jsのRoute Handlerで、取得と編集のHTTP APIを実装している。
追加のサーバープロセスやパッケージは不要。

## 起動

```sh
npm run dev
```

画面は `http://localhost:3000`。カードをクリックすると本文の編集、保存、取消ができる。
編集状態と候補カードの追加はSSEで全端末へ通知する。

## API

| メソッド・URL | 要求 | 結果 |
| --- | --- | --- |
| `GET /api/boards/:boardId` | 本文なし | `board.snapshot` |
| `POST /api/boards/:boardId` | `type: "edit.request"` | `edit.granted` と `lockId` |
| 同上 | `type: "edit.commit"` | `edit.committed` |
| 同上 | `type: "edit.cancel"` | `edit.cancelled` |
| 同上 | `type: "edit.check.reply"` | `edit.checked` と `outcome: "saved" / "released"` |
| `GET /api/boards/:boardId/events?userId=...&clientId=...` | SSE接続 | 初期取得、期限確認、更新通知 |

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
- `replyToEditCheck(command)`：期限確認への返答を検証し、途中保存と延長、または解除を行う。
- `executeEdit(input, expectedBoardId?)`：未検証の入力を検証して、上記の編集操作へ振り分けるAPI用の入口。
- `subscribeBoard(identity, receive)`：初期スナップショットと、その後の通知を購読する。戻り値は購読解除関数。

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
| 200 | 取得・許可・確定・取消・期限確認への返答に成功 |
| 400 | JSON、属性の型・サイズ、座標、ボードID等が不正 |
| 403 | 編集権ID・端末・ユーザーが不一致、または期限切れ |
| 404 | ボードまたはカードが存在しない |
| 409 | 既に編集権が取得されている、または問い合わせが終了している |
| 415 | POSTのContent-Typeがapplication/jsonではない |

カードに関する拒否は `edit.rejected` と最新のボードを返す。
入力不正や存在しないボードは `{ error: string }` を返す。
文字列IDは空白だけを不可とし128文字まで、本文は100,000文字まで、座標は有限数に制限する。
contentにIDや編集者を混入させる更新は拒否する。

HTTPアダプターは、編集拒否の403・404・409もイベントとしてクライアント状態管理へ届ける。
応答の種類・ボードID・端末ID・要求ID・カードIDを照合し、取り違えた応答を適用しない。
通信には10秒のタイムアウトを設定し、購読解除時は送信を中断する。

## 編集権の有効期限

編集許可から5分で、所有端末へSSEの `edit.check` を送る。カード単位のサーバータイマーのため、GET等のアクセスは不要。
クライアントは保存済みの5属性と下書きを比較し、以下の形式で既存POSTへ返答する。

```json
{
  "type": "edit.check.reply",
  "boardId": "demo", "cardId": "1", "userId": "user-1", "clientId": "tab-1",
  "requestId": "reply-1", "lockId": "許可されたロックID", "checkId": "問い合わせのID",
  "changed": false
}
```

変更ありの場合は `changed: true` と確定要求と同じ形式の `content` を送る。
途中保存はrevisionを進め、編集者とロックIDを保持して5分の期限を再設定する。
変更なし、または10秒無応答なら解除する。不正な返答は拒否し、応答待ち期限は延長しない。
問い合わせ中の通常確定・取消も受け付け、先に完了した処理を有効にする。古い問い合わせ・タイマーは状態を戻さない。

## 編集終了後の候補追加

最後のロック解除から30秒待ち、ロック0件・生成中でない・最後の更新が自動生成以外なら候補を生成する。
最大3枚を既存カードの右に並べ、一括で追加してrevisionを1つ進める。
自動生成も通常の更新後処理を通り、30秒の待機を再設定する。その満了時には最後の更新が自動生成なので停止する。
GET、拒否要求、端末の放置では再生成しない。新しい編集を許可すると待機を停止し、生成中の結果も無効にする。

生成には確定済みボードのコピーを渡す。既定の `ai-service.ts` はダミー生成で、
`createBoardService` の `generateSuggestions` で差し替えられる。
失敗・候補0件では自動再試行せず、次の実際の更新後に再試行できる。
時間・枚数の定数は `src/server/edit-lifecycle.ts`、候補の検証と配置は `src/server/word-addition.ts` にある。

## 通知

SSE接続時に最新の `board.snapshot` を送り、以後は更新ごとに通知する。
所有端末には自分の編集応答を送り、他端末にはロックIDを含まない `board.snapshot` を送る。
問い合わせは `edit.check`、無応答解除は `edit.released`、候補追加完了は `board.snapshot` で通知する。
HTTPとSSEで重複した応答は下書きを上書きしない。SSE切断時は編集を終了して再接続を促す。
クリック・キー入力・ユーザーのアイドル状態は監視しない。`idle.heartbeat` は廃止した。

## 現在の範囲

単一の常駐Node.jsプロセスのメモリにデモボードを保持する。HTTPとSSEは同じインスタンスを共有する。
プロセス再起動でボード・ロック・タイマー・最後の更新を初期化し、未保存の状態は復元しない。
初期データの編集者は解除し、取得だけでは生成を開始しない。開発中のモジュール再読込ではインスタンスを保持するため、サービス変更後は再起動する。
複数プロセス・サーバーレスの休止には未対応。ボード新規作成、永続保存、認証は未実装。
ユーザーID・端末IDは申告値であり、ユーザー認証の代わりにはならない。
編集中の下書きは入力ごとには送らず、通常確定か期限確認時に送る。取消で戻るのは最後の途中保存時点の内容。

## 検証

```sh
npm test
npx tsc --noEmit --incremental false
npm run lint
```

仮想時計で編集確定・取消・期限確認・途中保存・無応答解除・生成競合・ボード間の分離をテストする。
SSEの配信・切断、HTTPアダプターの検証、2端末のHTTP＋SSEによる編集から候補追加までの同期もテストする。
