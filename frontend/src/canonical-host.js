// 本番の Firebase 既定ドメイン（<サイトID>.web.app / .firebaseapp.com）への
// アクセスを、カスタムドメインへリダイレクトする。
//
// Firebase Hosting のリダイレクト設定（firebase.json の redirects）はパスの
// マッチングしかできずホスト名で振り分けられないため、フロントエンド側で行う。
// カノニカルなホスト名はビルド時に VITE_CANONICAL_HOST で渡す（未設定なら
// リダイレクトしない）。
//
// PR プレビュー（<サイトID>--pr-N-xxxx.web.app）は本番とは別環境として
// そのまま使いたいので対象外にする。プレビューのホスト名には `--` が入る。

const FIREBASE_DEFAULT_HOST_SUFFIXES = ['.web.app', '.firebaseapp.com'];

/**
 * リダイレクト先の URL を返す。リダイレクト不要なら null。
 * 判定だけを行う純粋関数（テスト対象）。
 *
 * @param {string} currentUrl 現在の URL（location.href）
 * @param {string|undefined} canonicalHost カスタムドメインのホスト名
 * @return {string|null}
 */
export function canonicalRedirectUrl(currentUrl, canonicalHost) {
  const host = (canonicalHost || '').trim();
  if (!host) return null;

  const url = new URL(currentUrl);
  if (url.host === host) return null;

  const isFirebaseDefaultHost = FIREBASE_DEFAULT_HOST_SUFFIXES.some((suffix) =>
    url.hostname.endsWith(suffix)
  );
  if (!isFirebaseDefaultHost) return null;

  // プレビューチャンネルの URL は本番へ寄せない。
  if (url.hostname.includes('--')) return null;

  return `https://${host}${url.pathname}${url.search}${url.hash}`;
}

/**
 * 必要ならカノニカルなドメインへリダイレクトする。
 * リダイレクトした場合は true を返すので、呼び出し側は以降の初期化
 * （Clerk のロードなど）を中断すること。location.replace() は同期的に
 * スクリプトの実行を止めないため、早期 return が必要。
 *
 * @return {boolean}
 */
export function redirectToCanonicalHost() {
  const target = canonicalRedirectUrl(
    window.location.href,
    import.meta.env.VITE_CANONICAL_HOST
  );
  if (!target) return false;
  // 履歴に .web.app の URL を残さない。
  window.location.replace(target);
  return true;
}
