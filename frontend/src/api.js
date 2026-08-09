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

export async function apiGet(path) {
  const resp = await authorizedFetch(path);
  await raiseForError(resp);
  return resp.json();
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

/** バイナリ（xlsx など）を返すエンドポイント用。Blob とファイル名を返す。 */
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
  return { blob, fileName };
}
