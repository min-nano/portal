// 結合した PDF を Drive へ保存する（再開可能なアップロードを、サーバー経由で）。
//
// 書き込みはサーバー側でしか行わない（ブラウザへ書き込みの権限は渡さない）。
// 1 冊ぶんの PDF は 1 回のリクエストに収まらないので、サーバーが Drive に
// 受け口を作り、画面は決まった大きさに切って順に送る
// （backend/app/tools/pdf_book_merger.py）。

import { apiPostForm, apiSendJson } from '../api.js';

const TOOL_API = '/api/tools/pdf-book-merger';

// 1 回分の送信が失敗したときに、同じ位置から送り直す回数。
const RETRIES = 3;

/**
 * @param {Uint8Array} bytes 保存する PDF
 * @param {{folderId:string, fileName:string}} destination
 * @param {{onProgress?: (sent:number, total:number) => void}} [options]
 * @returns {Promise<{fileId:string, fileName:string, webViewLink:string}>}
 */
export async function uploadToDrive(bytes, { folderId, fileName }, { onProgress } = {}) {
  const total = bytes.length;
  const session = await apiSendJson(`${TOOL_API}/uploads`, 'POST', {
    folderId,
    fileName,
    size: total,
  });

  let offset = 0;
  let failures = 0; // 続けて失敗した送信
  let stalls = 0; // 続けて 1 バイトも進まなかった送信
  for (;;) {
    const end = Math.min(total, offset + session.chunkBytes);
    const form = new FormData();
    form.append('uploadId', session.uploadId);
    form.append('offset', String(offset));
    form.append('total', String(total));
    form.append('chunk', new Blob([bytes.subarray(offset, end)]), 'chunk');
    let result;
    try {
      result = await apiPostForm(`${TOOL_API}/uploads/chunk`, form);
      failures = 0;
    } catch (error) {
      if (++failures > RETRIES) throw error;
      continue;
    }
    if (result.done) {
      onProgress?.(total, total);
      return result;
    }
    // Drive が受け取った分の続きから送る（送った分より少ないことがある）。
    // 1 つも進まないことが続くなら、送り直しても同じなので諦める。
    stalls = result.received > offset ? 0 : stalls + 1;
    if (stalls > RETRIES) {
      throw new Error('Drive が続きを受け取りませんでした。もう一度保存してください。');
    }
    offset = result.received;
    onProgress?.(offset, total);
  }
}
