// 選んだファイルを 1 冊の並びにし、並びの抜け・重なりを確かめる。
//
// ファイルごとに、結合した PDF の中での配置を決める。
//
//   body    頁番号で並べる。番号が 1 つも決まらないファイルは、一覧の位置で
//           置く（一覧で本文のファイルより上なら先頭、下なら末尾）
//   split   前半を先頭・後半を末尾に置く（表紙と裏表紙を 1 回でスキャンしたとき）
//   exclude 結合しない
//
// 本文の頁の番号は page-numbers.js が、部（番号の振り直し）は parts.js が
// 決め、ここでは並べて確かめるだけにする。手で直した番号（頁ごと・ファイル
// ごと）は、読み取った番号より優先する。
// 頁ごとに直した番号は確かなものとして、同じファイルの残りの頁の番号を推定し直す。
// 枝番の頁（57-1, 57-2, …）は、同じ番号の頁（57）のあと、次の番号（58）の前に並べる。
// ハイフンで区切った頁番号のどの段が頁番号か（2-21 は 2 頁の枝番か、第 2 部の 21 頁か）は、
// 本ごとに選ぶ（bookDepth。page-numbers.js の chooseDepth）。前の段（部・編などの番号）は
// 部として、刷られたとおりの順に並べる。

import {
  chooseDepth,
  comparePaths,
  inferFileNumbers,
  interpret,
  manualFileNumbers,
  pageNumberText,
  pathText,
  prefixKey,
  sideOf,
  STEPS,
  STRONG_SCORE,
} from './page-numbers.js';
import { assignParts } from './parts.js';

export const ROLES = {
  body: '頁番号で並べる（番号が無ければ一覧の位置で）',
  split: '前半を先頭・後半を末尾（表紙と裏表紙）',
  exclude: '結合しない',
};

/** 配置の短い名前（記録に出す）。 */
export const ROLE_NAMES = { body: '本文', split: '表紙と裏表紙', exclude: '結合しない' };

const BOTH_NAME = /表紙.*裏表紙|表裏|表紙.*表[4４]|cover.*back(?!up|ground|log)/i;
const BACK_NAME = /裏表紙|表[4４]|back[\s_-]*cover|ura[\s_-]*byoshi/i;
const FRONT_NAME = /表紙|表[1１]|cover|カバー|hyoshi/i;
// 表紙と関係の無い英単語（discover・recover・uncover、covered・covering・coverage・
// covery・coverable）。名前から先に取り除いてから、cover を探す（StoreCover・CoverYellow のように、
// 別の語と続いているものは残す）。後読み（(?<!…)）は iOS 16.3 以前の Safari が読めない
// ので使わない。
const NOT_COVER_START = /([A-Za-z]?)(dis|re|un)(cover)/gi;
// 動詞の cover の語形（covered・covering・coverage・coverable・unrecoverable・covery）。
// covers・coverpage・coverback のような表紙の言い方は残す。
const NOT_COVER_END = /[Cc]over(?:ed|ing|age|able|y)(?![a-z])|COVER(?:ED|ING|AGE|ABLE|Y)(?![A-Z])/g;

/**
 * discover・recover・uncover（とその大文字だけの書き方）を取り除く。語の始まりにあり、
 * Recover・recover のように 1 語として書かれたものだけ（StoreCover・STORECOVER・
 * STOREcover は別の語として残す）。
 */
function dropNotCover(name) {
  // 別表・図表・付表の「表 1」は、表紙の「表 1」（表 1・表 4）ではない。
  return name
    .replace(/[別図付附]表/g, '')
    .replace(NOT_COVER_START, (word, before, prefix, cover) => {
      // 語の始まり: 前に英字が無いか、AutoRecover のように大文字から始まる。cover は小文字で
      // 続くもの（StoreCover は別の語）か、RECOVER のようにすべて大文字で語の始まりにあるもの
      // （STORECOVER は別の語）。
      const starts = !before || /[A-Z]/.test(prefix[0]);
      const caps = prefix + cover === (prefix + cover).toUpperCase() && !/[A-Z]/.test(before);
      const lower = cover === 'cover' && prefix.slice(1) === prefix.slice(1).toLowerCase();
      const oneWord = lower || caps;
      return starts && oneWord ? before : word;
    })
    .replace(NOT_COVER_END, '');
}

/**
 * ファイル名から分かる置き場所（表紙・裏表紙）。手掛かりが無ければ null。
 *
 * 一覧の並べ替えで、表紙と分かるものを上、裏表紙と分かるものを下に寄せる
 * （漢字の名前は文字コードの順に並ぶので、名前順だと「本文」「表紙」「裏表紙」の
 * 順になってしまう）。名前で表紙と分かるファイルは、頁番号を画像から読む
 * 手間も掛けない。
 *
 * @param {string} name ファイル名
 * @returns {'split'|'front'|'back'|null}
 */
export function roleFromName(name) {
  const text = dropNotCover(name);
  if (BOTH_NAME.test(text)) return 'split';
  if (BACK_NAME.test(text)) return 'back';
  if (FRONT_NAME.test(text)) return 'front';
  return null;
}

/** 名前で表紙・裏表紙と分かるか（「表紙と裏表紙」も）。 */
export function isCoverName(name) {
  return roleFromName(name) !== null;
}

/**
 * 一覧の並べ替えでの、名前による寄せ方（0: 上へ、1: そのまま、2: 下へ）。表紙と
 * 分かるもの（「表紙と裏表紙」も）を上、裏表紙と分かるものを下に寄せる。
 */
export function nameRank(name) {
  return { split: 0, front: 0, back: 2 }[roleFromName(name)] ?? 1;
}

/**
 * ファイルの配置の初期値を決める（頁番号を読み終えてから）。
 *
 * ファイル名に「表紙と裏表紙」とあるか、名前に手掛かりが無く、頁番号も 1 つも
 * 読めない数頁だけのファイルは、表紙と裏表紙として扱う（本文の束なら、どこかの
 * 頁で番号が読めるはずなので）。そのほかは本文（番号が無ければ一覧の位置で
 * 置く）。決め打ちが外れても画面で配置を選び直せる。
 *
 * @param {string} name ファイル名
 * @param {{candidates:object[]}[]} pages
 */
