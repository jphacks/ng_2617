# クライアントのボード管理

`docs/backend-structure.md` の編集フローを、通信方式や画面から独立した状態管理として実装した。
以下は現在の単一カード編集・HTTP通信の契約であり、末尾の統合計画は未実装である。現在のサーバー構成は [board-server.md](./board-server.md) を参照。
画面はルームページから `src/components/Board.tsx` を表示する。画面内の編集操作をこのクライアントの編集APIへ接続する作業は未完了。

## ファイルの役割

| ファイル | 役割 |
| --- | --- |
| `src/domain/board.ts` | 共通のボード・カード・ユーザー型 |
| `src/domain/board-protocol.ts` | クライアント識別情報、要求、受信イベントの暫定契約 |
| `src/client/board-client.ts` | 確定済み状態、下書き、編集フロー、通信の窓口 |
| `src/client/use-board-client.ts` | Reactで状態を購読し、接続・購読解除を行うフック |
| `src/client/board-client.test.mjs` | 模擬通信を使った編集・同期のテスト |

## 保持する状態

- `identity`：`boardId`、`userId`、`clientId`。ユーザーと端末を区別する。
- `status`：`offline` → `loading` → `ready`。
- `board`：受信した確定済みボード。初回取得前は `null`。
- `revision`：最後に受け取ったボード単位の更新番号。
- `edit`：編集の段階、対象カード、要求ID、編集権ID、下書き。
- `error`：拒否理由、通信失敗、編集権の消失などの表示用メッセージ。

状態は読み取り専用として扱う。`getSnapshot()` の戻り値を直接変更せず、公開メソッドから操作する。
受信イベントと送信コマンドはコピーして、通信側による後からの変更が内部状態に影響しないようにしている。

## 編集の流れ

1. `connect()` で受信を購読し、`board.get` を送る。
2. `board.snapshot` を受け取ると操作できるようになる。
3. `requestEdit(cardId)` は `edit.request` を送り、`requesting` に進む。
4. 自分の端末・要求・カードに対応する `edit.granted` で `editing` に進み、下書きを作る。
5. `updateDraft(patch)` は下書きだけを変更する。ドラッグ位置もこの操作で変更する。
6. `commitEdit()` は `edit.commit` を送り、`saving` に進む。
7. `edit.committed` のボードを反映して編集を終了する。送信成功だけでは確定扱いにしない。

取消は `cancelEdit()` → `edit.cancel` → `edit.cancelled` の流れで行う。
`edit.rejected` は拒否理由を表示用状態へ格納し、編集を終了する。
1端末で同時に編集するカードは1枚とする。操作できない状態のメソッドは `false` を返して送信しない。
`true` は操作を受け付けた意味で、サーバー側の成功を示さない。

## 通信の実装を差し込む

`BoardTransport` は次の2つを持つ。

- `send(command)`：要求を送る。失敗は例外またはPromiseのrejectで知らせる。
- `subscribe(onEvent, onDisconnect)`：検証済みイベントと切断を通知する。戻り値は購読解除関数。

HTTP＋SSE、WebSocket、テスト用の模擬通信などを、この窓口に合わせて実装する。
`subscribe` で受信を用意してから `send` が呼ばれる。接続が非同期の場合は、通信実装が接続完了まで送信を待つ。
実装は受信データの型・各値・カードIDの一意性を実行時に検証し、接続や要求のタイムアウトも管理する。
`clientId`・`userId` を送ること自体は認証ではない。将来のサーバーは接続の認証と編集権を別途検証する。

```ts
const client = createBoardClient(
  { boardId: 'board-1', userId: 'user-1', clientId: 'tab-1' },
  transport,
);

const unsubscribe = client.subscribe(() => {
  const state = client.getSnapshot();
  // state.boardを描画。編集中のプレビューにはstate.edit.draftを使う。
});

client.connect();
// 初回取得後、ユーザー操作から呼ぶ。
client.requestEdit('card-1');
// 許可イベントの受信後にのみ成功する。
client.updateDraft({ text: 'カフェのアイデア' });
client.commitEdit();

// 画面の破棄時
unsubscribe();
client.disconnect();
```

## Reactへの接続例

クライアントインスタンスはコンポーネント内で一度だけ作る。
下記の `identity`・`transport` は同じマウント期間中は固定とし、ボードや利用者を切り替える際は
コンポーネントの `key` を変えて再作成する。端末IDはブラウザ側でタブごとに生成する。

