# クライアントのボード管理

`src/client/board-client.ts` は、画面や通信方式から独立して確定状態・編集・要求の送信を管理する。画面は `src/components/Board.tsx` / `BoardCard.tsx` に接続済み。

## 状態と公開操作

- identity：boardId・userId・clientId。利用者と端末を区別する。
- status：offline → loading → ready。boardとrevisionは確定済みの共有状態。
- edit：idle / requesting / editing / saving / cancelling。cardIds、貸し出しのlockId、基準値と下書き、確定／取消の意図を保持する。
- pendingCommands：応答を確認していない元の要求。再送でも同じ内容・requestIdを使う。
- generation・generationSequence：サーバーの生成進行状態とその順序。Boardのrevisionとは独立。
- generatedCardIds：未終了の案内対象。`dismissGuidance` で終了し、eventIdが同じ通知では復活しない。
- serverOffsetMs：共有タイマーの時刻差補正。
- matchingInput：ゲーム・手番・入力権トークンに対応する本人のローカル本文・連番・最終送信状態。ゲームの正本はboard.matching。
- matchingNotice：通常ボードへ戻ったときの終了・追加件数の案内。

公開メソッドは `connect` / `disconnect`、`leave` / `scheduleLeave`、`requestEdit`、`updateDraft`、`commitEdit`、`cancelEdit`、`execute`、`updateMatchingDraft`、`retryPending`、`dismissGuidance`。
状態はreadonlyとして扱い、直接変更しない。受信値と送信コマンドはコピーする。

```ts
client.requestEdit([cardA.cardId, cardB.cardId], 'transform');
// 許可待ちでも位置・サイズだけを本人の画面で仮表示できる。
client.updateDraft({ position: { x: 100, y: 200, z: 1 } }, cardA.cardId);
client.commitEdit(); // まだ許可待ちなら最終位置を保持し、許可後に送信する。

client.execute({ type: 'reaction.add', cardId: block.cardId, reactionId: 'heart' });
```

`true` はクライアントが操作を受け付けた意味で、サーバー側の成功ではない。本文の編集は許可前には受け付けず、種類変更も許可しない。
複数移動は一つの貸し出しで扱う。拒否したら仮表示を破棄して最新の確定位置へ戻す。許可前の取消後に許可が届いた場合も、そのロックへ取消要求を送る。

## 通信と応答順序

`BoardTransport` は `send(command)` と `subscribe(onEvent,onDisconnect)` を持つ。`createHttpBoardTransport` はPOSTを通常操作、SSEを初期取得と以降の全更新に使用する。SSE登録と最初のスナップショットが同じ境界になるため、GETの直後に更新を取り逃さない。
HTTP・SSEとも共通の実行時検証を通す。ボード、要求、端末、対象、ロック、問い合わせIDの対応を確認する。

古いrevisionはボードを巻き戻さない。同じ／古いrevisionの個別要求への応答でも、対応する要求の完了は処理する。生成の順序はgenerationSequence、案内の重複はeventIdで判定する。初期化前の通知は順序を保って処理し、初期取得に含まれる生成は案内しない。

HTTPの10秒タイムアウトや送信失敗ではSSE購読を解除せず、下書き・送信済み最終内容・元の要求を保持する。通常操作は自動再送せず、「元の要求を再送」で `retryPending` を使う。例外として、結果不明の `board.import` はSSE再接続後の初期スナップショット受信時にも、同じ内容・requestIdで自動再送して結果を確認する。サーバーの重複実行防止により、成功済みの置き換えを再実行しない。
SSE自体の切断ではofflineになり、通常編集の下書きを終了する。再接続では最新スナップショットを取り直し、案内対象も初期化する。古い接続の受信・送信失敗は無視する。
明示的な退室では `leave` が `board.leave` をkeepaliveで送り、自端末の編集ロックを解除して通信を終了する。`scheduleLeave` はReactのeffect終了時の退室を予約し、StrictModeによる直後の再接続では予約を取り消す。一時的なSSE切断だけでは退室要求を送らず、残ったロックは期限確認で回収する。
神経衰弱の本人の本文は切断中も保持する。再接続した時点でも同じゲーム・手番・入力権かつ期限内の場合に限り未送信本文を再共有する。期限時点で送信した最終本文は、同じ手番のclosing中なら再送できる。旧手番の本文を次の手番へ流用しない。最後の接続が失われたゲームは終了し、再接続で途中再開しない。

