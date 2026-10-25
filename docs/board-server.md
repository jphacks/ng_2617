# ボードの取得・編集サーバー

Next.js Route Handlerと単一プロセスのメモリサービスで、操作要求と全端末への通知を実装している。実装の採用値と制約は [implementation.md](./implementation.md) を参照する。

## 起動とAPI

`npm run dev` の後、`http://localhost:3000` からルームへ参加する。`/room/demo` にはサンプルがある。同じルームIDで共同編集する。

| メソッド・URL | 内容 |
| --- | --- |
| GET /api/boards/:boardId | board.snapshot。初回アクセスで空ボードを作成 |
| GET /api/boards/:boardId/events?userId=...&clientId=... | SSE。購読登録と初期スナップショットを同じ同期処理で実行 |
| POST /api/boards/:boardId | 下記コマンド。Content-Type: application/json |

すべてのコマンドはtype、boardId、userId、clientId、requestIdを持つ。URLと本文のboardIdは一致させる。

| コマンド | 追加属性 |
| --- | --- |
| edit.request | cardIds: CardId[] |
| edit.commit | lockId、changes: `{cardId,patch}[]` |
| edit.cancel | lockId |
| edit.check.reply | lockId、checkId、state: editing / committing / cancelling。前二者ではchanges |
| card.create | card（空本文、編集者なし、BlockCardの関連先・反応も空） |
| reaction.add / reaction.remove | cardId、reactionId。付与ユーザーは要求のuserIdから決定 |
| arrow.create | arrow |
| arrow.delete | arrowId |
| objects.delete | objectIds: BoardObjectId[] |
| board.clear / board.restore-sample | なし。対象はサーバーが決定 |
| timer.start / timer.stop / timer.reset | なし |
| generation.request | level: low / mid / high |
| matching.start | なし。2枚以上の単語・編集ロック0件・SSE接続を確認 |
| matching.select | gameId、turnId、copyId。担当ユーザーのみ |
| matching.draft | gameId、turnId、writerToken、sequence、text、final。入力権のある端末のみ |
| matching.abort.request | gameId。共有確認を開始 |
| matching.abort.confirm / matching.abort.cancel | gameId、confirmationId。接続中の誰でも終了／続行を確定 |

パッチに含められるのはtext・color・font・position・shapeとBlockCardのrelatedIds。ID・種類・編集者・リアクションを混入させた保存は拒否する。保存対象集合は貸し出しと完全一致させる。

```json
{
  "type": "edit.request",
  "boardId": "demo", "userId": "user-1", "clientId": "tab-1", "requestId": "request-1",
  "cardIds": [{ "type": "card", "uuid": "00000000-0000-4000-8000-000000000001" }]
}
```

上のUUIDは形式例。実際の対象IDは取得したボードを参照する。

## サービスの構造

`src/server/board-store.ts` がHTTP/SSEから共通のサービスを公開し、クライアントへのインポートをserver-onlyで防ぐ。`createBoardService(initialBoards,options)` はテストや内部処理で同じ検証・ハンドラーを利用する入口。
`executeCommand` が種類を検証して編集・即時操作へ振り分ける。`executeEdit` と編集用公開メソッドも同じ入口を使う。

貸し出し台帳は `lockId → {cardIds,userId,clientId,expiresAt,...}`、カード索引は `objectKey(cardId) → lockId`。全対象を確認して一括取得し、編集者表示、確定、取消、問い合わせ、解除も一括で行う。
編集権の取得・継続・解除で期限を管理し、実際の変更後に `onBoardUpdated` を一回だけ通す。revision・影響ID一覧・待機設定・配信を操作全体でまとめる。変更なし・拒否・取得では更新しない。本文が変わらなくても、実際のロック取得・解除は更新。

削除対象に自分を含むロックがあれば全体を拒否する。許可時は本体、関連先参照、接続矢印をまとめて除去する。参照元が編集中でも参照除去は実施し、古い下書きの保存時には削除済み参照を除く。
リアクションと矢印は本文ロックを使わず、編集中も独立に更新できる。本文の確定・途中保存・取消は最新リアクションを保持する。

## 期限・待機・生成・共有タイマー

貸し出しから5分で所有端末へedit.checkを送り、10秒無応答なら解除する。編集中で変更があれば途中保存して全対象を継続、変更なしなら解除。確定／取消要求済みの返答は通常の終了処理に合流する。古い問い合わせ・期限コールバックは世代とIDで無効化する。

