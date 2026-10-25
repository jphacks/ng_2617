import { MAX_BOARD_FILE_BYTES } from '../domain/board-file.ts';

// ファイル本体と識別情報の分。Content-Lengthを信用せずストリームも制限する。
export const MAX_BOARD_REQUEST_BYTES = MAX_BOARD_FILE_BYTES + 4096;
export async function readBoardRequest(request: Request): Promise<
  { value: unknown } | { error: string; status: number }
> {
  if (Number(request.headers.get('content-length')) > MAX_BOARD_REQUEST_BYTES) {
    return { status: 413, error: '送信データが大きすぎます。JSONファイルは5 MiB以下にしてください。' };
  }
  if (!request.body) return { status: 400, error: 'JSONが不正です。' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BOARD_REQUEST_BYTES) {
        await reader.cancel();
        return { status: 413, error: '送信データが大きすぎます。JSONファイルは5 MiB以下にしてください。' };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch { return { status: 400, error: 'JSONが不正です。' }; }
  finally { reader.releaseLock(); }
}
