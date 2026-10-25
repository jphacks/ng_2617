/** サーバーが処理を開始していないと明示した要求。結果不明の通信失敗とは分ける。 */
export class BoardRequestRejectedError extends Error {}
