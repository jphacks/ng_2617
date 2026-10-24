# クライアントのボード管理

`docs/backend-structure.md` の編集フローを、通信方式や画面から独立した状態管理として実装した。
取得専用のHTTPサーバーと画面への接続も追加済み。現在の接続構成は
[board-server.md](./board-server.md) を参照。以下の編集フローはクライアント側の基盤であり、編集用サーバーはまだ未実装。

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

## 今回決めた暫定の同期契約

- 全イベントはボード全体と `revision` を持つ。差分配信ではないため、番号が飛んでも全体で復元できる。
- サーバー側はボードの内容・ロックの変更ごとに番号を増やす。同じ番号のボード内容は必ず同一とする。
- 古い番号と他ボードのイベントを無視する。同じ番号でも未処理の要求への応答は処理する。
- 自分が待っている応答が新しい更新より遅れて到着した場合は、古い許可を適用せず再接続を促す。
- 編集許可・確定・取消のイベントは、それぞれロック取得後・確定して解除した後・取消して解除した後のボードを含める。
- 要求への応答は `clientId`・`requestId`・`cardId` を返す。確定イベントは操作した端末も含め全端末に送る。
- `lockId` は編集許可で発行し、確定・取消の際に送る。同じユーザーの別端末を区別してサーバーで確認する。
- 再接続では全体取得をやり直し、古い接続のコールバックや送信失敗は無視する。

通信失敗・切断・編集拒否・編集権消失では、今回の実装は下書きを破棄して編集を終了する。
切断後も最後の確定済みボードは保持するが、再取得まで編集はできない。
切断した端末のロックを解除する仕組みや有効期限はサーバー側で今後実装する。
オフライン下書きの復元、要求の自動再送、ロック延長、カード追加・削除の通信は未実装。

## 検証

TypeScriptを直接実行できるNode.js（22.18以降）で実行する。

```sh
node --test src/domain/board.test.mjs src/client/board-client.test.mjs
```

テスト内の模擬通信から許可・拒否・確定・取消・切断を送ることで、実サーバーなしで検証できる。
