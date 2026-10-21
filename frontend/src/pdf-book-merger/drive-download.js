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
/**
 * 流量を絞られたときは、少なくともこの時間（回ごとに倍）は待つ。Drive の
 * Retry-After は、ブラウザからは読めないことが多い（CORS で公開されていない）。
 */
const RATE_LIMIT_DELAY_MS = 5000;

/** Retry-After で待つ時間の上限。 */
const MAX_RETRY_AFTER_MS = 2 * 60 * 1000;
/** 1 つのファイルで、読み直しのために待つ時間の合計の上限。 */
const MAX_TOTAL_WAIT_MS = 3 * 60 * 1000;
/** 読んでいる間に Drive のファイルが差し替えられたとき、始めから読み直す回数。 */
const RESTARTS = 1;

/**
 * Drive が流量を絞ったときの理由（403 でも返ってくる）。errors[].reason、
 * details[].reason、status のどこかに入る。
 */
const RATE_LIMITS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED', 'RESOURCE_EXHAUSTED']);

/** Drive が断った失敗。 */
class DriveReadError extends Error {
  constructor(message, status, reasons = [], retryAfterMs = 0) {
    super(message);
    this.status = status;
    this.reasons = reasons;
    this.retryAfterMs = retryAfterMs;
  }

  /** 流量を絞られたか。 */
  get rateLimited() {
    return this.status === 429 || this.reasons.some((reason) => RATE_LIMITS.has(reason));
  }

  /** 待てば読める失敗か（流量の制限・Drive 側の不調）。 */
  get retryable() {
    return this.rateLimited || this.status >= 500;
  }

  /** 読んでいる間にファイルが差し替えられたかもしれない失敗か（大きさが合わない・続きが無い）。 */
  get changed() {
    return this.status === 416 || this.reasons.includes('size');
  }
}

/** Retry-After（秒か日時）を、待つミリ秒に直す。読めなければ 0。 */
function retryAfterMs(value) {
  if (!value) return 0;
  const ms = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : 0;
}

async function driveError(response) {
  let detail = '';
  const reasons = [];
  try {
    const { error } = await response.json();
    detail = error?.message || '';
    for (const item of [...(error?.errors || []), ...(error?.details || [])]) {
      if (item?.reason) reasons.push(item.reason);
    }
    if (error?.status) reasons.push(error.status);
  } catch {
    // 本文が JSON でない。
  }
  return new DriveReadError(
    detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`,
    response.status,
    reasons,
    retryAfterMs(response.headers.get('Retry-After'))
  );
}

/** サーバーへの問い合わせの、待てば通りうる失敗か（回線が切れた・サーバーの不調）。 */
function transient(error) {
  return error instanceof TypeError || error?.status === 429 || error?.status >= 500;
}

/** 同じ版のファイルか（大きさと、Drive の版）。 */
function sameVersion(a, b) {
  return a.size === b.size && (a.revision ?? null) === (b.revision ?? null);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 読み直す前に待つ時間の既定（回ごとに倍。流量を絞られたときは長め）。 */
function defaultDelay(attempt, rateLimited) {
  return (rateLimited ? RATE_LIMIT_DELAY_MS : FIRST_DELAY_MS) * 2 ** attempt;
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
      throw new DriveReadError('読み込んだ大きさが合いません。', 0, ['size']);
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
 *          onWait?: (ms:number, reason:string) => void,
 *          delay?: (attempt:number, rateLimited:boolean) => number}} [options]
 *   onWait は、読み直す前に待ち始めるときに呼ぶ（画面と記録に出すため）。
 *   delay は、attempt 回目の読み直しの前に待つミリ秒（既定は 1, 2, 4, 8 秒。
 *   流量を絞られたときは 5, 10, 20, 40 秒）
 * @returns {Promise<Uint8Array>}
 */
export async function downloadDriveFile(file, { onProgress, onWait, delay = defaultDelay } = {}) {
  const path = `${TOOL_API}/files/${encodeURIComponent(file.id)}`;
  try {
    let info = await apiGet(path);
    let bytes = new Uint8Array(info.size);
    const state = { received: 0 };
    let retries = 0;
    let renewals = 0;
    let restarts = 0;
    let resumed = false; // 続きから読んだことがあるか（別の版がつながりうる）
    let waited = 0;

    /** 待ってから読み直す（回数か、待つ時間の合計を使い切っていれば、失敗を投げる）。 */
    const backoff = async (error) => {
      if (retries >= RETRIES) throw error;
      const rateLimited = Boolean(error.rateLimited);
      const wait = Math.max(delay(retries, rateLimited), error.retryAfterMs || 0);
      if (waited + wait > MAX_TOTAL_WAIT_MS) throw error;
      onWait?.(wait, rateLimited ? 'Drive の流量制限' : error?.message || String(error));
      await sleep(wait);
      waited += wait;
      retries++;
    };
    /** サーバーに聞き直す（トークンの取り直しと、版の確かめ）。一時的な失敗は待ってやり直す。 */
    const askAgain = async () => {
      for (;;) {
        try {
          return await apiGet(path);
        } catch (error) {
          if (!transient(error)) throw error;
          await backoff(error);
        }
      }
    };
    /** 聞き直した版が違えば、始めから読み直す。 */
    const follow = (next) => {
      if (!sameVersion(info, next)) {
        if (restarts >= RESTARTS) throw new Error('読んでいる間に、Drive のファイルが差し替えられました。');
        restarts++;
        bytes = new Uint8Array(next.size);
        state.received = 0;
        resumed = false;
      }
      info = next;
    };

    for (;;) {
      if (state.received > 0) resumed = true;
      try {
        await readInto(info, bytes, state, onProgress);
      } catch (error) {
        // トークンが切れていたら、取り直してから続きを読む（読み直しには数えない）。
        if (error.status === 401 && renewals < TOKEN_RENEWALS) {
          renewals++;
          follow(await askAgain());
          continue;
        }
        // 続きから読んでいる間に大きさの違う版へ差し替えられると、大きさが合わ
        // ないか、続きが無い（416）。版を聞き直し、違えば始めから読み直す。
        if (error instanceof DriveReadError && error.changed) {
          const next = await askAgain();
          if (sameVersion(info, next)) throw error;
          follow(next);
          continue;
        }
        // 権限が無い・ファイルが無い・大きさが違う、は読み直しても同じ。回線が
        // 切れた・流量を絞られた・Drive の不調は、待ってから続きを読む。
        if (error instanceof DriveReadError && !error.retryable) throw error;
        await backoff(error);
        continue;
      }
      // 続きから読んだときは、読み終えたあとも同じ版か確かめる。始めと終わりで
      // 版が同じなら、その間に読んだ部分もすべてその版（版は戻らない）。
      if (!resumed) return bytes;
      const after = await askAgain();
      if (sameVersion(info, after)) return bytes;
      follow(after);
    }
  } catch (error) {
    throw new Error(`「${file.name}」を Drive から読み込めませんでした（${error?.message || error}）。`);
  }
}
