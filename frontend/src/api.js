// バックエンド API クライアント。
//
// 本番では Firebase Hosting のリライトで /api/** が Cloud Run へ転送され、
// ローカル開発では Vite の dev プロキシが同じパスを転送するため、常に
// 同一オリジンの相対パスで呼び出せる。全リクエストに Clerk のセッション
// トークンを Bearer として付与する。

import { getSessionToken } from './auth.js';
import { fileNameFromDisposition } from './content-disposition.js';

async function authorizedFetch(path, options = {}) {
  const token = await getSessionToken();
  return fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
}

async function raiseForError(resp) {
  if (resp.ok) return;
  let message = `サーバーエラーが発生しました (HTTP ${resp.status})。`;
  try {
    const body = await resp.json();
    if (body && body.error) message = body.error;
  } catch {
    // JSON でないエラー応答（プロキシ等）はそのまま既定メッセージを使う。
  }
  throw new Error(message);
}

/**
 * バックエンド（Cloud Run）を起こしておく。
 *
 * ツールの準備は「サインインの確認 → /config → 計算実装（wasm）」という
 * 直列の並びで、最初の /config が**インスタンスの起動待ち**を丸ごと被る
 * （常時起動のインスタンスは置いていない）。そこで、サインインの確認を
 * 始めるのと同時に、認証の要らない /api/healthz を投げておく。Clerk と
 * やり取りしているあいだに起動が済むので、その分が待ち時間から消える。
 *
 * 失敗しても構わない（起きていないなら、続く /config が普通に起こす）。
 * 呼び出し側は待たない。
 */
export function warmUpApi() {
  // no-store: 起こすのが目的なので、キャッシュで済まされては意味がない。
  fetch('/api/healthz', { cache: 'no-store' }).catch(() => {});
}

export async function apiGet(path) {
  const resp = await authorizedFetch(path);
  await raiseForError(resp);
  return resp.json();
}

/** バイナリ（wasm など）をそのまま受け取るエンドポイント用。 */
export async function apiGetBytes(path) {
  const resp = await authorizedFetch(path);
  await raiseForError(resp);
  return resp.arrayBuffer();
}

export async function apiSendJson(path, method, body) {
  const resp = await authorizedFetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await raiseForError(resp);
  return resp.json();
}

/** ファイルをアップロードして JSON を受け取るエンドポイント用。 */
export async function apiPostFile(path, file) {
  const form = new FormData();
  form.append('file', file);
  // Content-Type は指定しない。境界文字列付きの multipart/form-data を
  // ブラウザに組み立てさせる必要がある。
  const resp = await authorizedFetch(path, { method: 'POST', body: form });
  await raiseForError(resp);
  return resp.json();
}

/**
 * バイナリ（xlsx など）を返すエンドポイント用。Blob とファイル名を返す。
 *
 * 本文がファイルそのものなので、サーバーが添える情報（必要壁量の
 * 突き合わせ結果など）はヘッダに載る。読めるように headers も渡す。
 */
export async function apiPostForBlob(path, body, fallbackFileName) {
  const resp = await authorizedFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await raiseForError(resp);
  const blob = await resp.blob();
  const fileName =
    fileNameFromDisposition(resp.headers.get('Content-Disposition')) ||
    fallbackFileName;
  return { blob, fileName, headers: resp.headers };
}
