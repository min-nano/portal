// URL で指定された PDF を読む（ブラウザがその URL から直接）。
//
// ほかの読み込みと同じく、中身はサーバー（Cloud Run・Hosting）を通さない。
// サーバーを通すと転送量が掛かるうえ、サーバーから社内外の任意の URL を
// 読みに行けるようになってしまう（SSRF）ため。そのぶん、相手のサーバーが
// ブラウザからの読み込みを許していない（CORS のヘッダーを返さない）と読めない。
// Cookie などの資格情報は送らない（credentials: 'omit'）。

/** 大きさが分からないときに、はじめに用意する場所（足りなければ倍にする）。 */
const FIRST_CAPACITY = 1024 * 1024;

/**
 * 入力された文字列から、読む URL を取り出す（空白・改行で区切っていくつでも）。
 * http・https でないものは、bad に入れて返す。https のページからは http の URL を
 * ブラウザが読ませない（混在コンテンツ）ので、それも bad に入れる。
 *
 * @param {string} text
 * @param {string} [pageProtocol] このページの protocol（既定は location.protocol）
 * @returns {{urls: string[], bad: string[], schemes: string}} schemes は、読める URL の種類（知らせる文に使う）
 */
export function parseUrls(text, pageProtocol = globalThis.location?.protocol) {
  const allowed = pageProtocol === 'https:' ? ['https:'] : ['http:', 'https:'];
  const urls = [];
  const bad = [];
  for (const word of String(text).split(/\s+/)) {
    if (!word) continue;
    let url;
    try {
      url = new URL(word);
    } catch {
      bad.push(word);
      continue;
    }
    if (allowed.includes(url.protocol)) urls.push(url.href);
    else bad.push(word);
  }
  return { urls, bad, schemes: allowed.map((protocol) => protocol.slice(0, -1)).join('・') };
}

/**
 * URL から、一覧に出すファイルの名前を決める（読む前に決めるので、パスの最後の
 * 部分から。Content-Disposition は CORS で読めないことが多い）。パスが空なら
 * ホスト名にする。名前の最後に .pdf が無ければ付ける。
 *
 * @param {string} href
 */
export function nameFromUrl(href) {
  const url = new URL(href);
  const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  let name;
  try {
    name = decodeURIComponent(last);
  } catch {
    name = last; // % の並びが壊れている。そのまま出す。
  }
  name = name.trim() || url.hostname;
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

/**
 * URL の PDF を読む。
 *
 * @param {string} url
 * @param {{onProgress?: (received:number, total:number) => void,
 *          reserve?: (size:number) => Promise<void>}} [options]
 *   onProgress の total は、大きさが分からなければ 0（圧縮して送られ、Content-Length を
 *   超えて届いたときは、届いた分）。reserve は、読み始める前に
 *   分かった大きさ（分からなければ 0）で待つ（download-pool.js）
 * @returns {Promise<Uint8Array>}
 */
export async function downloadUrlFile(url, { onProgress, reserve } = {}) {
  let response;
  try {
    response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
  } catch (error) {
    // ブラウザは、CORS で断られたのか、つながらなかったのかを区別させない。
    throw new Error(
      `「${url}」を読み込めませんでした（つながらないか、相手のサーバーがブラウザからの読み込みを許していません: ${error?.message || error}）。`
    );
  }
  if (!response.ok) throw new Error(`「${url}」を読み込めませんでした（HTTP ${response.status}）。`);

  // 圧縮して送られると、Content-Length は届く中身より小さい。その分は場所を広げる。
  const length = Number(response.headers.get('Content-Length'));
  const total = Number.isSafeInteger(length) && length > 0 ? length : 0;
  await reserve?.(total);
  let bytes = new Uint8Array(total || FIRST_CAPACITY);
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.length > bytes.length) {
        const grown = new Uint8Array(Math.max(bytes.length * 2, received + value.length));
        grown.set(bytes.subarray(0, received));
        bytes = grown;
      }
      bytes.set(value, received);
      received += value.length;
      onProgress?.(received, total && Math.max(total, received));
    }
  } catch (error) {
    throw new Error(`「${url}」の読み込みが途中で切れました（${error?.message || error}）。`);
  }
  // 圧縮して送られたときは Content-Length より多く届くので、少ないときだけ切れたと見る。
  if (received < total) throw new Error(`「${url}」の読み込みが途中で切れました（${received} / ${total} バイト）。`);
  return received === bytes.length ? bytes : bytes.slice(0, received);
}
