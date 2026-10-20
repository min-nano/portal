// Drive の PDF を読む（サーバー経由で、少しずつ）。
//
// ブラウザへ Drive のアクセストークンは渡さない（README「4. Drive のファイル
// 選択」）ので、中身はサーバーが本人の代理で読んで中継する。スキャンした本は
// 1 冊で数百 MB になり、1 回のリクエストでは Cloud Run と Hosting のリライトの
// 上限に掛かるので、決まった大きさ（8 MiB）の範囲に分けて頼む
// （backend/app/tools/pdf_book_merger.py の /files）。サーバーは Drive から
// 範囲を読んで返すだけで、重い計算はしない。

import { apiGet, apiGetBytes } from '../api.js';

const TOOL_API = '/api/tools/pdf-book-merger';

/** 同時に頼む範囲の数（待ち時間を重ねて、運ぶ速さを上げる）。 */
const IN_FLIGHT = 4;
/** 1 つの範囲の読み込みが失敗したときに、頼み直す回数。 */
const RETRIES = 2;

async function fetchRange(path, start, end) {
  for (let attempt = 0; ; attempt++) {
    try {
      const bytes = new Uint8Array(await apiGetBytes(`${path}/content?start=${start}&end=${end}`));
      if (bytes.length !== end - start + 1) throw new Error('読み込んだ大きさが合いません。');
      return bytes;
    } catch (error) {
      if (attempt >= RETRIES) throw error;
    }
  }
}

/**
 * Drive の PDF を読む。
 *
 * @param {{id:string, name:string}} file ファイル選択ダイアログが返したもの
 * @param {{onProgress?: (received:number, total:number) => void}} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function downloadDriveFile(file, { onProgress } = {}) {
  const path = `${TOOL_API}/files/${encodeURIComponent(file.id)}`;
  let info;
  try {
    info = await apiGet(path);
    const bytes = new Uint8Array(info.size);
    const ranges = [];
    for (let start = 0; start < info.size; start += info.chunkBytes) {
      ranges.push([start, Math.min(info.size, start + info.chunkBytes) - 1]);
    }
    let next = 0;
    let received = 0;
    let failed = false; // 1 つでも読めなければ、残りは頼まない
    const worker = async () => {
      while (!failed && next < ranges.length) {
        const [start, end] = ranges[next++];
        try {
          bytes.set(await fetchRange(path, start, end), start);
        } catch (error) {
          failed = true;
          throw error;
        }
        received += end - start + 1;
        onProgress?.(received, info.size);
      }
    };
    await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, ranges.length) }, worker));
    return bytes;
  } catch (error) {
    throw new Error(`「${file.name}」を Drive から読み込めませんでした（${error?.message || error}）。`);
  }
}