## 神経衰弱

通常ボードの「神経衰弱をはじめる」から `matching.start` を送る。本文のある通常付箋が2枚未満、編集中のカードあり、送信・読み込み中では開始ボタンと理由を表示する。サーバーでも開始条件を検証する。
`ConnectedBoard` が接続を所有し、共有状態に応じて `BoardCanvas` / `MatchingGame` を切り替える。ゲーム中は通常ツールを描画せず、通常編集・カードや矢印の即時操作・タイマー手動操作・AI生成・JSON読み込みをクライアント・サーバーの双方で拒否する。ボード設定の変更と退室はゲーム中も受け付ける。
`updateMatchingDraft(text, final?)` は自分に割り当てられた入力カードだけを更新する。連番と入力権トークンで巻き戻しを防ぎ、本文の共有は残り時間・カーソル・他人のカード順序を変えない。0秒では通常編集を止め、`MatchingTextInput` がIMEを確定して最終本文を送信する。サーバーが追加を確定するまで「結果を反映中」を表示する。
ゲーム終了時は成果物を通常ボードへ表示し、画面外案内にも追加する。ルールと最終送信の集約時間は [matching-game-ui.md](./matching-game-ui.md) を参照。

## 期限確認

- 編集中：最後の確定状態からの属性パッチを返す。変更があれば途中保存、なければ貸し出し全体を解除。
- 確定要求済み：保持した最終パッチを `state: 'committing'` で返す。
- 取消要求済み：`state: 'cancelling'` を返す。

同じ問い合わせに重複返答しない。途中保存中に追加された入力や、元の値へ戻した入力も保持する。最新のリアクションを下書きに混ぜず、削除された関連先を復活させない。

## Reactと画面

`useBoardClient` は一つのインスタンスにつき一か所で接続を所有する。ボードの切り替えでは再作成する。ブラウザだけで持つ選択、ツール、表示範囲、案内座標をBoardへ保存しない。
本文はフォーカスで編集許可を要求し、空白タップまたはCtrl／⌘＋Enterで確定、Enter改行、Escape取消。フォーカスが外れただけでは保存しない。関連先の選択中は参照元を保持し、参照先を編集開始しない。Escapeは選択だけを中止する。
本文欄は `CardTextInput` で表示値を即時に保持する。React Flowのノード更新が遅れても、変換中の文字を古い本文で上書きしない。IME変換中のEnter・Escape・候補操作はカードのショートカットへ伝播させず、IME自体の既定動作を維持する。入力は従来どおりクライアントの下書きへ渡し、編集権の終了・取消ではローカル表示も確定状態へ戻す。
携帯・タブレットでも最初のタップでキーボードを開けるよう、編集開始可能な本文欄はフォーカス前からreadOnlyを外す。押下時の `pointerdown` では強制フォーカスせず、ブラウザの標準動作とタップ完了時の `click` でフォーカス・編集許可要求を行う。許可待ちでは `beforeinput`・貼り付け・切り取り・ドロップを止め、取り消せないIME入力も表示を戻して本文変更を送らない。フォーカスを保ったまま許可後の入力へ移り、拒否・他人のロック・関連先選択時は従来どおり入力を制限する。本文欄のタッチ操作はReact Flowのパンに渡さず、`-webkit-user-select: text` / `user-select: text` を明示してノードの選択禁止スタイルを上書きする。
神経衰弱はPCでは入力開始時にフォーカスし、タッチ端末ではプログラムによる先行フォーカスを避けて入力欄の標準タップを使う。Safariで既に「カーソルだけ」のフォーカスが残っている場合も、最初の完了したタップ内で一度だけ取り直す。選択位置を保ち、入力・IME変換の開始後はタップでblurしない。通常カードも同じ処理を使う。対応ブラウザではVirtualKeyboard APIも利用するが、Safariでの表示をAPIで強制できるとは扱わない。
削除キーとゴミ箱は同じ一括削除要求へ接続し、入力欄では文字削除する。サーバー確定前にノードや矢印を消さない。
画面外案内はカード全体の外枠と表示範囲から計算し、全体が表示されたら終了する。

```sh
npm test
```