export function guessRole(name, pages) {
  const named = roleFromName(name);
  if (pages.length < 2) return 'body';
  if (named === 'split') return 'split';
  const numbered = pages.filter((page) => page.candidates.length > 0).length;
  if (!named && numbered === 0 && pages.length <= 4) return 'split';
  return 'body';
}

/**
 * 本文のファイルごとに、頁の番号を決める。
 *
 * 番号が 1 つしか読めず歩幅を決められないファイルは、他の本文のファイルで
 * いちばん多い歩幅を借りる（奇数頁の束が何回かに分かれていれば、どれも同じ
 * 歩幅のはずなので）。
 *
 * 頁ごとに手で入れた番号（overrides）は確かなものとして推定に入れ、残りの頁は
 * そこから歩幅に沿って決め直す（読み取りがうまくいかなかった束でも、何頁か
 * 直せば並ぶように）。ファイルごとに番号を入れた（manual）ファイルは、その番号の
 * まま（頁ごとの番号は arrangeBook で上書きする）。
 *
 * @param {{key:string, role:string, manual:?{start:number,step:number,prefix?:number[]},
 *          pages:{key:string, candidates:object[]}[]}[]} files
 * @param {Map<string, {path:number[]}>} [overrides] 頁ごとに手で決めた番号（parsePageNumber の形）
 * @param {number} [depth] ハイフンで区切った頁番号の階層（本全体で 1 つ。bookDepth）
 * @returns {Map<string, ReturnType<typeof inferFileNumbers>>}
 */
export function numberFiles(files, overrides = new Map(), depth = 0) {
  const result = new Map();
  const body = files.filter((file) => file.role === 'body');
  const infer = (file, step) =>
    inferFileNumbers(byName(file) ? file.pages.map(() => []) : file.pages.map((page) => page.candidates), {
      step,
      depth,
      fixed: file.pages.map((page) => overrides.get(page.key)),
    });
  for (const file of body) {
    result.set(file.key, file.manual ? manualNumbers(file, infer, overrides, depth) : infer(file));
  }

  const weights = new Map(STEPS.map((step) => [step, 0]));
  for (const numbering of result.values()) {
    if (numbering.step === null) continue;
    const known = numbering.pages.filter((page) => page.number !== null).length;
    weights.set(numbering.step, weights.get(numbering.step) + known);
  }
  let prior = null;
  for (const [step, weight] of weights) {
    if (weight > 0 && (prior === null || weight > weights.get(prior))) prior = step;
  }

  if (prior !== null) {
    for (const file of body) {
      // 名前で表紙と見たファイルも、頁ごとに番号を入れたなら、残りの頁はその番号から推定する。
      const fixed = file.pages.some((page) => overrides.has(page.key));
      if (file.manual || (byName(file) && !fixed) || result.get(file.key).step !== null) continue;
      result.set(file.key, infer(file, prior));
    }
  }
  if (depth > 0) frontMatter(body, result);
  return result;
}

/** 階層を選ぶのに使う、ファイルの頁の候補と手で入れた番号。 */
function dataOf(file, overrides) {
  return {
    candidates: file.pages.map((page) => page.candidates),
    fixed: file.pages.map((page) => overrides.get(page.key) ?? null),
  };
}

/**
 * 最初の部の前の頁（目次・前書きなど）を、1 つ前の部の頁にする（「1-」の部の前なら「0-1」
 * 「0-2」…）。ファイルの中で、前の段のある最初の頁番号（1 以上）より前にあるのは、
 *
 *   - 前の段の無い番号の頁（目次に刷られた 1, 2, 3 …）と、
 *   - その部の 0 以下の番号に推定した頁（番号の無い頁を、部の 1 頁から逆に数えたもの）
 *
 * で、そのうち刷られた番号の頁があるとき（どの部の前でも）か、その部が本の最初の部で「1-」の
 * 部のとき（第 2 部から始まる本の、2-1 の前の番号の無い頁は第 2 部の扉かもしれないので変えない）。
 * ただし 1 つ前の部が本の中にあれば変えない（第 6 部の巻の前書きを、第 5 部の頁と重ねない）。
 * 番号は刷られたものを使い、無い頁はそこから歩幅で数える（刷られた番号が無ければ 1 から）。
 * 2 部目からの部の扉（番号の無い頁）は、その部の 0 以下の番号のまま（部の頭に置く）。
 */
function frontMatter(files, numberings) {
  const prefixes = [...numberings.values()].flatMap((numbering) =>
    numbering.pages.flatMap((page) => (page.prefix ? [page.prefix] : []))
  );
  const used = new Set(prefixes.map(prefixKey));
  const first = prefixes.sort(comparePaths)[0];
  for (const file of files) {
    const { step, pages } = numberings.get(file.key);
    const order = pages.map((_, index) => index);
    if (step < 0) order.reverse();
    const at = order.findIndex((index) => pages[index].prefix && pages[index].number >= 1);
    if (at <= 0) continue;
    const { prefix } = pages[order[at]];
    const run = order.slice(0, at).map((index) => pages[index]);
    const plain = run.findIndex((page) => page.number !== null && !page.prefix);
    // run の頁は、前の段が無いか、0 以下の番号（前の段のある最初の 1 以上の頁より前なので）。
    if (plain < 0 && (comparePaths(prefix, first) !== 0 || prefix.at(-1) !== 1)) continue;
    const previous = [...prefix.slice(0, -1), prefix.at(-1) - 1];
    if (used.has(prefixKey(previous))) continue;
    const stride = Math.abs(step ?? 1);
    const start = plain < 0 ? (stride === 2 && pages[order[at]].number % 2 === 0 ? 2 : 1) : run[plain].number - stride * plain;
    run.forEach((page, i) => {
      if (page.number === null || page.prefix || plain < 0) page.number = start + stride * i;
      page.prefix = previous;
      // 部の切れ目で決めきれなかった頁も、前付けとして数えたので推定した番号にする。
      if (page.status === 'uncertain') page.status = 'inferred';
    });
  }
}

