# ボード取得サーバー

Next.jsのRoute Handlerで、ボードを取得するHTTP APIを実装した。
別のサーバープロセスや追加パッケージは不要。

## 起動と確認

```sh
npm run dev
```

ブラウザで `http://localhost:3000` を開くと、サーバーが保持する `demo` ボードを取得して表示する。
画面上部に取得結果を表示し、「再取得」で新しくHTTPリクエストを送る。
通信失敗時も再取得できる。取得専用のためカードの移動・編集は無効にしている。

```sh
curl -i http://localhost:3000/api/boards/demo
curl -i http://localhost:3000/api/boards/missing
```

前者は200と `board.snapshot` イベント、後者は404とエラーを返す。
取得結果はキャッシュしない。

## 構成

- `src/server/board-store.ts`：メモリにデモボードを保持。サーバー専用で、取得時はコピーを返す。
- `src/app/api/boards/[boardId]/route.ts`：`GET /api/boards/:boardId` の受付。
- `src/client/http-board-transport.ts`：既存の `BoardTransport` をHTTPに接続。
- `src/app/page.tsx`：既存の `createBoardClient` を利用し、取得したカードをReact Flowに表示。

通信はブラウザ → HTTP GET → サーバーのボード → JSON → クライアント状態 → 画面の順で流れる。
`board.get` コマンドをGETに変換し、レスポンスを検証してから `board.snapshot` として通知する。
取得には10秒のタイムアウトを設定し、画面を離れた際は通信を中断する。
HTTPの要求・応答だけであり、常時接続やサーバーからの自発的な配信は行わない。
`ready` は取得成功を意味し、常時接続中を保証するものではない。

## 今回の範囲

デモボード1つを単一プロセスのメモリに保持する初期実装。
再起動・モジュール再読み込みで初期化され、複数プロセス間では共有されない。
ボード新規作成、編集、ロック、永続化、認証、リアルタイム同期は未実装。
画面の `demo-user` は認証されたユーザーではなく、取得の動作確認用。
編集要求は通信アダプターで未対応と通知するため、サーバー側で誤って処理されることはない。

## テスト

```sh
node --test src/client/*.test.mjs src/domain/*.test.mjs
npx tsc --noEmit --incremental false
npm run lint
```

HTTPアダプターのテストは、正常取得、不正な応答、404、受信取消、未対応の編集要求を確認する。