```tsx
'use client';

import { useState } from 'react';
import { createBoardClient, type BoardTransport } from '@/client/board-client';
import { useBoardClient } from '@/client/use-board-client';
import type { ClientIdentity } from '@/domain/board-protocol';

function BoardEditor({ identity, transport }: {
  identity: ClientIdentity;
  transport: BoardTransport;
}) {
  const [client] = useState(() => createBoardClient(identity, transport));
  const { state } = useBoardClient(client);

  if (state.status === 'offline') {
    return <button onClick={client.connect}>再接続</button>;
  }
  if (state.status === 'loading') return <p>読み込み中…</p>;

  return (
    <div>
      {state.error && <p role="alert">{state.error}</p>}
      {state.board?.cards.map(card => (
        <button key={card.cardId}
          disabled={state.edit.phase !== 'idle' || !!card.editingUser}
          onClick={() => client.requestEdit(card.cardId)}>
          {card.text}
        </button>
      ))}
      {state.edit.phase === 'editing' && (
        <>
          <textarea value={state.edit.draft.text}
            onChange={event => client.updateDraft({ text: event.target.value })} />
          <button onClick={client.commitEdit}>確定</button>
          <button onClick={client.cancelEdit}>取消</button>
        </>
      )}
      {state.edit.phase === 'requesting' && <p>編集許可を確認中…</p>}
      {state.edit.phase === 'saving' && <p>確定を待っています…</p>}
      {state.edit.phase === 'cancelling' && <p>取消を待っています…</p>}
    </div>
  );
}
```

`transport` は関数を持つため、Server Componentからpropsで渡さず、クライアント側で作る。
1つのインスタンスにつき接続を所有する `useBoardClient` は1か所とし、子には状態と操作を渡す。
React Flowのノードへの変換は表示層の仕事とし、選択・表示範囲を共有ボードに混ぜない。

## 現在実装されている同期契約

- 全イベントはボード全体と `revision` を持つ。差分配信ではないため、番号が飛んでも全体で復元できる。
- サーバー側はボードの内容・ロックの変更ごとに番号を増やす。同じ番号のボード内容は必ず同一とする。
- 古い番号と他ボードのイベントを無視する。同じ番号でも未処理の要求への応答は処理する。
- 自分が待っている応答が新しい更新より遅れて到着した場合は、古い許可を適用せず再接続を促す。
- 編集許可・確定・取消のイベントは、それぞれロック取得後・確定して解除した後・取消して解除した後のボードを含める。
- 要求への応答は `clientId`・`requestId`・`cardId` を返す。現在のHTTPアダプターは要求元にだけ応答を届け、全端末への配信は未実装。
- `lockId` は編集許可で発行し、確定・取消の際に送る。同じユーザーの別端末を区別してサーバーで確認する。
- 再接続では全体取得をやり直し、古い接続のコールバックや送信失敗は無視する。

通信失敗・切断・編集拒否・編集権消失では、今回の実装は下書きを破棄して編集を終了する。
切断後も最後の確定済みボードは保持するが、再取得まで編集はできない。
サーバー側では、暫定5分の有効期限を次回アクセス時に判定してロックを解除する。
オフライン下書きの復元、要求の自動再送、ロック延長、カード追加・削除の通信は未実装。

## フロント統合で変更する計画（未実装）

[frontend-merge-plan.md](./frontend-merge-plan.md) と [edit-lifecycle-plan.md](./edit-lifecycle-plan.md) に従い、次を変更する。上の現行APIの使用例は移行前のもので、新しいIDや複数編集の契約を示すものではない。