/**
 * 名前で表紙と見たファイル（coverByName）は、番号を手で入れない限り番号を見ない
 * （余白に刷られた巻数などを頁番号と取り違えず、ほかの束の歩幅も狂わせない）。
 */
function byName(file) {
  return file.coverByName && !file.manual;
}

/**
 * 番号を手で決めたファイル（先頭の番号と進み方）の頁の番号。頁ごとに入れた番号は、
 * その頁だけを変える。前の段（部・編などの番号）を入れなければ、読み取った番号の前の段を使う。
 * 前の段は、本を部・編などの番号の付いた頁番号と読むとき（階層 1 以上）だけ付ける（枝番と
 * 読み直したら、入れた前の段は使わない）。
 */
function manualNumbers(file, infer, overrides, depth) {
  const { start, step } = file.manual;
  const prefix =
    depth > 0 ? (file.manual.prefix ?? infer(file).pages.find((page) => page.prefix)?.prefix ?? null) : null;
  const numbering = manualFileNumbers(file.pages.length, start, step, prefix);
  file.pages.forEach((page, index) => {
    const manual = overrides.get(page.key);
    if (!manual) return;
    const { value, branch, prefix: printed } = interpret(manual.path, depth);
    const own = printed ?? prefix;
    numbering.pages[index] = {
      number: value,
      ...(branch ? { branch } : {}),
      ...(own ? { prefix: own } : {}),
      status: 'manual',
      read: null,
      // 部（parts.js）は、ファイルごとに入れた番号で決める（その頁だけの番号で部を切らない）。
      base: numbering.pages[index],
    };
  });
  return numbering;
}

/**
 * 本のハイフンで区切った頁番号の階層（page-numbers.js の chooseDepth）を、本文のファイルの
 * 頁の候補と手で入れた番号から選ぶ。ファイルごとに番号を入れたファイル、名前で表紙と
 * 見て番号を見ないファイル、ハイフンで区切った番号の無いファイルは数えない。
 * ハイフンで区切った番号の無いファイル（1, 2, 3 … とだけ刷った巻）を数えると、どの階層でも
 * 段の足りない番号ばかりになって、部の番号を付けた束まで枝番と読んでしまうため。
 *
 * @param {{key:string, role:string, manual:?object, coverByName?:boolean,
 *          pages:{key:string, candidates:object[]}[]}[]} files
 * @param {Map<string, {path:number[]}>} [overrides]
 * @returns {{depth:number, scores:number[]}}
 */
export function bookDepth(files, overrides = new Map()) {
  return chooseDepth(
    files
      .filter((file) => file.role === 'body' && !file.manual && !byName(file) && hasDashedNumbers([file], overrides))
      .map((file) => dataOf(file, overrides))
  );
}

/**
 * ハイフンで区切った番号が本の中にあるか（階層を選ぶ欄を出すかどうか）。番号だけの行の
 * 候補と、手で入れた番号を見る。
 *
 * @param {{pages:{key:string, candidates:object[]}[]}[]} files
 * @param {Map<string, {path:number[]}>} [overrides]
 */
export function hasDashedNumbers(files, overrides = new Map()) {
  return files.some((file) =>
    file.pages.some(
      (page) =>
        page.candidates.some((c) => c.path.length > 1 && c.score >= STRONG_SCORE) ||
        (overrides.get(page.key)?.path.length ?? 0) > 1
    )
  );
}

// 頁番号の無いファイルのうち、これより頁の多いものは本文の束かもしれないので、表紙と
// せず（番号なし）、知らせる（表紙と裏表紙・帯・口絵などは数頁）。
const LISTED_PAGES = 4;

// 並べたときに同じ番号が並んだら、確かなものを先に置く。
const STATUS_RANK = { manual: 0, detected: 0, inferred: 1, conflict: 1, uncertain: 2, unknown: 3, unplaced: 3 };

/**
 * 番号が 1 つでも決まったファイルか（手で入れた番号も含む。名前で表紙と見たファイルは、
 * numberFiles が番号を見ないので、手で入れない限り決まらない）。
 */
function isNumbered(file, numberings, overrides) {
  if (file.role !== 'body') return false;
  // 頁ごとに手で番号を入れた頁があれば、番号で並べる（入れていない頁は番号不明）。
  if (file.pages.some((page) => overrideOf(overrides, page) !== null)) return true;
  return numberings.get(file.key).pages.some((page) => page.number !== null);
}

/**
 * 名前で表紙と見たファイルが本文の束かもしれないとき、印を付ける頁を選ぶ関数を返す
 * （本文の束らしくなければ null）。表紙にしては頁が多ければすべての頁、違う番号が 2 頁以上に
 * あれば番号のある頁。
 *
 * @param {{pages:object[]}} file
 */
function suspectBody(file) {
  if (file.pages.length > COVER_PAGES) return () => true;
  const values = new Set(
    file.pages
      .map(strongCandidate)
      .filter(Boolean)
      .map((c) => pathText(c.path))
  );
  return values.size >= 2 ? strongCandidate : null;
}

/** 頁の、番号だけの行の候補（無ければ undefined）。 */
function strongCandidate(page) {
  return page.candidates.find((c) => c.score >= STRONG_SCORE);
}

// 名前で表紙と見たファイルで、これより頁が多ければ本文の束かもしれない。名前の無い
// ファイル（LISTED_PAGES）より多めに見る（表紙・袖・帯・見返しなどを 1 つにしたもの）。
const COVER_PAGES = LISTED_PAGES * 2;

/** 頁ごとに手で入れた番号（{path}。入れていなければ null）。 */
function overrideOf(overrides, page) {
  return overrides.get(page.key) ?? null;
}

