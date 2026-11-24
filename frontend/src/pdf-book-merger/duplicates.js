// 同じ頁が 2 度入っていないかを、頁の中身（文字情報と画像）で確かめる。
//
// 頁番号の重なり（ordering.js の checkSequence）は、番号を読めた本文の頁でしか
// 分からない。同じ頁を 2 度スキャンした・同じ頁を含むファイルを 2 度足した、
// といった失敗を、表紙や番号の無い頁、頁番号の無い PDF を一覧の順につなぐとき
// にも見つけるため、頁の中身どうしを見比べる。
//
//   文字情報 … 文字の 3 つ並び（和文は 1 字、英文などは 1 語を 1 つと数える）の
//              集まりの重なり（Jaccard 係数）を、MinHash で見積もる
//   画像     … 中身の範囲をます目に分けたインクの量の指紋の相関
//              （image-checks.js の imagePrint）
//
// 文字情報が十分にある頁どうしは、文字情報で決める（画像は、本文の頁どうし
// だと似やすい）。文字情報が少ない・無い頁は、画像で決める。どちらの場合も、
// もう一方の手掛かりが大きく違えば別の頁とする。
//
// しきい値は、README を切った頁（日本語）・利用許諾の文（英語）と、それに
// OCR の読み違いを混ぜたもの、本文を描いた画像をずらし・回し・明るさを変えた
// もので決めた（下の各値の注を参照）。
//
// pdf.js にも DOM にも触らない（テストで縛るため）。

import { PRINT_COLUMNS, PRINT_ROWS, printSimilarity } from './image-checks.js';
import { pageNumberText } from './page-numbers.js';
import { fnv1a } from './text-layer.js';

/** MinHash の数。多いほど見積もりが確かになる（64 で誤差はおよそ ±0.06）。 */
const HASHES = 64;
/** 文字の 3 つ並びの数がこれ以上あれば、文字情報だけで決める。 */
const TEXT_ENOUGH = 30;
/**
 * 同じ頁とみなす文字情報の重なり。違う頁どうしは多くて 0.22（英文）、同じ頁を
 * 読み直したもの（英字の 2% を読み違えた）は 0.5 以上だった。
 */
const SAME_TEXT = 0.4;
/**
 * 文字情報が少ない（画像で決める）とき、2 つの文字情報の量が 2 倍以内なのに、
 * 重なりがこれより小さければ別の頁とする（読み直しでも 0.5 はある）。
 */
const DIFFERENT_TEXT = 0.25;
/**
 * 同じ頁とみなす画像の指紋の相関。違う頁どうしは多くて 0.2、同じ頁を置き直して
 * スキャンし直したものは 0.6 以上だった。
 */
const SAME_IMAGE = 0.5;
/** 文字情報で同じとみなしたときに、これより画像の相関が低ければ別の頁とする。 */
const DIFFERENT_IMAGE = 0.3;
/** これ以上の相関なら、画像は同じもの（同じ頁を写したもの）。 */
const IDENTICAL_IMAGE = 0.995;
/**
 * 画像の指紋を見比べる前に、粗い指紋（4 × 4 のます目をまとめた 8 × 12）で
 * ふるい落とす相関。同じ頁どうしは粗い指紋で 0.83 以上、違う頁どうしで
 * これを超えたのは 1.5% だった。1,000 頁の本で、見比べる手間が 1/10 ほどになる。
 */
const COARSE_GATE = 0.3;
const COARSE_CELL = 4;

/**
 * 1 つと数えるもの: 語を空白で区切る文字（ラテン文字・キリル文字・アラビア文字・
 * ハングルなど。重ねたアクセントも含む）と数字のつながり（語）か、それ以外の 1 字。
 * 漢字・かな・タイ文字のように語を区切らない文字と、記号（長音符「ー」も）は 1 字ずつ。
 */
const UNITS =
  /(?:(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Common}])[\p{L}\p{N}]|[0-9])\p{M}*)+|\S/gu;
