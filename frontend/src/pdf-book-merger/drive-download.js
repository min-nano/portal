// Drive の PDF を読む（ブラウザが Drive から直接）。
//
// スキャンした本は 1 冊で数百 MB になる。サーバー（Cloud Run・Hosting）を
// 通して運ぶと、読み直すたびに転送量が掛かるので、中身は通さない。サーバーは
// PDF か確かめて、本人の代理（読み取り専用）のアクセストークンを渡すだけで
// （backend/app/tools/pdf_book_merger.py の /files）、画面がそのトークンで
// Drive API から直接読む。
//
// トークンは本人の Drive を期限（1 時間ほど）まで読めるので、どこにも保存せず、
// 読み終えたら手放す（この関数の外へは出さない）。

import { apiGet } from '../api.js';

const TOOL_API = '/api/tools/pdf-book-merger';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

/** 途中で切れたときに、続きから読み直す回数。 */
const RETRIES = 2;

/** 読み直しても変わらない失敗（権限が無い・ファイルが無いなど）。 */
class DriveReadError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function driveError(response) {
  let detail = '';
  try {
    detail = (await response.json())?.error?.message || '';
  } catch {
    // 本文が JSON でない。
  }
  return new DriveReadError(detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`, response.status);
}

/**
 * Drive から読み、bytes の state.received バイト目から書き込む（読み直しは続きから）。
 * Drive が範囲を無視して頭から返したときは、頭から書き直す。
 */
async function readInto(info, bytes, state, onProgress) {
  const headers = { Authorization: `Bearer ${info.accessToken}` };
  if (state.received > 0) headers.Range = `bytes=${state.received}-`;
  const url = `${DRIVE_FILES}/${encodeURIComponent(info.id)}?alt=media&supportsAllDrives=true`;
  const response = await fetch(url, { headers, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw await driveError(response);
  if (state.received > 0 && response.status !== 206) state.received = 0;

  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (state.received + value.length > bytes.length) {
      await reader.cancel();
      throw new DriveReadError('読み込んだ大きさが合いません。', 0);
    }
    bytes.set(value, state.received);
    state.received += value.length;
    onProgress?.(state.received, bytes.length);
  }
  if (state.received !== bytes.length) throw new Error('読み込みが途中で切れました。');
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
  try {
    let info = await apiGet(path);
    const bytes = new Uint8Array(info.size);
    const state = { received: 0 };
    for (let attempt = 0; ; attempt++) {
      try {
        await readInto(info, bytes, state, onProgress);
        return bytes;
      } catch (error) {
        const expired = error.status === 401;
        // 権限が無い・ファイルが無い・大きさが違う、は読み直しても同じ。
        if (attempt >= RETRIES || (error instanceof DriveReadError && !expired && error.status < 500)) throw error;
        // トークンが切れていたら、取り直してから続きを読む。
        if (expired) info = await apiGet(path);
      }
    }
  } catch (error) {
    throw new Error(`「${file.name}」を Drive から読み込めませんでした（${error?.message || error}）。`);
  }
}