/**
 * ファイルごとの置き場所。
 *
 *   numbered 頁番号で並べる
 *   front    番号が無く、一覧で本文のファイルより上（本文が無ければ、すべてここ）
 *   back     番号が無く、一覧で本文のファイルより下
 *   between  番号が無く、一覧で本文のファイルの間（置き場所を決められない）
 *   split    前半を先頭・後半を末尾（本文が無ければ front と同じく一覧の順に）
 *   exclude  結合しない
 *
 * @param {{key:string, role:string}[]} files 一覧の順
 * @param {Map<string, object>} numberings numberFiles の結果
 * @param {Map<string, {path:number[]}>} [overrides] 頁ごとに手で決めた番号
 * @returns {Map<string, 'numbered'|'front'|'back'|'between'|'split'|'exclude'>}
 */
export function placeFiles(files, numberings, overrides = new Map()) {
  const numbered = files.map((file) => isNumbered(file, numberings, overrides));
  const first = numbered.indexOf(true);
  const last = numbered.lastIndexOf(true);
  return new Map(
    files.map((file, index) => {
      if (file.role === 'exclude') return [file.key, 'exclude'];
      if (file.role === 'split') return [file.key, first < 0 ? 'front' : 'split'];
      if (numbered[index]) return [file.key, 'numbered'];
      return [file.key, first < 0 || index < first ? 'front' : index > last ? 'back' : 'between'];
    })
  );
}

/**
 * 1 冊の並びを作る。
 *
 * 番号の付いた頁は、部（parts.js）・番号の順に並べる。番号の無いファイル
 * （と、表紙と裏表紙のファイル）の頁は、一覧の順に先頭・末尾へ置く（状態は、
 * 表紙と分かるもの＝表紙と裏表紙のファイル・名前で表紙と分かるファイルが
 * cover、ほかは listed）。逆順の
 * ファイル（給紙の都合で最後の頁から並んだもの）は、最後の頁から置く。本文の
 * ファイルの間にある番号の無いファイルは、置き場所を決められないので、本文の
 * 最後に置いて指摘する（目立つところへ）。
 *
 * @param {{key:string, role:string, coverStep?:1|-1, coverByName?:boolean, pages:object[]}[]} files 一覧の順
 * @param {Map<string, object>} numberings numberFiles の結果
 * @param {Map<string, {path:number[]}>} overrides 頁ごとに手で決めた番号
 *   （頁の key → 番号。page-numbers.js の parsePageNumber で読んだもの。番号を置き場所の
 *   手掛かりにする。番号そのものは numberings に入っている）
 * @returns {{
 *   order: {
 *     fileKey:string, pageIndex:number, pageKey:string, role:'front'|'body'|'back',
 *     number:number|null, branch?:number[], prefix?:number[], status:string, read:object|null,
 *     part:number|null, partLabel?:string,
 *   }[],
 *   mismatch: boolean,
 *   places: ReturnType<typeof placeFiles>,
 * }}
 *   branch は枝番、prefix は前の段（部・編などの番号）で、あるときだけ。part は何部目か
 *   （0 から。部が 1 つなら null）。partLabel は部の呼び名（「第 2 部」「「5-」の後」。刷られた
 *   前の段で分かる部には付けない）。section は、前の段の無い頁を前後の部から置いた部の頁。
 *   mismatch は、番号の振り直しが束の種類（奇数頁・偶数頁）ごとに揃わず、部に分けるのを
 *   やめたとき。
 */
export function arrangeBook(files, numberings, overrides = new Map()) {
  const places = placeFiles(files, numberings, overrides);
  const numbered = files.filter((file) => places.get(file.key) === 'numbered');
  // 部は、頁ごとに手で直した番号も入れて推定した番号（numberFiles）で決める（読み違えた
  // 1 頁を直せば、そこで部を切らない）。
  const parts = assignParts(numbered, numberings);
  const front = [];
  const body = [];
  const back = [];
  // pageIndex はファイルの中の位置（逆順に置いた頁も、結合で引くのは元の頁）。
  const entry = (file, page, index, role, extra = {}) => ({
    fileKey: file.key,
    pageIndex: index,
    pageKey: page.key,
    role,
    number: null,
    status: role === 'body' ? 'unknown' : 'cover',
    read: null,
    part: null,
    ...extra,
  });

  files.forEach((file, fileOrder) => {
    const place = places.get(file.key);
    if (place === 'exclude') return;
    if (place !== 'numbered') {
      // 名前で表紙と見て番号を見なかったのに、本文の束かもしれないファイル（名前に cover を
      // 含む本文の束など）。表紙にしては頁が多い（画像だけの PDF は名前で表紙と見ると余白を
      // 読まないので、番号では分からない）か、違う番号の、頁番号らしい番号（番号だけの行）が
      // 2 頁以上にある（同じ巻数が表と裏にあるだけの表紙は除く）。その頁に印を付けて知らせる。
      const suspect = file.role === 'body' && file.coverByName ? suspectBody(file) : null;
      const pages = file.pages.map((page, index) => ({ page, index }));
      if (file.coverStep === -1) pages.reverse();
      const half = place === 'split' ? Math.ceil(pages.length / 2) : 0;
      pages.forEach(({ page, index }, i) => {
        const byName = Boolean(suspect?.(page));
        if (place === 'between') {
          body.push(entry(file, page, index, 'body', { status: 'unplaced', byName, fileOrder, seq: body.length }));
        } else {
          // 本文があれば、表紙と分かるもの・数頁だけのもの（表紙・帯・口絵など）は表紙、
          // 頁の多いもの（付録・番号を読めなかった本文の束など）は番号なし。本文が無ければ、
          // 一覧の順につなぐだけの頁（番号なし）。
          const cover = file.role === 'split' || file.coverByName || file.pages.length <= LISTED_PAGES;
          const status = numbered.length && cover ? 'cover' : 'listed';
          const role = place === 'front' || (place === 'split' && i < half) ? 'front' : 'back';
          (role === 'front' ? front : back).push(entry(file, page, index, role, { status, byName }));
        }
      });
      return;
    }
    const numbering = numberings.get(file.key);
    file.pages.forEach((page, index) => {
      const { number, branch, prefix, status, read } = numbering.pages[index];
      const part = parts.count > 1 ? parts.partOf.get(page.key) : null;
      const partLabel = part === null ? '' : parts.names[part];
      body.push(
        entry(file, page, index, 'body', {
          number,
          ...(branch ? { branch } : {}),
          ...(prefix ? { prefix } : {}),
          // 前後の部から置き場所を決められなかった、前の段の無い頁（parts.js の placeSections）。
          status: parts.unplaced.has(page.key) ? 'unplaced' : status,
          read,
          part,
          ...(partLabel ? { partLabel } : {}),
          ...(parts.sections.has(part) ? { section: true } : {}),
          fileOrder,
          seq: body.length,
        })
      );
    });
  });

  body.sort((a, b) => {
    // 番号の決まらない頁は本文の最後に（並べようが無いので、目立つところへ）。
    if (a.number === null || b.number === null) {
      if (a.number !== b.number) return a.number === null ? 1 : -1;
    } else if (a.part !== b.part) {
      return a.part - b.part;
    } else if (a.number !== b.number) {
      return a.number - b.number;
    }
    return (
      comparePaths(a.branch ?? [], b.branch ?? []) ||
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      a.fileOrder - b.fileOrder ||
      a.seq - b.seq
    );
  });
  for (const item of body) {
    delete item.fileOrder;
    delete item.seq;
  }
  return { order: [...front, ...body, ...back], mismatch: parts.mismatch, places };
}

