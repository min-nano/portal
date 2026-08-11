// ポータルの表示名（各ページのヘッダーと、トップページの <title>）。
//
// 組織ごとに変えられるよう、ビルド時に環境変数 VITE_PORTAL_TITLE で渡す。
// 未設定なら既定値を使うので、ローカル開発や CI では何も設定しなくてよい。
//
// 実際の埋め込みは vite.config.js のプラグインが行う（HTML 内の
// %PORTAL_TITLE% を置き換える）。JS で書き換えると初期表示が一瞬
// 既定値のままちらつくため、ビルド時に静的な HTML へ埋め込んでいる。

export const DEFAULT_PORTAL_TITLE = '社内ポータル';

/**
 * 環境変数の値からポータルの表示名を決める。未設定・空白のみなら既定値。
 *
 * @param {string|undefined} value VITE_PORTAL_TITLE の値
 * @return {string}
 */
export function resolvePortalTitle(value) {
  const trimmed = (value || '').trim();
  return trimmed || DEFAULT_PORTAL_TITLE;
}

/**
 * HTML のテキストとして安全に埋め込めるようエスケープする。
 * 表示名は運用者が設定する値だが、記号を含めても壊れないようにしておく。
 *
 * @param {string} text
 * @return {string}
 */
export function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
