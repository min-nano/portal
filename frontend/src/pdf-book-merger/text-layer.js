// 頁の文字情報（サーチャブル PDF の透明テキスト）の扱い。
//
// pdf.js の getTextContent() が返す断片を、頁番号の読み取り（page-numbers.js）
// が使う形——頁の幅・高さを 1 とした位置——に直す。あわせて、結合の前後で
// 文字情報が変わっていないことを確かめるための「指紋」を作る。
//
// pdf.js には触らず、返ってきた値だけを相手にする（テストで縛るため）。

/** pdf.js の Util.transform と同じ、2 つの変換行列の積。 */
export function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * getTextContent() の断片を、頁に対する割合の位置に直す。
 *
 * viewport は回転を含めて「画面に出る向き」なので、頁が 90° 回して保存されて
 * いても、上下の余白は画面で見たとおりの上下になる。
 *
 * @param {{items:{str?:string, transform:number[], width:number}[]}} content
 * @param {{width:number, height:number, transform:number[]}} viewport scale 1 のもの
 * @returns {{text:string, x0:number, x1:number, y:number, h:number}[]}
 */
export function textItems(content, viewport) {
  const { width, height } = viewport;
  const scale = Math.hypot(viewport.transform[0], viewport.transform[1]) || 1;
  return (content?.items || [])
    .filter((item) => typeof item.str === 'string' && item.str.trim())
    .map((item) => {
      const t = multiply(viewport.transform, item.transform);
      const length = Math.hypot(t[0], t[1]) || 1;
      const advance = (item.width || 0) * scale;
      const startX = t[4];
      const startY = t[5];
      const endX = startX + (t[0] / length) * advance;
      const endY = startY + (t[1] / length) * advance;
      return {
        text: item.str,
        x0: Math.min(startX, endX) / width,
        x1: Math.max(startX, endX) / width,
        y: (startY + endY) / 2 / height,
        h: Math.hypot(t[2], t[3]) / height,
      };
    });
}

/**
 * 頁の文字情報の指紋（空白を除いた文字列の長さと、FNV-1a のハッシュ）。
 *
 * 結合した PDF の頁が、元の頁と同じ文字情報を持っているかを確かめるのに
 * 使う。文字の区切り方（断片の切れ目・空白）は書き出し方で変わりうるので、
 * 空白を除いた文字だけで比べる。
 *
 * @param {{str?:string}[]} items getTextContent().items
 */
export function textSignature(items) {
  const text = (items || [])
    .map((item) => (typeof item.str === 'string' ? item.str : ''))
    .join('')
    .replace(/\s+/g, '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return { length: text.length, hash: hash.toString(16).padStart(8, '0') };
}