/**
 * 並びを確かめる（抜け・重なり・番号の決まらない頁）。
 *
 * 抜け・重なりは部ごとに見る。片面ずつの束（歩幅 ±2）を組み合わせたときは、
 * 紙 1 枚の表と裏が揃っているかも見る。本は表（奇数頁）から始まるので、最初の
 * 頁が偶数ならその表が、最後の頁が奇数ならその裏が無い（白紙でも、スキャン
 * していれば番号が補われてここに並ぶはず）。
 *
 * 本文（番号の付いた頁）が無ければ、一覧の順につなぐだけなので並びは見ない（名前で表紙と
 * 見たファイルが本文の束かもしれないことは、本文が無くても知らせる。その束が唯一の本文の
 * こともあるので）。
 *
 * @param {ReturnType<typeof arrangeBook>['order']} order
 * @param {{sheets?:boolean, mismatch?:boolean, depth?:number}} [options]
 *   sheets: 片面ずつの束を組み合わせたか。mismatch: arrangeBook の mismatch。
 *   depth: ハイフンで区切った頁番号の階層（1 以上なら、前の段を部・編などの番号と読んだことを知らせる）
 * @returns {{level:'error'|'warn'|'info', kind:string, message:string, pageKeys:string[], number?:number|string, numbers?:number[]}[]}
 *   number: 同じ種類の指摘が番号ごと・部ごとに出るときの、それを見分けるもの（重なり、枝番の
 *   頁の抜け・差し替えの番号。部が分かれていれば「部:番号」、番号の無い指摘は部）。
 *   numbers: 抜けている番号（枝番でない頁の抜け）
 */
