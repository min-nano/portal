// 端末の見分け（書籍スキャン PDF 結合ツール）。
//
// iPhone・iPad かどうかは、canvas とメモリの対策（pdf-source.js）と、保存に
// 共有シートを使うか（save-file.js）の両方で使う。判定が食い違わないよう、
// ここ 1 か所で決める。

/**
 * WebKit で動いているか（Safari と、iPhone・iPad のすべてのブラウザ）。
 *
 * @param {{userAgent?:string, platform?:string, maxTouchPoints?:number}} [nav]
 */
export function isWebKit(nav) {
  if (!nav) return false;
  const userAgent = nav.userAgent || '';
  const safari = /Safari\//.test(userAgent) && !/Chrome\/|Chromium\/|Edg\/|Firefox\//.test(userAgent);
  return isIOS(nav) || safari;
}

/**
 * iPhone・iPad か（どのブラウザも WebKit。canvas とメモリの上限が小さい）。
 *
 * iPad の Safari は Mac を名乗るので、タッチの有無で見分ける。
 *
 * @param {{userAgent?:string, platform?:string, maxTouchPoints?:number}} [nav]
 */
export function isIOS(nav) {
  if (!nav) return false;
  return (
    /\b(?:iPad|iPhone|iPod)\b/.test(nav.userAgent || '') ||
    (nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1)
  );
}