| 対象 | 計画 |
| --- | --- |
| IDと編集対象 | 構造化した `CardId` を内容で比較し、単一・複数カードを1件の貸し出しとして同じlockIdで扱う |
| 新規作成と本文操作 | 空カードをロックなしで追加・共有。入力欄で編集許可要求、空白キャンバスのタップかCtrl／⌘＋Enterで確定、Enter改行、Escape取消。フォーカス移動だけでは確定しない |
| ドラッグ | 許可待ちから本人だけ仮移動できる状態を、許可済み下書きと区別する。許可前に離したら最終位置を保持し、許可後に確定する |
| 拒否・取消 | 拒否なら最新の確定位置へ戻す。キャンセル後に遅れて許可されたロックは、移動を確定せず取消要求で解除する |
| 通信タイムアウト | 拒否やロック失効と同一視せず、確定／取消要求済みの状態と最終内容を保持する。1要求の失敗だけでSSE購読や回収用状態まで破棄しない設計へ見直す |
| 期限確認への返答 | 編集中なら変更を返し、確定要求済みなら最終内容、取消要求済みなら取消の状態を返す。対象ロック・問い合わせの世代を照合する |
| 更新順序 | ボードのrevision判定と、個別要求・ロックの完了判定を分ける。新しいボードを古い応答で巻き戻さず、単なる応答の前後だけで編集状態を消さない |
| リアクション・矢印・削除 | 本文編集とは独立した専用要求を送る。一括削除は選択ID一覧、全消去はサーバーに対象を決めさせる専用要求とする |
| 下書きの保持 | 本文等の下書きからリアクションを外す。削除済み参照や古い本文を、位置の保存等で復活させない |
| SSE・生成通知 | 初期スナップショットと購読開始の境界を揃える。生成IDを画面へ渡し、案内の重複はeventIdで防ぐ |
| Reaction定義 | アプリ共通の固定一覧を参照する。動的追加・カスタム定義のUIやAPIは設けない |
| 共有タイマー・サンプル | Board.timerを専用要求で同期。サンプル復元は全消去と同じ拒否条件でサーバーへ要求し、共有タイマーは保持 |
| リアクション操作 | 自分の付与をUIでは切り替え、通信では追加・取消を明示。同じ種類はユーザーごとに1件、異なる種類は複数可 |
| 矢印操作 | 自己接続・同一接続の重複を禁止し、異なるAnchor・逆向き・循環を許可。端点変更は削除再作成 |
| 共有カウントダウン | 初期5分停止。停止中は残り時間、実行中はサーバーの終了予定時刻から表示し、毎秒通信しない。0秒で停止しリセット後に再開 |
| AIの関連性 | 手動は低・中・高の選択値を送る。時限式はサーバーで中固定とし、同じ生成・配置関数を使う |
| 重複要求 | 応答不明時は元の要求内容・requestIdを維持。同じclientId・requestIdは二重実行せず、同ID異内容の拒否を受け取る |
| 関連先選択 | 参照元BlockCardの貸し出しを維持し、参照先を編集開始せず下書きへ追加。空白タップで確定、Escapeでは選択だけ中止 |
| キー削除 | 入力欄では文字削除、選択中のキャンバスではゴミ箱と同じ一括削除要求。サーバー確定前にローカルだけで消さない |
| リサイズ | カード全体を仮に伸縮し、許可後にshapeと必要なpositionを同時確定。拒否なら最新の確定サイズ・位置に戻す |
| AI進行表示 | 生成中・完了・失敗・競合破棄をサーバーのgenerationIdで対応付け、再接続時も現在状態を取得。固定時間で表示を解除しない |

複数移動は1つのlockIdに全対象を対応付け、取得・確定・取消・問い合わせ・途中保存・期限解除を貸し出し単位で扱う。
本文編集はフォーカスが外れただけでは確定せず、空白タップを押下時間と移動量で判定する。カード・矢印・UI上の操作やパン・ドラッグでは確定しない。キー操作を変更する設定は余裕があれば実装する追加機能であり、基本動作の必須要件には含めない。UIはAdjustのpage.tsxを基準に接続する。
BlockCardの本文欄だけの縦リサイズはカード全体の伸縮へ置き換え、文字サイズ自動調整・内部スクロールを外枠へ追従させる。関連先・リアクションの増加だけで外枠を自動保存しない。
通常の確定・取消が先に届けばそれで終了し、問い合わせは届かなかった要求の回収に共用する。確定成功後に応答だけが欠けた場合は問い合わせが来ないため、再同期で確定状態へ合わせる。
同じIDの再送には保持した前回の結果が返る。要求結果の保持期間・保存先、専用の結果照会API、自動再送の頻度・回数は未確定。再接続時の案内状態は初期化するが、未保存の編集情報をどこまで残すかは別途決める。
再送への古い結果で最新ボードを巻き戻さず、個別要求の完了判定を行う。リアクション・矢印の変更なし操作ではrevision・待機を変えない。
タイマーの0秒到達時の空フック `onTimerFinished` はサーバー側だけで1回呼び、各端末のカウント表示を契機に実行しない。

## 計画の検証観点

- 許可前の仮移動、許可より先に離す操作、拒否、キャンセル後の遅い許可を単一・複数の両方で扱える。
- タイムアウトしても問い合わせへの返答に必要な状態が残り、古い問い合わせや別ロックへ誤って返答しない。
- 本文・リアクション・関連先削除が並行しても、最新の確定内容を古い下書きで上書きしない。
- SSEとHTTPの順序が前後しても、状態が巻き戻らず、要求完了や生成ID通知が抜けない。
- 同ID再送で付与・作成・AI生成等が重複しない。UIのリアクショントグルが同じ要求の再送で反転しない。
- 関連先カードの選択で参照元が先に確定せず、空白タップとパン・ドラッグを区別できる。
- 入力欄のBackspaceでカードが消えず、キー削除とゴミ箱で同じサーバー検証が行われる。
- 古い生成の完了や遅いHTTP受付で、新しい生成中表示を消したり終了済みの生成を復活させたりしない。

## 検証

TypeScriptを直接実行できるNode.js（22.18以降）で実行する。

```sh
node --test src/domain/board.test.mjs src/client/board-client.test.mjs
```

テスト内の模擬通信から許可・拒否・確定・取消・切断を送ることで、実サーバーなしで検証できる。