export function checkSequence(order, { sheets = false, mismatch = false, depth = 0 } = {}) {
  const problems = [];
  if (order.length === 0) {
    problems.push({
      level: 'error',
      kind: 'no-pages',
      message: '結合する頁がありません。ファイルの配置を確かめてください。',
      pageKeys: [],
    });
  }
  const body = order.filter((item) => item.role === 'body');

  const unknown = body.filter((item) => item.status === 'unknown');
  if (unknown.length) {
    problems.push({
      level: 'error',
      kind: 'unknown',
      message: `頁番号を決められない頁が ${unknown.length} 頁あります（本文の最後に並べてあります）。ファイルの「先頭の頁の番号」を入れるか、頁ごとに番号を直してください。`,
      pageKeys: unknown.map((item) => item.pageKey),
    });
  }
  const unplaced = body.filter((item) => item.status === 'unplaced' && item.number === null);
  if (unplaced.length) {
    problems.push({
      level: 'error',
      kind: 'unplaced',
      message: `頁番号の無いファイルが本文のファイルの間にあり、置き場所を決められない頁が ${unplaced.length} 頁あります（本文の最後に並べてあります）。一覧で本文のファイルより上（先頭に置く）か下（末尾に置く）へ動かすか、ファイルの「先頭の頁の番号」を入れてください。`,
      pageKeys: unplaced.map((item) => item.pageKey),
    });
  }

  // 前の段の無い頁で、前後の部から置き場所を決められなかったもの（前に「3-」、後ろに「2-」が
  // あるなど。束が一覧で入れ替わっているか、部をまたいで逆順に並んでいる）。
  const sectionless = body.filter((item) => item.status === 'unplaced' && item.number !== null);
  if (sectionless.length) {
    problems.push({
      level: 'error',
      kind: 'section-unplaced',
      message: `部・編などの番号の無い頁が ${sectionless.length} 頁あり、一覧で前後にある部の並びが食い違うので、置き場所を決められません（本文の最後に「置き場所不明」として並べてあります）。一覧で前後の部の束のあいだへ動かすか、この部分は別に結合してください。部の中の頁なら、どれか 1 頁の番号を「2-21」の形で直してください。`,
      pageKeys: sectionless.map((item) => item.pageKey),
    });
  }

  // 部ごとの、番号の決まった頁（並びの順）。間に挟んだ頁（12.5）は並びを確かめない。
  const parts = new Map();
  for (const item of body) {
    if (!Number.isInteger(item.number)) continue;
    const part = item.part ?? 0;
    if (!parts.has(part)) parts.set(part, []);
    parts.get(part).push(item);
  }
  const several = parts.size > 1;
  const ranges = [];
  let renumbered = false;
  for (const part of [...parts.keys()].sort((a, b) => a - b)) {
    const numbered = parts.get(part);
    // 部の頁は、どれも同じ前の段（部・編などの番号）を持つ。
    const { partLabel = '', prefix = null, section = false } = numbered[0];
    // 振り直しを推定して分けた部（前の段の無い頁を置いた部は数えない）。
    renumbered ||= Boolean(partLabel) && !section;
    const label = partLabel ? `${partLabel}の ` : '';
    const head = prefix ? `${pathText(prefix)}-` : '';
    // 確認の画面の項目を見分けるもの（部が分かれていれば部も入れる）。
    const tag = (number) => {
      if (!several) return number === undefined ? {} : { number };
      return { number: number === undefined ? `${part}` : `${part}:${number}` };
    };

    // 番号（枝番の頁は 57-1、前の段のある頁は 2-21 の形）ごとの頁。
    const byNumber = new Map();
    for (const item of numbered) {
      const key = pageNumberText(item);
      if (!byNumber.has(key)) byNumber.set(key, []);
      byNumber.get(key).push(item);
    }
    for (const [number, items] of byNumber) {
      if (items.length < 2) continue;
      problems.push({
        level: 'error',
        kind: 'duplicate',
        message: `${label}${number} 頁が ${items.length} 回あります（同じ束を 2 度スキャンした・番号の読み違い）。`,
        pageKeys: items.map((item) => item.pageKey),
        ...tag(number),
      });
    }

    const { plain, branches, replaced, gaps } = branchLayout(numbered);
    const numbers = [...new Set(numbered.map((item) => item.number))].sort((a, b) => a - b);
    const lowest = numbers[0];
    const highest = numbers[numbers.length - 1];
    ranges.push(`${partLabel ? `${partLabel} ` : ''}${head}${lowest}〜${head}${highest} 頁`);
    const missing = [];
    for (let n = lowest; n <= highest; n++) {
      if (!plain.has(n) && !replaced.has(n)) missing.push(n);
    }
    if (missing.length) {
      problems.push({
        level: 'error',
        kind: 'missing',
        message: `${label}${compressRanges(missing, head)} 頁が見つかりません（計 ${missing.length} 頁）。束の入れ忘れ・重送の可能性があります。`,
        pageKeys: [],
        numbers: missing,
        ...tag(),
      });
    }

    for (const [number, present] of branches) {
      const absent = gaps.get(number) ?? [];
      if (absent.length) {
        problems.push({
          level: 'error',
          kind: 'missing',
          message: `${label}${absent.map((path) => `${head}${pathText(path)}`).join('・')} 頁が見つかりません（枝番の付いた頁）。束の入れ忘れ・重送の可能性があります。`,
          pageKeys: [],
          ...tag(number),
        });
      }
      const instead = [...replaced.entries()].filter(([n, by]) => by === number && n <= highest).map(([n]) => n);
      if (instead.length) {
        const [low, top] = [Math.min(...present), Math.max(...present)];
        const pages = low === top ? `${head}${number}-${low}` : `${head}${number}-${low}〜${head}${number}-${top}`;
        problems.push({
          level: 'info',
          kind: 'replaced',
          message: `${label}${compressRanges(instead, head)} 頁は無く、枝番の付いた頁（${pages}）があります。差し替えられた頁とみなしました。`,
          pageKeys: numbered.filter((item) => item.branch && item.number === number).map((item) => item.pageKey),
          ...tag(number),
        });
      }
    }

    if (sheets) {
      const first = numbered[0];
      const last = numbered[numbered.length - 1];
      // 同じ紙のもう一方の面（枝番の頁は、いちばん後ろの段で数える）。
      const beside = (item, delta) =>
        pageNumberText(
          item.branch
            ? { ...item, branch: [...item.branch.slice(0, -1), item.branch.at(-1) + delta] }
            : { prefix: item.prefix, number: item.number + delta }
        );
      if (sideOf(first.number, first.branch) === 'even') {
        problems.push({
          level: 'warn',
          kind: 'sheet-start',
          message: `${label}最初の頁が偶数（${pageNumberText(first)} 頁）です。その表（${beside(first, -1)} 頁）が欠けていないか確かめてください。`,
          pageKeys: byNumber.get(pageNumberText(first)).map((item) => item.pageKey),
          ...tag(),
        });
      }
      if (sideOf(last.number, last.branch) === 'odd') {
        problems.push({
          level: 'warn',
          kind: 'sheet-end',
          message: `${label}最後の頁が奇数（${pageNumberText(last)} 頁）です。その裏（${beside(last, 1)} 頁）が欠けていないか確かめてください（裏が白紙でスキャンしていない場合は問題ありません）。`,
          pageKeys: byNumber.get(pageNumberText(last)).map((item) => item.pageKey),
          ...tag(),
        });
      }
    }
  }
  if (several && renumbered) {
    problems.push({
      level: 'warn',
      kind: 'parts',
      message: `頁番号が振り直されているところで、本文を ${parts.size} 部に分けて並べました（${ranges.join('・')}）。部の分かれていない本なら、同じ束を最初から 2 度入れていないか確かめてください。頁ラベルは付けないので、ビューアーの頁番号は通し番号になります。`,
      pageKeys: [],
    });
  }
  // ハイフンで区切った頁番号の前の段を、部・編などの番号と読んだ（枝番と読み違えていないか）。
  // 例には、部の頁（前付けの「0-」の頁より、1 以上の部の頁）を挙げる。
  const candidates = depth > 0 ? body.filter((item) => item.prefix && item.number > 0 && Number.isInteger(item.number) && !item.branch) : [];
  const example = candidates.find((item) => item.prefix.at(-1) > 0) ?? candidates[0];
  if (example) {
    problems.push({
      level: 'info',
      kind: 'depth',
      message: `ハイフンで区切った頁番号（${pageNumberText(example)} など）は、前後の頁とのつながりから、「${pathText(example.prefix)}-」を部・編などの番号、${example.number} を頁番号と読み、その順に並べました${several && !renumbered ? `（${ranges.join('・')}）` : ''}。枝番の付いた頁なら、一覧の上の「ハイフンで区切った頁番号」で読み方を選び直してください。`,
      pageKeys: [],
    });
  }
  // 部・編などの番号の付いた本で、前の段の無い頁（部の番号を刷っていない巻、文字情報が前の段を
  // 落とした束など）。本の順で前後にある部から置いた（parts.js の placeSections）ことを知らせる。
  const unprefixed =
    depth > 0 && example ? body.filter((item) => item.number !== null && !item.prefix && item.status !== 'unplaced') : [];
  if (unprefixed.length) {
    const places = [...new Set(unprefixed.map((item) => item.partLabel || '前付け'))];
    problems.push({
      level: 'warn',
      kind: 'no-prefix',
      message: `部・編などの番号の無い頁が ${unprefixed.length} 頁あり、一覧で前後にある部の頁から置き場所を決めました（${places.join('・')}）。部の中の頁なら、どれか 1 頁の番号を「2-21」の形で直してください（同じファイルの残りの頁も、その部の頁になります）。`,
      pageKeys: unprefixed.map((item) => item.pageKey),
    });
  }
  if (mismatch) {
    problems.push({
      level: 'warn',
      kind: 'parts-mismatch',
      message:
        '頁番号が最初に戻る束がありますが、奇数頁の束と偶数頁の束で戻る回数が揃わないので、部には分けずに並べました。同じ束を 2 度入れていないか確かめてください。',
      pageKeys: [],
    });
  }

  const byName = order.filter((item) => item.byName);
  if (byName.length) {
    problems.push({
      level: 'warn',
      kind: 'cover-numbers',
      message: `名前から表紙・裏表紙と見て、頁番号を見ずに一覧の位置で置いたファイルが、本文の束かもしれません（頁番号らしい番号がある・表紙にしては頁が多い。${byName.length} 頁）。本文の束なら、ファイルの設定の「頁番号を読んで並べる」を押してください（表紙・口絵などなら、そのままで構いません）。`,
      pageKeys: byName.map((item) => item.pageKey),
    });
  }

  // 本文があるのに頁番号を 1 つも読めなかった大きなファイル（OCR に失敗した本文の
  // 束かもしれない）。一覧の位置で置いたことを知らせる（数頁だけのファイルは表紙として
  // 置き、状態は cover なので知らせない）。
  const listed = body.length ? order.filter((item) => item.status === 'listed') : [];
  if (listed.length) {
    problems.push({
      level: 'warn',
      kind: 'listed',
      message: `頁番号を 1 つも読めなかったファイルの ${listed.length} 頁を、一覧の位置で先頭・末尾に置きました。本文の束なら、ファイルの「先頭の頁の番号」を入れてください。`,
      pageKeys: listed.map((item) => item.pageKey),
    });
  }

  const conflicts = body.filter((item) => item.status === 'conflict');
  if (conflicts.length) {
    problems.push({
      level: 'warn',
      kind: 'conflict',
      message: `読み取った番号が前後の並びと合わない頁が ${conflicts.length} 頁あります（並びから推定した番号で並べています）。`,
      pageKeys: conflicts.map((item) => item.pageKey),
    });
  }
  const uncertain = body.filter((item) => item.status === 'uncertain');
  if (uncertain.length) {
    problems.push({
      level: 'warn',
      kind: 'uncertain',
      message: `番号の飛びの境目にあって、位置を決めきれない頁が ${uncertain.length} 頁あります。`,
      pageKeys: uncertain.map((item) => item.pageKey),
    });
  }
  return problems;
}

