// Clerk のフロントエンド API（サインインの確認で最初に叩く先）のホスト名を、
// Publishable Key から取り出す。
//
// 画面を開いてから使えるようになるまでの待ち時間は、その大半が
// 「JS を読む → Clerk がフロントエンド API に問い合わせる」の直列な 2 段。
// このホスト名はビルドの時点で分かるので、HTML の <head> に
//
//   <link rel="preconnect" href="https://<ホスト名>">
//
// を入れておく。名前解決・TCP・TLS の握手が JS の読み込みと並行して進み、
// その分だけ問い合わせが早く返る（vite.config.js の clerkPreconnectPlugin）。
//
// Publishable Key は「pk_test_ / pk_live_ + base64("<ホスト名>$")」という
// 作りで、Clerk 自身も同じ規則で復号している（@clerk/shared の
// parsePublishableKey）。公開してよい値なので、HTML に出しても問題はない
// （そもそも JS のバンドルに入っている）。

const PREFIXES = ['pk_test_', 'pk_live_'];

/**
 * Publishable Key からフロントエンド API のホスト名を返す。
 * 鍵が未設定・形が違う・ホスト名として読めないときは null（preconnect を
 * 入れないだけで、画面の動きは変わらない）。
 *
 * @param {string|undefined} publishableKey
 * @return {string|null}
 */
export function clerkFrontendApiHost(publishableKey) {
  const key = (publishableKey || '').trim();
  const prefix = PREFIXES.find((p) => key.startsWith(p));
  if (!prefix) return null;

  let decoded;
  try {
    decoded = atob(key.slice(prefix.length));
  } catch {
    return null;
  }

  // 復号すると「<ホスト名>$」になる。
  if (!decoded.endsWith('$')) return null;
  const host = decoded.slice(0, -1);
  // ホスト名として読めるものだけを通す（HTML に書き出すため）。
  if (!host.includes('.')) return null;
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(host)) return null;

  return host;
}
