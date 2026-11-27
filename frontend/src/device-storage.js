// この端末の保存場所（localStorage）。
//
// サイトのデータを禁止したブラウザなどでは、localStorage を**読んだだけで**
// SecurityError になる。覚えておく値（ポータルの名前とロゴ、社内ユーザーと
// 確かめたアドレス）は、覚えられなくても毎回読み直すだけで困らないので、
// 取り出せなければ null を返し、使う側はそれを「覚えていない」として扱う。

/** @returns {Storage|null} */
export function deviceStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