/**
 * [1,2,3,7,9,10] → "1〜3・7・9〜10"。head は番号の頭に付ける前の段（"2-" なら "2-1〜2-3・2-7"）。
 *
 * @param {number[]} numbers
 * @param {string} [head]
 */
export function compressRanges(numbers, head = '') {
  const parts = [];
  let start = null;
  let prev = null;
  const range = () => (start === prev ? `${head}${start}` : `${head}${start}〜${head}${prev}`);
  for (const n of [...numbers].sort((a, b) => a - b)) {
    if (start === null) {
      start = prev = n;
    } else if (n === prev + 1) {
      prev = n;
    } else {
      parts.push(range());
      start = prev = n;
    }
  }
  if (start !== null) parts.push(range());
  return parts.join('・');
}

/**
 * 結合した PDF に付ける頁ラベル（ビューアーに出る頁番号）。
 *
 * PDF の頁の数え方（1 枚目から 1, 2, 3…）と本の頁番号は、表紙や前付けの
 * 分だけずれる。頁ラベルを付けておくと、ビューアーで「17」と入れたときに
 * 本の 17 頁が開く。
 *
 *   表紙       「表紙」（複数頁なら 表紙1, 表紙2…）
 *   前付け     i, ii, iii…（番号が 0 以下に推定された頁）
 *   本文       本の頁番号（前の段のある頁は 2-21 のように「2-」を頭に付けた番号）
 *   枝番の頁   57-1, 57-2…（「57-」を頭に付けた番号）
 *   位置を決めきれない頁 「差込」
 *   裏表紙     「裏表紙」
 *   一覧の位置で置いた、表紙と分からない頁 「番号なし」
 *
 * 同じ形で番号が 1 つずつ進むところは 1 つの範囲にまとめる。本文が無い
 * （一覧の順につなぐだけの）とき・振り直しを推定して部に分けたときは付けない（ビューアーの
 * 頁番号は、結合した PDF の通し番号になる）。頁番号の前に刷られた部・編などの番号で
 * 分けた部は、ラベルの番号が重ならないので付ける。
 *
 * @param {ReturnType<typeof arrangeBook>['order']} order
 * @returns {{start:number, style:'D'|'r'|null, prefix:string, first:number}[]}
 */
