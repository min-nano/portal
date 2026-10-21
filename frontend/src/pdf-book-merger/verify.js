// 結合した PDF の検証（結合の前後の突き合わせ）。
//
// 結合した PDF を、もう一度はじめから読み直して、頁ごとに元の頁と比べる。
//
//   頁の数     … 並べた数と同じか
//   大きさ     … 元の頁と同じ大きさ・向きか
//   文字情報   … サーチャブル PDF の透明な文字が、元と同じだけ残っているか
//   描くもの   … 中身の命令とスキャンの画像が、元と 1 バイトも違わないか
//                （merge.js の pageDigest。画像を写し損ねていないか）
//
// 頁を描き直して見比べることはしない（スキャンの画像の展開は重い）。
// 読み直した結果を突き合わせるだけにする（テストで縛るため）。

/** 大きさの違いを見逃す幅（pt）。書き出しの丸めで僅かにずれることがある。 */
const SIZE_TOLERANCE = 0.5;

/**
 * @param {{pageKey:string, label:string, size:{width:number,height:number},
 *          signature:{length:number,hash:string}, digest:string}[]} expected
 *   並べた順の、元の頁
 * @param {{size:{width:number,height:number}, signature:{length:number,hash:string},
 *          digest:string}[]} actual 結合した PDF を読み直した頁
 * @returns {{ok:boolean, pageCount:{expected:number, actual:number},
 *            textPages:number, mismatches:{index:number, pageKey:string, label:string, reasons:string[]}[]}}
 */
export function compareOutput(expected, actual) {
  const mismatches = [];
  const count = Math.min(expected.length, actual.length);
  for (let i = 0; i < count; i++) {
    const want = expected[i];
    const got = actual[i];
    const reasons = [];
    if (
      Math.abs(want.size.width - got.size.width) > SIZE_TOLERANCE ||
      Math.abs(want.size.height - got.size.height) > SIZE_TOLERANCE
    ) {
      reasons.push('大きさ・向きが元の頁と違います');
    }
    if (want.signature.length !== got.signature.length || want.signature.hash !== got.signature.hash) {
      reasons.push(
        got.signature.length === 0 && want.signature.length > 0
          ? '文字情報（検索できる文字）が失われています'
          : '文字情報が元の頁と違います'
      );
    }
    if (want.digest !== got.digest) reasons.push('画像・描く中身が元の頁と違います');
    if (reasons.length) mismatches.push({ index: i, pageKey: want.pageKey, label: want.label, reasons });
  }
  return {
    ok: mismatches.length === 0 && expected.length === actual.length,
    pageCount: { expected: expected.length, actual: actual.length },
    textPages: actual.filter((page) => page.signature.length > 0).length,
    mismatches,
  };
}