最後のロック解除・カード系更新から30秒待ち、本文あり・ロック0件・生成中でない・最後の更新が生成以外なら最大3語を生成する。候補を重複除去し、既存カードの右へ配置する。手動は選択した関連性、自動はmidを、同じ関数に渡す。
生成結果はカード系更新とロックを再確認してから最新Boardへ追加する。共有タイマーだけの更新では破棄しない。生成後も通常の待機を設定するが、最後の更新が生成なので次の満了では停止する。失敗・候補0件で自動再試行しない。

共有タイマーは初期5分停止。開始／停止／リセット／0秒到達だけを同期し、毎秒は配信しない。0秒到達時は残り0で停止し、`board-timer.ts` の空のonTimerFinishedを一度呼ぶ。再開にはリセットが必要。共有タイマー更新では、カード系の最終更新・自動生成待機・進行中の生成の有効性を変えない。

神経衰弱では同じタイマーを各段階10秒で開始し、`armTimer` の0秒処理をゲームの段階遷移へ接続する。通常時の終了フックはゲーム中には呼ばない。ゲームID・手番ID・タイマー予約の世代を検証し、古い予約・操作を次の段階へ作用させない。終了時はすべての経路で通常の5分停止へ戻す。
`matching` 更新種別は既存のrevision更新・SSE通知へ合流するが、自動生成の待機を予約しない。ゲーム中は通常操作・タイマー手動操作・AI生成・JSON読み込みを拒否する。開始前の非同期生成結果も競合破棄する。

## 神経衰弱の期限・接続・最終確定

`Board.matching` に全員共通の進行状態を持ち、ゲーム開始時に全カードをコピーする。ランダムに取り出した最大10枚の単語を固定表示枠で共有し、成功した手番の2枚だけを使用済みにして空いた枠へ補充する。全員空・選択時間切れでは枠を動かさず裏へ戻す。元カードの位置・関連は変更しない。
SSE接続をuserId単位で集約し、2枚目の選択時に接続中の各ユーザーへBlockCardを1枚配る。途中参加者は次回から配布。選択担当の切断で接続中の人へ担当を移し、入力中は他の参加者の期限を維持する。0人なら受理済みの本文を保存して終了する。
下書きは最新接続のclientIdとwriterTokenで入力元を限定し、sequence以下の古い更新は適用しない。別タブへの引き継ぎでトークンを更新する。成果物は下書きのcardId・本文・元2枚への関連だけを引き継ぎ、ユーザー情報を保存しない。同じ本文も全員分残す。
入力10秒後は `closing` に切り替え、通常の本文更新を拒否する。0秒時点のIME確定に伴う `final: true` だけを最大1秒受け付け、その後一度だけ追加する。最終送信がなければ受理済みの本文を使用する。中断確定も同じ処理を通る。確認中は時間を止めず、確認IDは同じゲーム内の手番をまたいで保持する。
アイデアの配置は単語生成と共通の `placeAddedCards` を使い、カードの実寸と余白から通常ボードの右に追加する。詳しいルールは [matching-game-ui.md](./matching-game-ui.md) を参照。

## 通知・再送

全イベントはboard・revision・serverNow・generation・generationSequenceを含む。自分の編集応答はHTTPとSSEの双方から取得できる。他端末にはロックIDを含めずスナップショットを配信する。
生成開始／失敗／破棄はgeneration.updated、追加確定時はboard.cards-generated。後者はeventId・generationId・generatedCardIdsも含む。生成状態だけの変更ではrevisionを進めない。

要求の結果はボード内のclientId＋requestIdで記録し、同じ内容の再送は結果を再利用する。更新・フック・生成・配信を二重実行しない。同じIDで内容が異なる場合は409を返し、boardId・clientId・requestId・要求種別をエラーログへ記録する。JSONのキー順序には依存しない。

| ステータス | 内容 |
| --- | --- |
| 200 | 成功・変更なし |
| 400 | 形式・値・寸法・対象集合等が不正 |
| 403 | 編集権が不一致・既に終了 |
| 404 | ボード・カード・矢印の接続先が存在しない |
| 409 | ロック競合・終了済み問い合わせ・IDの内容不一致・生成開始条件を満たさない |
| 415 | Content-Typeが不正 |

形式が正しい操作への拒否はcommand.rejectedと最新スナップショットを返す。形式不正や未知ボードでは `{error}` を返す。HTTPアダプターは通信失敗とサーバーの操作拒否を区別する。

```sh
npm test
npx tsc --noEmit --incremental false
npm run lint
```