/** 異体字セレクタ（読み直しで付いたり付かなかったりする）。 */
const VARIATION_SELECTORS = /[\u{180B}-\u{180D}\u{180F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

/** 32 bit の値をかき混ぜる（MurmurHash3 の仕上げ）。 */
function mix(value) {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * 文字情報の指紋（文字の 3 つ並びの集まりの MinHash）。
 *
 * 全角・半角や大文字・小文字の違いは読み直しで変わりうるので、そろえてから
 * 数える。漢字・かなは 1 字、ほかの文字（ラテン文字・ギリシャ文字・キリル
 * 文字など。アクセントも含む）と数字は、つながった 1 語を 1 つと数える（英文を
 * 字で数えると、「the」「ing」のような並びがどの頁にもあり、違う頁でも重なりが
 * 大きくなる）。
 *
 * @param {string} text
 * @returns {{size:number, mins:Uint32Array, hash:number, length:number}|null} 3 つ並びが 1 つも
 *   無ければ null。hash と length は、そろえた文字情報そのものの FNV-1a と長さ（中身まで
 *   同じかを決める）
 */
export function textPrint(text) {
  const units = String(text ?? '')
    .normalize('NFKC')
    .replace(VARIATION_SELECTORS, '')
    .toLowerCase()
    .match(UNITS);
  if (!units || units.length < 3) return null;
  const shingles = new Set();
  for (let i = 0; i + 3 <= units.length; i++) shingles.add(fnv1a(`${units[i]}\u0001${units[i + 1]}\u0001${units[i + 2]}`));
  const mins = new Uint32Array(HASHES).fill(0xffffffff);
  for (const shingle of shingles) {
    for (let k = 0; k < HASHES; k++) {
      const h = mix(shingle ^ Math.imul(k + 1, 0x9e3779b9));
      if (h < mins[k]) mins[k] = h;
    }
  }
  const joined = units.join('\u0001');
  return { size: shingles.size, mins, hash: fnv1a(joined), length: joined.length };
}

/** 2 つの文字情報の指紋の重なりの見積もり（0〜1）。どちらかが無ければ null。 */
export function textSimilarity(a, b) {
  if (!a || !b) return null;
  let same = 0;
  for (let k = 0; k < HASHES; k++) if (a.mins[k] === b.mins[k]) same++;
  return same / HASHES;
}

/** 画像の指紋 → 粗い指紋（作ったものは覚えておく）。 */
const coarsePrints = new WeakMap();

/** 画像の指紋の、4 × 4 のます目を足し合わせた粗い指紋。 */
function coarsePrint(print) {
  let coarse = coarsePrints.get(print);
  if (!coarse) {
    const columns = PRINT_COLUMNS / COARSE_CELL;
    coarse = new Int16Array(columns * (PRINT_ROWS / COARSE_CELL));
    for (let y = 0; y < PRINT_ROWS; y++) {
      for (let x = 0; x < PRINT_COLUMNS; x++) {
        coarse[Math.floor(y / COARSE_CELL) * columns + Math.floor(x / COARSE_CELL)] += print[y * PRINT_COLUMNS + x];
      }
    }
    coarsePrints.set(print, coarse);
  }
  return coarse;
}

/**
 * 2 つの頁が同じ頁らしいか。
 *
 * @param {{text:ReturnType<typeof textPrint>, image:Int8Array|null}} a
 * @param {{text:ReturnType<typeof textPrint>, image:Int8Array|null}} b
 * @returns {{exact:boolean}|null} 同じ頁らしくなければ null。exact は中身まで同じもの
 *   （同じ頁を含むファイルを 2 度足した。文字情報がそのまま同じで、画像の指紋も
 *   同じ。片方にだけ画像の指紋があれば、そうとは言わない）
 */
export function samePage(a, b) {
  // 画像の見比べは重い（1 組で 1,536 のます目）ので、要るときだけ行う。
  const text = textSimilarity(a.text, b.text);
  let image;
  if (text !== null && Math.min(a.text.size, b.text.size) >= TEXT_ENOUGH) {
    if (text < SAME_TEXT) return null;
    image = printSimilarity(a.image, b.image);
    if (image !== null && image < DIFFERENT_IMAGE) return null;
  } else {
    // 文字情報の量が 2 倍以上違うとき（片方の OCR がほとんど読めなかった）は、
    // 大きさの違う集まりの重なりは小さく出るので、文字情報では決めない。
    const comparable = text !== null && Math.min(a.text.size, b.text.size) * 2 >= Math.max(a.text.size, b.text.size);
    if (comparable && text < DIFFERENT_TEXT) return null;
    if (!a.image || !b.image || printSimilarity(coarsePrint(a.image), coarsePrint(b.image)) < COARSE_GATE) return null;
    image = printSimilarity(a.image, b.image);
    if (image < SAME_IMAGE) return null;
  }
  // 中身まで同じかは、MinHash ではなく文字情報そのもので決める（MinHash は、
  // 9 割 8 分重なる読み直しでも 4 回に 1 回ほど 64 個すべてがそろう）。どちらにも
  // 文字情報が無ければ同じとみなし、片方にだけあれば違う。画像も同じで、どちらにも
  // 指紋が無い（インクのごく少ない頁）なら同じとみなし、片方にだけあれば違う。
  const sameText =
    a.text && b.text
      ? a.text.hash === b.text.hash && a.text.length === b.text.length
      : a.text === b.text;
  const sameImage = image === null ? a.image === b.image : image >= IDENTICAL_IMAGE;
  return { exact: sameText && sameImage };
}

/**
 * 同じ頁らしい組を探す。前に見比べた頁どうしは見比べ直さない（ファイルを
 * 1 つ調べ終えるたびに並びを組み立て直すので、新しく加わった頁だけを、
 * ほかのすべての頁と見比べる）。
 *
 * @returns {(pages:{key:string, text:object|null, image:Int8Array|null}[]) =>
 *   {a:string, b:string, exact:boolean}[]}
 */
export function createDuplicateFinder() {
  /** 見比べ済みの頁（key → そのときの指紋）。 */
  const seen = new Map();
  let pairs = [];
  return (pages) => {
    const isOld = (page) => {
      const before = seen.get(page.key);
      return before !== undefined && before.text === page.text && before.image === page.image;
    };
    const old = pages.filter(isOld);
    const fresh = pages.filter((page) => !isOld(page));
    const keep = new Set(old.map((page) => page.key));
    for (const key of seen.keys()) if (!keep.has(key)) seen.delete(key);
    pairs = pairs.filter((pair) => keep.has(pair.a) && keep.has(pair.b));
    fresh.forEach((page, i) => {
      for (const other of [...old, ...fresh.slice(i + 1)]) {
        const same = samePage(page, other);
        if (same) pairs.push({ a: other.key, b: page.key, exact: same.exact });
      }
    });
    for (const page of fresh) seen.set(page.key, { text: page.text, image: page.image });
    return pairs;
  };
}

/** 指摘に挙げる数。これより多ければ「ほか N」と添える（指摘が長くなりすぎないように）。 */
const MAX_LISTED = 3;

function listed(names, separator) {
  const shown = names.slice(0, MAX_LISTED).join(separator);
  return names.length > MAX_LISTED ? `${shown}ほか ${names.length - MAX_LISTED}` : shown;
}

/**
 * 同じ頁らしい組から、頁ごとの指摘と、本全体の指摘を作る。
 *
 * 頁番号を読み取れた本文の頁どうしで番号が違えば（部が分かれていれば、中身まで同じ頁で
 * なければ、部が違っても）、別の頁とする（同じ形の頁が何度も刷られている本——罫線だけのメモの頁、部ごとに同じ
 * 番号の扉など——で、指摘しないため）。前後から
 * 補った番号と、手で入れた番号は当てにしない（ファイルごとに入れた先頭の番号は、
 * 同じ束を 2 度スキャンしたファイルにも別の番号を振る。頁ごとに入れた番号も、
 * 指摘を消すために 2 度目のスキャンへ入れたものかもしれない）。
 *
 * @param {ReturnType<import('./ordering.js').arrangeBook>['order']} order
 * @param {{a:string, b:string, exact:boolean}[]} pairs
 * @param {(entry:object) => string} describe 頁の呼び方（「「猫.pdf」の 3 頁目」など）
 * @returns {{issues:Map<string, {kind:string, level:'error'|'warn', message:string}[]>, problem:object|null}}
 */
export function duplicateIssues(order, pairs, describe) {
  const entries = new Map(order.map((entry, position) => [entry.pageKey, { entry, position }]));
  // 中身まで同じ頁（exact）は、部が違っても同じ頁（同じ束を 2 度入れて、部の始まりと見られたとき）。
  const readNumber = ({ entry }, exact) => {
    if (entry.role !== 'body' || entry.status !== 'detected') return null;
    // 前の段（部・編などの番号）の違う頁は、番号が同じでも別の頁。中身まで同じ頁は、番号が戻った
    // ところで分けたまとまり（6/）が違っても同じ頁（同じ束を 2 度入れて、分けたまとまりと見られた）。
    const number = pageNumberText({ prefix: entry.prefix, number: entry.number });
    return exact ? number : `${entry.part ?? 0}:${number}`;
  };
  const issues = new Map();
  const groups = new Map(); // 頁 → 同じ頁らしい頁の集まり（並びの順）
  let exactPairs = 0;
  for (const pair of pairs) {
    const a = entries.get(pair.a);
    const b = entries.get(pair.b);
    if (!a || !b) continue; // 結合しない頁
    const na = readNumber(a, pair.exact);
    const nb = readNumber(b, pair.exact);
    if (na !== null && nb !== null && na !== nb) continue;
    if (pair.exact) exactPairs++;
    for (const [self, other] of [
      [a, b],
      [b, a],
    ]) {
      if (!issues.has(self.entry.pageKey)) issues.set(self.entry.pageKey, []);
      issues.get(self.entry.pageKey).push({ other, exact: pair.exact });
    }
    const group = new Set([...(groups.get(pair.a) ?? [pair.a]), ...(groups.get(pair.b) ?? [pair.b])]);
    for (const key of group) groups.set(key, group);
  }

  const result = new Map();
  for (const [key, list] of issues) {
    list.sort((x, y) => x.other.position - y.other.position);
    const exact = list.some((item) => item.exact);
    const others = listed(list.map((item) => describe(item.other.entry)), '・');
    result.set(key, [
      {
        kind: 'same-page',
        level: exact ? 'error' : 'warn',
        message: exact ? `${others}と同じ頁です` : `${others}と同じ内容のようです（同じ頁を 2 度スキャンした？）`,
      },
    ]);
  }

  const distinct = new Set(groups.values());
  if (distinct.size === 0) return { issues: result, problem: null };
  const keys = [...distinct]
    .map((group) => [...group].sort((x, y) => entries.get(x).position - entries.get(y).position))
    .sort((x, y) => entries.get(x[0]).position - entries.get(y[0]).position);
  return {
    issues: result,
    problem: {
      level: exactPairs ? 'error' : 'warn',
      kind: 'same-page',
      message:
        `同じ内容の頁が ${distinct.size} 組あります（${listed(
          keys.map((group) => listed(group.map((key) => describe(entries.get(key).entry)), 'と')),
          '、'
        )}）。` +
        '同じ頁を 2 度スキャンしていないか、同じ頁を含むファイルを 2 度足していないか確かめてください。',
      pageKeys: keys.map((group) => group[group.length - 1]),
    },
  };
}