export function pageLabelRanges(order) {
  if (!order.some((item) => item.role === 'body') || order.some((item) => item.partLabel)) {
    return [];
  }
  const fronts = order.filter((item) => item.role === 'front' && item.status !== 'listed').length;
  const backs = order.filter((item) => item.role === 'back' && item.status !== 'listed').length;
  let frontMatter = 0;
  let frontSeen = 0;
  let backSeen = 0;

  const labels = order.map((item) => {
    // 一覧の位置で置いた、表紙と分からない頁（付録など）。画面の見出しと同じ「番号なし」。
    if (item.status === 'listed') return { style: null, prefix: '番号なし', number: 0 };
    if (item.role === 'front') {
      frontSeen++;
      return fronts > 1 ? { style: 'D', prefix: '表紙', number: frontSeen } : { style: null, prefix: '表紙', number: 0 };
    }
    if (item.role === 'back') {
      backSeen++;
      return backs > 1 ? { style: 'D', prefix: '裏表紙', number: backSeen } : { style: null, prefix: '裏表紙', number: 0 };
    }
    if (item.number === null || !Number.isInteger(item.number)) return { style: null, prefix: '差込', number: 0 };
    const head = item.prefix ? `${pathText(item.prefix)}-` : '';
    if (item.branch) {
      return { style: 'D', prefix: `${head}${pathText([item.number, ...item.branch.slice(0, -1)])}-`, number: item.branch.at(-1) };
    }
    if (item.number <= 0) {
      frontMatter++;
      return { style: 'r', prefix: head, number: frontMatter };
    }
    return { style: 'D', prefix: head, number: item.number };
  });

  const ranges = [];
  labels.forEach((label, index) => {
    const current = ranges[ranges.length - 1];
    const continues =
      current &&
      current.style !== null &&
      current.style === label.style &&
      current.prefix === label.prefix &&
      label.number === current.first + (index - current.start);
    if (!continues) ranges.push({ start: index, style: label.style, prefix: label.prefix, first: label.number || 1 });
  });
  return ranges;
}

/** 小文字のローマ数字（頁ラベルの前付け。PDF の /r と同じ書き方）。 */
export function romanNumeral(number) {
  const table = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let rest = number;
  let text = '';
  for (const [value, letters] of table) {
    while (rest >= value) {
      text += letters;
      rest -= value;
    }
  }
  return text;
}

/**
 * 頁ラベルの範囲から、頁ごとのラベルの文字列を作る（ビューアーに出るもの）。
 *
 * 結合した PDF を読み直したときに、書き込んだとおりのラベルが付いているかを
 * 確かめるのに使う。
 *
 * @param {ReturnType<typeof pageLabelRanges>} ranges
 * @param {number} count 頁数
 */
export function pageLabelTexts(ranges, count) {
  const texts = [];
  let current = null;
  let next = 0;
  for (let index = 0; index < count; index++) {
    while (next < ranges.length && ranges[next].start <= index) current = ranges[next++];
    if (!current) {
      texts.push(String(index + 1));
      continue;
    }
    const number = current.first + (index - current.start);
    const body = current.style === 'D' ? String(number) : current.style === 'r' ? romanNumeral(number) : '';
    texts.push(`${current.prefix}${body}`);
  }
  return texts;
}

/**
 * 枝番の頁の並び方。
 *
 * 加除式の本では、元の紙（57・58 頁）を抜いて、枝番の頁（57-1〜57-4）の紙に
 * 差し替えることがある。枝番の頁がある番号（57）が無ければ差し替えられたと
 * みなし、それが奇数なら同じ紙の裏（58）も、頁が無くても抜けとはみなさない。
 * 57 があるなら、枝番の頁は差し込まれたもので、58 が無ければ抜け。
 *
 * 枝番の頁は、1 から最後の枝番まで揃っているはず（57-1 と 57-4 があれば 57-2・57-3 も）。
 * 入れ子の枝番（57-1-1）も同じで、枝番の頁（57-1）が無く、その下の枝番の頁だけがあれば、
 * 差し替えられたとみなす（奇数ならその裏の 57-2 も）。
 *
 * @param {{number:number, branch?:number[]}[]} numbered 番号の決まった本文の頁（1 つの部の中）
 * @returns {{plain:Set<number>, branches:Map<number, Set<number>>, replaced:Map<number, number>,
 *   gaps:Map<number, number[][]>, covered:Set<string>}}
 *   plain は枝番の無い頁の番号、branches は番号ごとの（1 段目の）枝番、replaced は枝番の頁に
 *   差し替えられたとみなす番号（→ 枝番の頁の番号）、gaps は番号ごとの抜けている枝番の頁
 *   （[57, 2] の形）、covered は、あるか差し替えられたとみなす枝番の頁（57-2 の形）
 */
export function branchLayout(numbered) {
  const plain = new Set();
  const branches = new Map();
  const present = new Map();
  for (const { number, branch } of numbered) {
    if (!branch) {
      plain.add(number);
      continue;
    }
    if (!branches.has(number)) branches.set(number, new Set());
    branches.get(number).add(branch[0]);
    const path = [number, ...branch];
    present.set(pathText(path), path);
  }
  const replaced = new Map();
  for (const number of branches.keys()) {
    if (plain.has(number)) continue;
    replaced.set(number, number);
    if (Math.abs(number) % 2 === 1 && !plain.has(number + 1)) replaced.set(number + 1, number);
  }

  // 枝番の段ごとに、そのすぐ上の段（57・57-1）の下にある枝番を集める。
  const children = new Map();
  const covered = new Set();
  for (const path of present.values()) {
    for (let level = 1; level < path.length; level++) {
      const parent = path.slice(0, level);
      const key = pathText(parent);
      if (!children.has(key)) children.set(key, { parent, values: new Set() });
      children.get(key).values.add(path[level]);
      covered.add(pathText(path.slice(0, level + 1)));
    }
  }
  const gaps = new Map();
  for (const { parent, values } of children.values()) {
    // 下の段の枝番の頁に差し替えられた奇数の枝番の頁（57-1）は、その裏（57-2）も差し替えられた。
    for (const value of values) {
      if (!present.has(pathText([...parent, value])) && value % 2 === 1) covered.add(pathText([...parent, value + 1]));
    }
    const top = Math.max(...values);
    for (let b = 1; b < top; b++) {
      const path = [...parent, b];
      if (covered.has(pathText(path))) continue;
      if (!gaps.has(parent[0])) gaps.set(parent[0], []);
      gaps.get(parent[0]).push(path);
    }
  }
  for (const list of gaps.values()) list.sort(comparePaths);
  return { plain, branches, replaced, gaps, covered };
}
