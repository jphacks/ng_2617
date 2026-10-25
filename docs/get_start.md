# 開発環境の起動

Node.js 22.18以降（または24以降）を使用します。テストではNode.js標準のTypeScript実行機能を使います。

```bash
npm install
cp .env.example .env.local
```

[Google AI Studio](https://aistudio.google.com/apikey) で取得したAPIキーを、ルートの `.env.local` に設定します。

```dotenv
GEMINI_API_KEY=取得したAPIキー
GEMINI_MODEL=gemini-3.5-flash-lite
```

`GEMINI_MODEL` は省略可能です。既定は `gemini-3.5-flash-lite` で、利用可能な別のモデルIDに変更できます。
APIキーはサーバー側だけで読み取り、`NEXT_PUBLIC_` を付けません。`.env.local` はGit管理対象外です。
Renderなどへデプロイする場合も、ホスティング先の環境変数に同じ値を設定します。

```bash
npm run dev
```

[http://localhost:3000](http://localhost:3000) からルームに参加できます。`/room/demo` にはサンプルがあります。
環境変数の変更後は開発サーバーを再起動してください。メモリにあるボードは再起動で消えるため、必要なら先にJSON保存してください。

## Geminiで単語を生成する

1. ボードの付箋に言葉を入力して確定します。
2. 右下の「AI」を開き、関連性（低・中・高）を選んで「単語を生成」を押します。
3. 最大3枚の候補が共有ボードに追加されます。

自動生成がONの場合、全員の編集終了から30秒後にも同じGemini連携を使い、関連性「中」で生成します。
自動生成は「ボード設定」でOFFにできます。手動生成はOFFでも利用できます。

Googleへ送るデータはカード本文のみです。空白・重複を除き、最大100件、各300文字、合計10,000文字に制限します。
生成中の編集などでボードが変わった場合は、既存の競合判定によって候補を破棄します。
APIキー未設定、認証失敗、利用上限、通信失敗、不正な応答は画面に通知します。モックへの自動切り替えや自動再試行は行いません。
通信は20秒でタイムアウトします。キーの動作確認は画面から手動生成を1回実行してください。

実装は追加SDKを必要としないREST APIです。仕様はGoogle公式の [構造化出力](https://ai.google.dev/gemini-api/docs/generate-content/structured-output) と [モデル一覧](https://ai.google.dev/gemini-api/docs/models) を参照してください。

## Renderへの反映と確認

ローカルの `.env.local` はRenderには転送されません。コードのデプロイと、Render側の環境変数設定の両方が必要です。

1. Renderの対象サービスのSettingsで、接続リポジトリとデプロイ対象ブランチを確認します。
2. Gemini連携の変更をそのブランチに反映します。
3. サービスはNode.jsのWeb Serviceとして動かし、Build Commandを `npm ci && npm run build`、Start Commandを `npm run start` にします。
4. Environmentで `GEMINI_API_KEY` を設定します。必要なら `GEMINI_MODEL=gemini-3.5-flash-lite` も設定します。
5. 最新コードをデプロイします。環境変数を「Save only」で保存した場合も、次のデプロイまで反映されません。
6. 公開URLで新しい確認用ルームを作り、付箋の本文を確定して、AIパネルから手動生成します。
7. 生成完了の通知と、最大3枚の新しいカードが追加されることを確認します。自動生成もONにし、編集完了から30秒後の追加を確認します。

「現在はモックの候補語を使用しています」と表示される場合は、Gemini連携前のコードです。
新しい版のAIパネルには「ボードのカード本文をGeminiに送信して、最大3つの候補語を生成します」と表示されます。
このアプリはプロセス内メモリでボードとSSEを管理するため、インスタンスは1台で動かします。再デプロイでボードは初期化されます。

Render公式の [Next.jsデプロイ手順](https://render.com/docs/deploy-nextjs-app) と [環境変数の設定](https://render.com/docs/configure-environment-variables) も参照してください。

## 検証

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
```

テストではGemini通信をモックし、実際のAPI呼び出しや課金は発生しません。
