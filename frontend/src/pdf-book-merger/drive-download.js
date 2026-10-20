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

/** 途中で切れた・流量を絞られたときに、続きから読み直す回数。 */
const RETRIES = 4;
/** トークンが切れていたときに、取り直す回数（読み直しの回数には数えない）。 */
const TOKEN_RENEWALS = 2;
/** 読み直す前に待つ時間（回ごとに倍にする）。 */
const FIRST_DELAY_MS = 1000;

/** Drive が流量を絞ったときの理由（403 で返ってくる）。 */
const RATE_LIMITS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

/** Drive が断った失敗。 */
class DriveReadError extends Error {
  constructor(message, status, reason = '') {
    super(message);
    this.status = status;
    this.reason = reason;
  }

  /** 待てば読める失敗か（流量の制限・Drive 側の不調）。 */
  get retryable() {
    return this.status === 429 || this.status >= 500 || RATE_LIMITS.has(this.reason);
  }
}

async function driveError(response) {
  let detail = '';
  let reason = '';
  try {
    const { error } = await response.json();
    detail = error?.message || '';
    reason = error?.errors?.[0]?.reason || '';
  } catch {
    // 本文が JSON でない。
  }
  return new DriveReadError(
    detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`,
    response.status,
    reason
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      throw new DriveReadError('読み込んだ大きさが合いません。', 0, 'size');
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
 * @param {{onProgress?: (received:number, total:number) => void,
 *          delay?: (attempt:number) => number}} [options]
 *   delay は、attempt 回目の読み直しの前に待つミリ秒（既定は 1, 2, 4, 8 秒）
 * @returns {Promise<Uint8Array>}
 */
export async function downloadDriveFile(file, { onProgress, delay = (attempt) => FIRST_DELAY_MS * 2 ** attempt } = {}) {
  const path = `${TOOL_API}/files/${encodeURIComponent(file.id)}`;
  try {
    let info = await apiGet(path);
    const bytes = new Uint8Array(info.size);
    const state = { received: 0 };
    let retries = 0;
    let renewals = 0;
    for (;;) {
      try {
        await readInto(info, bytes, state, onProgress);
        return bytes;
      } catch (error) {
        // トークンが切れていたら、取り直してから続きを読む（読み直しには数えない）。
        if (error.status === 401 && renewals < TOKEN_RENEWALS) {
          renewals++;
          info = await apiGet(path);
          continue;
        }
        // 権限が無い・ファイルが無い・大きさが違う、は読み直しても同じ。回線が
        // 切れた・流量を絞られた・Drive の不調は、待ってから続きを読む。
        const drive = error instanceof DriveReadError;
        if (retries >= RETRIES || (drive && !error.retryable)) throw error;
        await sleep(delay(retries));
        retries++;
      }
    }
  } catch (error) {
    throw new Error(`「${file.name}」を Drive から読み込めませんでした（${error?.message || error}）。`);
  }
}
