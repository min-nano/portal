// 結合した PDF を、いくつかのファイルに分ける（分割）。
//
// 大きすぎる PDF は、スマートフォンでは開くのも送るのも重く、取り込んで
// 検索・要約するサービスでは、後ろの方の中身が索引に入らないことがある。
// Google Workspace に置いて検索や Gemini で参照するときは、章などのまとまり
// ごとのファイルの方が、まとまった中身を保ったまま参照できる。
//
// 1 ファイルの上限（大きさ・頁数）に収まれば分けない。超えるときは、確からしい
// 区切りから順に分ける（splitByRank・breakRanks）。提案は画面で動かしたり、足したり
// 外したりできる。
//
// 分ける位置の候補（その頁の前で分ける）:
//
//   しおり       元の PDF のしおり（目次）の、いちばん上の段の項目が指す頁
//   見出し       「第 3 章」「Chapter 3」のような、大きな字の見出しのある頁
//   ファイルの境目 ファイルをそのまま続けてつないだところ（奇数頁・偶数頁の
//                束のように、ファイルが入り混じるところは境目にしない）
//
// しおり・見出しだけでは上限に収まらないときは、上限に収まる最少の数で、ファイルの
// 境目や候補の無いところでも分ける（suggestSplits）。表紙は
// 最初のファイルに、裏表紙は最後のファイルに付ける（表紙だけ・裏表紙だけの
// ファイルを作らない。先頭・末尾に置く頁が COVER_PAGES より多ければ、目次などが
// まとまっているとみなし、本文とは分けてよい）。本文が 1 頁も無いとき（頁番号の
// 無い PDF を、ファイルの一覧の順にそのままつなぐとき）は、表紙として扱わない。
//
// DOM には触らない（テストで縛るため）。

import { sanitizeFileName } from '../pdf-file-ops.js';
import { LISTED_PAGES as COVER_PAGES } from './ordering.js';
import { MARGIN_ZONE } from './page-numbers.js';

/** 分ける位置の候補の種類（画面に出す名前）。 */
export const BREAK_KINDS = {
  outline: 'しおり',
  heading: '見出し',
  file: 'ファイルの境目',
  running: '柱の変わり目',
  restart: '頁番号の戻り',
  opening: '本文の始まり',
};

/** 1 MB（分ける上限の大きさは MB で入れる）。 */
export const MEGABYTE = 1024 * 1024;

/**
 * 分ける上限の既定。大きさは 40 MB、頁数は上限なし（null）。上限を超えるときは、
 * 章などのまとまりごとのファイルに分ける（splitByRank。Google Workspace に置いて検索・
 * Gemini で参照するので）。Google Drive は約 50 MB を超える PDF の中身を検索の索引に
 * 入れないので、余裕を見て 40 MB にする。
 */
export const DEFAULT_LIMITS = { megabytes: 40, pages: null };

/**
 * 章の見出しらしい行の頭（「第 3 章」「第 十 二 章」「第Ⅱ部」「Chapter 3」
 * 「Section 2」）。字を空けて組んだ見出しは、行にまとめるときに字の間に空白が入る。
 */
const HEADING =
  /^(?:第\s*(?:[0-9一二三四五六七八九十百千〇零Ⅰ-Ⅻ]\s*)+[章部編]|(?:chapter|part|section)(?:\s*[0-9]+|\s*[Ⅰ-Ⅻ]+|\s+(?:[ivx]|(?=[ivxlc]{2})c{0,3}(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})))(?![0-9a-z]|[.．\-－][0-9]))/i;

/**
 * 目次の行の終わり（頁番号を指すもの。「P.011」「・・012」「…… 28」）。見出しの
 * 形でも、これで終わる行は目次の項目なので、見出しにしない。「Step 2」「MP3」の
 * ような語の終わりは頁番号にしない（P の前は行の頭か空白・点）。
 */
const TOC_ENTRY = /(?:(?:^|[\s・…])[pP]\.?\s*\d+|[・….．]{2,}\s*\d+)$/;

/**
 * 見出しの頭のあとの区切り（空白・コロン・句読点・括弧か、行の終わり）。字の
 * 大きさで見分けられない頁（行の少ない頁）では、これも求める（「第 3 章で
 * 述べた…」は本文の説明）。
 */
const HEADING_END = /^(?:[\s:：.．、「『（(【]|$)/;

/**
 * 見出しの頭のすぐあとの助詞（「Section 2 で示した…」の「で」）。そのあとが
 * ひらがなでなければ本文の説明とみなす（「第1章 はじめに」「のりしろ」は題）。
 */
const PARTICLE = /^\s*(?:[でのをにがとも](?![ぁ-ゖ])|では|には|とは|でも|での|への|について|から|まで|より)/;

/** 2 段の番号・括弧の番号を振った項目（「1-2 壁」「2.3 屋根」「(1) 概要」）。しおりなら節の階層。 */
const SUB_ITEM = /^\s*(?:[(（]\s*\d{1,3}\s*[)）]|\d{1,3}[-‐－.．]\d)/;

/** 1 段の番号を振った項目（「01. マウス操作」「1. はじめに」）。その番号。 */
const NUMBERED_ITEM = /^\s*(\d{1,3})\s*[.．、)）:：]/;

/**
 * しおりの題の階層を求める関数（部・章の見出しの形ならその階層、2 段の番号の項目なら
 * 節）。1 段の番号の項目（「01. …」）は、同じ番号が 2 度以上出てくれば（章ごとに 01 から
 * 振り直す——章の下の節）節、そうでなければ（「1. はじめに」「2. 方法」と本を通して振る）
 * 階層の形が無いものとする。階層の形が無ければ null（作った人が付けた区切りとして、
 * しおりの順位にする）。
 *
 * @param {string[]} titles 本のしおりの題
 */
function outlineLevels(titles) {
  const numbers = titles.map((title) => title.match(NUMBERED_ITEM)?.[1]).filter(Boolean).map(Number);
  const restarts = new Set(numbers).size < numbers.length;
  return (title) => {
    if (HEADING.test(title)) return headingRank(title);
    if (SUB_ITEM.test(title) || (restarts && NUMBERED_ITEM.test(title))) return RANKS.section;
    return null;
  };
}

/** 見出しの頭のあとの節の番号（「2.2.5」）。柱の行（章と節を並べたもの）を見分ける。 */
const RUNNING_HEAD = /^\s*\d+[.．]\d/;

/** 見出しとみなす、行の文字の高さ（頁の中の行の高さの中央値に対する倍率）。 */
const HEADING_SCALE = 1.3;

/** 番号だけの見出しに続ける題の字の大きさ（本文の字に対する倍率）。 */
const TITLE_SCALE = 1.2;

/** 見出しの行の長さの上限（本文の行の頭に「第 3 章で…」とあるのを拾わない）。 */
const HEADING_LENGTH = 40;

/**
 * 目次の項目の行の、題と頁番号（「第3 章 木造住宅バルコニー 55」「Chapter 2 Walls … 41」
 * 「第1部 総論 P.3」）。見出しの形で始まり、題のあとに空白か点を挟んで頁番号で終わる
 * （空白だけを挟むのは、題が英字で終わらないときだけ。tocEntries）。
 */
const TOC_ITEM = /^(.*?[^\s\d.．・…])([\s.．・…]+(?:[pP][.．]?\s*)?)(\d{1,4})$/;

/**
 * 頁の目次の項目（見出しの形で始まり、頁番号で終わる行）。目次の頁から、章の始まりの
 * 頁番号を読むのに使う（スキャンの OCR では、章の扉の文字は崩れやすいが、目次の行は
 * 読めていることが多い）。
 *
 * @param {{text:string}[]} lines 頁の文字を行にまとめたもの
 * @returns {{title:string, page:number}[]}
 */
export function tocEntries(lines) {
  const entries = [];
  for (const line of lines) {
    const head = line.text.match(HEADING)?.[0];
    const rest = line.text.slice(head?.length);
    // 柱（「第2 章 2.2.5(1) 棟違い 23」）と、見出しの形で始まる本文（「第3章で述べた…」）は除く。
    if (!head || RUNNING_HEAD.test(rest) || !HEADING_END.test(rest) || PARTICLE.test(rest)) continue;
    const item = rest.match(TOC_ITEM);
    // 空白だけを挟んだ数は、題が英字で終わるなら題の一部（「Step 2」）。
    if (!item || (!item[2].trim() && /[A-Za-z]$/.test(item[1]))) continue;
    entries.push({ title: `${head} ${item[1]}`.replace(/\s+/g, ' ').trim(), page: Number(item[3]) });
  }
  return entries;
}

/** 目次の頁の題（「目次」「もくじ」「CONTENTS」）。字を空けて組んだものも。 */
const TOC_TITLE = /^(?:目\s*次|も\s*く\s*じ|(?:table\s+of\s+)?contents)$/i;

/**
 * 目次の頁か。「目次」などの題の行があるか、いちばん上の階層の見出しの形の行が、
 * 違う番号で 2 つ以上並ぶ頁（「第1章」「第2章」…・「第1編」「第2編」…）。スキャンの
 * OCR では、目次の行の頁番号が別の行に分かれて、頁番号で終わる行（TOC_ENTRY）として
 * 見分けられないことがあるので、並び方でも見る。部の扉にその部の章が並ぶときは、上の
 * 階層（部）は 1 つだけなので、目次とはしない。
 *
 * @param {{text:string}[]} lines 頁の文字を行にまとめたもの
 */
export function tocPage(lines) {
  if (lines.some((line) => TOC_TITLE.test(line.text.trim()))) return true;
  // 章の名前のあとに頁番号の付いた行（目次の項目）があれば、目次（章ごとの目次の頁も）。
  if (tocEntries(lines).length) return true;
  const levels = new Map();
  for (const line of lines) {
    const head = line.text.match(HEADING)?.[0];
    // 見出しの形で始まる本文の説明（「第 2 章で述べた…」）は数えない。
    const rest = line.text.slice(head?.length);
    if (!head || !HEADING_END.test(rest) || PARTICLE.test(rest)) continue;
    const level = headingRank(line.text);
    levels.set(level, (levels.get(level) ?? new Set()).add(head.replace(/\s/g, '')));
  }
  if (!levels.size) return false;
  return levels.get(Math.min(...levels.keys())).size >= 2;
}

/**
 * 頁の文字情報から、章の見出しを探す。見つからなければ null。
 *
 * 頁の上の 6 割にあって、ほかの行（見出しの形でない行）より大きな字の行を
 * 見出しとする。柱（章の名前を載せた行）は章の途中の頁にも載るが、本文と同じ
 * くらいの字なので拾わない。行が 3 つまでしかない頁（章の扉）は、字の大きさを
 * 比べずに見出しとする（そのときは、余白の帯の中の行は見ない。柱と頁番号だけの
 * 白紙の頁を拾わないように。見出しの頭のあとが区切りで、ひらがなが続かないことも
 * 求める。「第 3 章で述べた…」「Section 2 で示した…」は本文の説明）。頁番号で
 * 終わる行（目次の項目）は見出しにしない。
 *
 * 目次の頁（tocPage）では見出しを拾わない。
 *
 * 番号だけの見出し（「Section 2」）なら、すぐ下にある大きな字の行を題として
 * 続ける（「Section 2 プレセッターの解説」）。分けたファイルの名前に添えるため。
 *
 * @param {{text:string, x0:number, x1:number, y:number, h:number}[]} lines
 *   頁の文字を行にまとめたもの（page-numbers.js の groupLines）
 * @returns {string|null}
 */
export function chapterHeading(lines) {
  // 目次の頁の行は、見出しの形でも章の始まりではない。
  if (tocPage(lines)) return null;
  const heads = lines.map((line) => line.text.match(HEADING)?.[0].length ?? 0);
  // 比べる字の大きさは、見出しの形でない行の高さの中央値（見出しが何行かあっても
  // 引きずられないように。小さい方の中央値）。
  const heights = lines
    .filter((_, k) => !heads[k])
    .map((line) => line.h)
    .sort((a, b) => a - b);
  const large = heights[Math.floor((heights.length - 1) / 2)] * HEADING_SCALE;
  const body = heights[Math.floor((heights.length - 1) / 4)];
  const few = lines.length <= 3;
  for (const [k, line] of lines.entries()) {
    if (!heads[k] || line.y > 0.6 || line.text.length > HEADING_LENGTH || TOC_ENTRY.test(line.text)) continue;
    const rest = line.text.slice(heads[k]);
    // 章のあとに節の番号が続く行（「第2 章 2.2.5(1) 棟違い」）は、本文の頁の柱。OCR で
    // 「第2 章」と「2.2.5(1) 棟違い」の 2 行に分かれたものも。
    const below = lines[k + 1];
    const split = !rest && line.y < MARGIN_ZONE && below && below.y - line.y <= line.h * 2.5 && RUNNING_HEAD.test(below.text);
    if (RUNNING_HEAD.test(rest) || split) continue;
    const found = few ? line.y >= MARGIN_ZONE && HEADING_END.test(rest) && !PARTICLE.test(rest) : line.h >= large;
    if (!found) continue;
    // 題として続けるのは、すぐ下の大きな字の短い行（見出しや本文の段落は続けない）。
    const next = lines[k + 1];
    const title =
      !rest &&
      next &&
      next.y - line.y <= line.h * 2.5 &&
      // 題の字は、本文の字より 2 割以上大きい（本文の字は、見出しの形でない行の高さの
      // 小さい方から 4 分の 1 のところ。Section 6 の扉のように項目の行が少ないと、題の
      // 字は真ん中の行と比べて大きく見えないので、本文の字と比べる）。
      (few || next.h >= body * TITLE_SCALE) &&
      next.y <= 1 - MARGIN_ZONE &&
      !HEADING.test(next.text) &&
      !PARTICLE.test(next.text) &&
      !TOC_ENTRY.test(next.text) &&
      line.text.length + 1 + next.text.length <= HEADING_LENGTH;
    return title ? `${line.text} ${next.text}` : line.text;
  }
  return null;
}

/**
 * 頁の数・大きさが上限を超えるか（1 頁だけなら、分けようが無いので超えないとする）。
 *
 * @param {number} pages
 * @param {number} bytes
 * @param {{megabytes:number|null, pages:number|null}} limits
 */
export function overLimit(pages, bytes, limits) {
  if (pages <= 1) return false;
  return Boolean((limits.pages && pages > limits.pages) || (limits.megabytes && bytes > limits.megabytes * MEGABYTE));
}

/** 本文の頁があるか（無ければ、ファイルの並びのままつなぐとき）。 */
function hasBodyPages(items) {
  return items.some((item) => item.role === 'body');
}

/**
 * 頁の位置を渡すと、その頁の前で分けると表紙だけ（裏表紙だけ）のファイルが
 * できるか（表紙と本文を別のファイルにしない）を返す関数。その前にある先頭に
 * 置く頁（そのあとの末尾に置く頁）が COVER_PAGES までなら、表紙とみなす。本文が
 * 無ければ（ファイルの並びのままつなぐとき）、表紙として扱わない。
 */
function coverGuard(items) {
  if (!hasBodyPages(items)) return () => false;
  // fronts[i]: 頁 i より前の先頭に置く頁の数。backs[i]: 頁 i から後ろの末尾に置く頁の数。
  const fronts = [0];
  for (const item of items) fronts.push(fronts.at(-1) + (item.role === 'front' ? 1 : 0));
  const backs = new Array(items.length + 1).fill(0);
  for (let i = items.length - 1; i >= 0; i--) backs[i] = backs[i + 1] + (items[i].role === 'back' ? 1 : 0);
  return (index) =>
    (items[index - 1].role === 'front' && fronts[index] <= COVER_PAGES) ||
    (items[index].role === 'back' && backs[index] <= COVER_PAGES);
}

/**
 * 並べた頁ごとに、その頁の前で分ける候補を挙げる（先頭の頁と、表紙の後ろ・
 * 裏表紙の前は null）。
 *
 * @param {{fileKey:string, fileName:string, role:string, outline?:string|null, heading?:string|null, running?:string|null, number?:number|null, toc?:string|null}[]} items
 *   並べた順の頁
 * @returns {({kind:'outline'|'heading'|'file'|'running'|'restart'|'opening', title:string, chapter?:string|null, toc?:boolean, running?:'chapter'|'section'|'text', restart?:boolean, opening?:boolean}|null)[]}
 *   ファイルの境目の頁にしおり・見出しもあれば、その名前を chapter に入れる
 */
export function breakCandidates(items) {
  const first = new Map();
  const last = new Map();
  const atCover = coverGuard(items);
  items.forEach((item, index) => {
    if (!first.has(item.fileKey)) first.set(item.fileKey, index);
    last.set(item.fileKey, index);
  });
  // 前の頁と同じ名前のしおり・見出し（スライドの頁ごとに載る「Section 1」など）は、
  // 章の始まりではないので区切りにしない。
  const titles = items.map((item) => item.outline || item.heading || null);
  const repeated = (index) => titles[index] !== null && titles[index] === titles[index - 1];
  const runs = runningBreaks(items);
  /** その頁で始まる候補（しおり・見出し・ファイルの境目）。無ければ null。 */
  const own = (item, index) => {
    // ファイルの境目を先に見る（取り込んだファイルのまとまりは、1 頁でも分けるので）。
    const previous = items[index - 1];
    if (previous.fileKey !== item.fileKey && last.get(previous.fileKey) === index - 1 && first.get(item.fileKey) === index) {
      const chapter = repeated(index) ? null : titles[index];
      return chapter ? { kind: 'file', title: item.fileName, chapter } : { kind: 'file', title: item.fileName };
    }
    if (repeated(index)) return null;
    if (item.outline) return { kind: 'outline', title: item.outline };
    if (item.heading) return { kind: 'heading', title: item.heading };
    return null;
  };
  // それぞれの頁より前で、頁番号のある最後の頁の番号（番号の無い頁を飛ばして比べる）。
  const numberBefore = [];
  let lastNumber = null;
  for (const item of items) {
    numberBefore.push(lastNumber);
    if (Number.isFinite(item.number)) lastNumber = item.number;
  }
  // 前付け（0 以下の番号）から本文（1 からの番号）に入るところ。手前に番号の無い頁（章の
  // 扉）があれば、そこ（3 頁まで。見出しのある頁で止める）から。
  // 区切りの位置 → 本文の最初の頁番号（扉まで戻ったときも、名前は本文の頁番号にする）。
  const openings = new Map();
  items.forEach((item, index) => {
    const before = numberBefore[index];
    if (!(Number.isFinite(item.number) && item.number >= 1 && before !== null && before <= 0)) return;
    let at = index;
    while (at > 1 && !Number.isFinite(items[at - 1].number) && index - at < 3) {
      at--;
      if (items[at].heading || items[at].outline) break;
    }
    openings.set(at, item.number);
  });
  const candidates = items.map((item, index) => {
    if (index === 0 || atCover(index)) return null;
    // 区切りらしさを裏付ける手掛かり（breakRanks で点数に足す）: 目次の項目がこの頁を
    // 指す・柱がここから変わる・頁番号がここで戻る。
    const run = runs.get(index);
    const before = numberBefore[index];
    const restart = Number.isFinite(item.number) && before !== null && item.number < before;
    // 前付け（0 以下の番号）から本文（1 からの番号）に入るところ。
    const opening = openings.has(index);
    const found = own(item, index);
    if (!found && !item.toc && !run && !restart && !opening) return null;
    const candidate =
      found ??
      (item.toc
        ? { kind: 'heading', title: item.toc }
        : run
          ? { kind: 'running', title: run.text }
          : opening
            ? { kind: 'opening', title: `${openings.get(index)} 頁` }
            : { kind: 'restart', title: `${item.number} 頁` });
    return {
      ...candidate,
      ...(item.toc ? { toc: true } : {}),
      ...(run ? { running: run.level } : {}),
      ...(restart ? { restart: true } : {}),
      ...(opening ? { opening: true } : {}),
    };
  });
  return toTitlePages(items, candidates, atCover);
}

/** 扉・白紙とみなす頁の字の数の上限（本文の頁は数百字ある）。 */
const SPARSE_CHARS = 200;

/** 扉の題とみなす字の高さ（本の頁ごとの行の高さの中央値の、さらに中央値に対する比）。 */
const TITLE_PAGE_SCALE = 1.8;

/**
 * 柱のある本で、区切りの手前（3 頁まで）に、柱の無い字の少ない頁が続き、その中に大きな字の
 * 題のある頁（章の扉）があれば、区切りを扉へ戻す（扉と、扉の裏・白紙は次のまとまりに付ける）。
 * 題の無い白紙だけなら戻さない（前の章の終わりの白紙は、前のまとまりのもの）。本の先頭まで
 * 戻れば、区切りにしない。ファイルの境目は動かさない。柱の無い本では、どの頁も柱が無く
 * 扉と見分けられないので戻さない。
 */
function toTitlePages(items, candidates, atCover) {
  if (items.filter((item) => item.running).length < items.length / 2) return candidates;
  const medians = items.map((item) => item.layout?.median ?? 0).filter((median) => median > 0).sort((a, b) => a - b);
  const typical = medians[Math.floor((medians.length - 1) / 2)] ?? Infinity;
  const sparse = (k) => !items[k].running && (items[k].layout?.chars ?? 0) < SPARSE_CHARS;
  const titled = (k) => (items[k].layout?.height ?? 0) >= typical * TITLE_PAGE_SCALE;
  const moved = candidates.slice();
  candidates.forEach((candidate, index) => {
    if (!candidate || candidate.kind === 'file') return;
    let at = index;
    for (let k = index - 1; k >= 0 && index - k <= 3 && !moved[k] && sparse(k) && (k === 0 || !atCover(k)); k--) {
      if (titled(k)) at = k;
    }
    if (at === index) return;
    moved[index] = null;
    if (at > 0) moved[at] = candidate;
  });
  return moved;
}

/** 柱の中の章・部の番号（「第2 章」「Chapter 3」）。柱が章ごとに変わるかを、これで見る。 */
const CHAPTER_IN_HEAD = /第\s*[0-9一二三四五六七八九十]+\s*章|chapter\s*(?:[0-9]+|[ivxlc]+\b)/i;

/** 柱の部・編の番号（「第2部」「Part 2」）。章とは別に比べる（部が変わると章の番号が 1 に戻る本もあるので）。 */
const PART_IN_HEAD = /第\s*[0-9一二三四五六七八九十]+\s*[部編]|part\s*(?:[0-9]+|[ivxlc]+\b)/i;

/**
 * 柱の行の端の頁番号（「23」「- 23 -」「p.23」「23頁」。全角の数字も）。末尾の番号は、前の空白を
 * 1 つ目のかたまりに取る（置き換えるときに残す。後読みは iOS 16.3 以前の Safari が読めないので使わない）。
 */
const EDGE_NUMBER = /^[-‐－—–\s]*(?:[pPｐＰ][.．]?\s*)?[\d０-９]{1,4}\s*頁?[-‐－—–]*(?=\s|$)|(^|\s)(?:[-‐－—–]+\s*)?(?:[pPｐＰ][.．]?\s*)?[\d０-９]{1,4}\s*頁?[-‐－—–\s]*$/g;

/** 柱を比べるときに、遡って見る柱のある頁の数（左右の頁で違う柱が交互に載るので）。 */
const RUNNING_LOOKBACK = 4;

/** 柱の節の番号（「2.2.5(1) 棟違い」の 2.2）。上の 2 段だけで比べる。 */
// 語の始まりにあり、「2.2.5(1)」のように続いてもよい。OCR で点のあとに空白が入ったもの（「6. 1」）も読む。すぐ後ろにかな・漢字が続いてもよい
// （「2.8.2陸棟」）が、単位などが続くもの（「1.5mm」「1.5倍」「2.5％」）と版の番号（「Ver 2.0」）は除く。
// 語の始まりは、前の空白か行の頭を 1 つ目のかたまりに取って確かめる（後読みは iOS 16.3 以前の
// Safari が読めないので使わない）。版の番号は、合った位置の前の文字で除く（sectionIn）。
const SECTION_IN_HEAD = /(^|\s)(\d{1,2})[.．] ?(\d{1,2})(?:[.．]\d+)*(?:\(\d+\)|（\d+）)?(?=\s|$|[\u3040-\u30ff\u3400-\u9fff])(?![倍割分秒年月日回個枚台人円点度階])/gi;

/** 版の番号の前の言葉（「Ver 2.0」「version. 3.1」）。 */
const VERSION_BEFORE = /ver(?:sion)?\.?\s*$/i;

/**
 * 柱の中の、いちばん前の節の番号（SECTION_IN_HEAD に合い、版の番号でないもの）。
 * @returns {{major:string, minor:string}|null}
 */
function sectionIn(text) {
  for (const found of text.matchAll(SECTION_IN_HEAD)) {
    if (!VERSION_BEFORE.test(text.slice(0, found.index + found[1].length))) return { major: found[2], minor: found[3] };
  }
  return null;
}

const KANJI_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/**
 * 節の番号を数にする（2.2 → 202）。OCR で点が落ちた番号（「2.2.5」を「22.5」、「4.1.6」を
 * 「41.6」）は、同じ柱の章の番号で始まる 2 桁なら、章の番号と次の桁に分けて読む。
 *
 * @param {{major:string, minor:string}} found sectionIn で見つけた番号
 * @param {number|string|null} chapter 同じ柱の章の番号
 */
function sectionNumber(found, chapter) {
  const { major, minor } = found;
  if (typeof chapter === 'number' && major.length === 2 && Number(major) !== chapter && major[0] === String(chapter)) {
    return chapter * 100 + Number(major[1]);
  }
  return Number(major) * 100 + Number(minor);
}

/** 章の番号を数にする（「第2章」「第十二章」「Chapter 3」。読めなければ null）。 */
function chapterNumber(text) {
  const digits = text.match(/\d+/);
  if (digits) return Number(digits[0]);
  const kanji = text.match(/[一二三四五六七八九十]+/)?.[0];
  if (!kanji) return null;
  const [tens, ones] = kanji.includes('十') ? kanji.split('十') : ['', kanji];
  return (kanji.includes('十') ? (KANJI_DIGITS[tens] ?? 1) * 10 : 0) + (KANJI_DIGITS[ones] ?? 0);
}

/**
 * 柱が変わるところ（並びの位置 → 新しい柱）。柱は本文の頁の上の余白に載る章・節の
 * 名前で、章・節が変わると変わる。柱に章の番号（「第2 章」）があれば章の番号で、
 * 節の番号（「2.2.5(1)」の 2.2）があれば節の番号で、どちらも無ければ柱の文字で比べる
 * （level: 'chapter'・'section'・'text'。この順に確か）。直前の柱のある頁
 * （RUNNING_LOOKBACK）に無い番号が出たら、そこから新しいまとまり。ただし、番号は前より
 * 大きくなるときだけ（OCR の読み違いで戻ったように見えるところは使わない）、次の柱の
 * ある頁（RUNNING_LOOKBACK まで）にも同じ番号が続くときだけ（1 頁だけの読み違いを
 * 使わない）。柱の無い頁（章の扉・白紙）が手前にあれば、そこ（3 頁まで）から始める。
 *
 * @param {{running?:string, heading?:string|null, outline?:string|null}[]} items
 * @returns {Map<number, {text:string, level:'chapter'|'section'|'text'}>}
 */
function runningBreaks(items) {
  const keys = items.map((item) => {
    const text = (item.running ?? '').replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
    if (!text) return null;
    const part = text.match(PART_IN_HEAD)?.[0];
    const chapter = text.match(CHAPTER_IN_HEAD)?.[0];
    const section = sectionIn(text);
    const number = (found) => (found ? chapterNumber(found) ?? found.replace(/\s/g, '') : null);
    return {
      text: item.running,
      part: number(part),
      chapter: number(chapter),
      section: section ? sectionNumber(section, number(chapter)) : null,
      // 番号の無い柱（索引・付録など）は、前の頁の柱の文字と比べる。
      plain: part || chapter || section ? null : text,
      whole: text,
    };
  });
  // その頁から前（後ろ）の、柱のある頁の、ある段の値。
  const around = (index, step, field) => {
    const found = [];
    for (let k = index + step; k >= 0 && k < items.length && found.length < RUNNING_LOOKBACK; k += step) {
      if (keys[k]?.[field] != null) found.push(keys[k][field]);
    }
    return found;
  };
  // 前より大きな番号か（数でない番号は、前に無ければ新しいとみなす）。
  const newer = (value, before) => !before.includes(value) && (typeof value !== 'number' || value > before[0]);
  const found = new Map();
  // 最後に見つけた章の変わり目（位置と、見つけた段）。左右の頁で章の番号と節の番号が
  // 交互に載ると、同じ章の変わり目を 2 つの段で続けて見つけるので、重ねない。
  let chapterAt = { index: -Infinity, field: null };
  for (let index = 1; index < items.length; index++) {
    const own = keys[index];
    if (!own) continue;
    let level = null;
    // 確かな段から比べる（その段が変わっていなければ、次の段で比べる）。
    for (const [field, name] of [
      ['part', 'chapter'],
      ['chapter', 'chapter'],
      ['section', 'section'],
      ['plain', 'text'],
    ]) {
      const value = own[field];
      const compare = field === 'plain' ? 'whole' : field;
      const before = value == null ? [] : around(index, -1, compare);
      if (!before.length) continue;
      const after = around(index, 1, compare);
      if (newer(value, before) && (after.length === 0 || after.includes(value))) {
        level = name;
        // 節の番号の上の段が変われば（2.5 → 3.1）、章が変わったところ。
        if (field === 'section' && Math.floor(value / 100) !== Math.floor(before[0] / 100)) level = 'chapter';
        // 章の変わり目を、すぐ前にほかの段（章の番号と節の番号）で見つけていれば、重ねない。
        if (level === 'chapter') {
          const twice = chapterAt.field !== field && index - chapterAt.index <= RUNNING_LOOKBACK;
          chapterAt = { index, field };
          if (twice) level = null;
        }
        break;
      }
    }
    if (!level) continue;
    let at = index;
    // その頁に見出し・しおりもあれば、ここでは戻さない（見出しと一緒に、扉へ戻す。toTitlePages）。
    const titled = items[index].heading || items[index].outline;
    while (!titled && at > 1 && !keys[at - 1] && index - at < 3) {
      at--;
      // 見出し・しおりのある頁（章の扉）で止める（その前の白紙まで戻らない）。
      if (items[at].heading || items[at].outline) break;
    }
    found.set(at, { text: own.text, level });
  }
  return found;
}

/**
 * 頁の柱（上の余白の帯にある行の文字。頁番号だけの行と、行の端の頁番号は除く）。
 * 無ければ ''。
 *
 * @param {{text:string, y:number}[]} lines 頁の文字を行にまとめたもの
 */
export function runningHead(lines) {
  const text = lines
    .filter((line) => line.y < MARGIN_ZONE && /[^\s\d\-‐－()（）.．・]/.test(line.text))
    .map((line) => line.text.replace(EDGE_NUMBER, '$1'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 字・数字が少なければ（スキャンの汚れや絵を OCR で「● ● . ●」と読んだもの）、柱は無いとみなす
  // （章の扉の上の余白の汚れを柱と読むと、柱の変わり目を扉まで遡れない）。
  // 章・節の番号の柱は残す。番号の点・括弧（「1.1.1(1)」）は数えない。
  if (CHAPTER_IN_HEAD.test(text) || PART_IN_HEAD.test(text) || sectionIn(text)) return text;
  const letters = text.replace(/[^\p{L}\p{N}]/gu, '').length;
  const marks = text.replace(/[\s.．()（）・\-‐－]/g, '').length;
  return letters >= 1 && letters >= marks * NOISE_RATIO ? text : '';
}

/** 柱とみなす、字・数字の割合の下限（空白を除いた文字のうち）。 */
const NOISE_RATIO = 0.6;

/** 分けるたびに掛かる手間（ファイルを増やすほど、使う側が手間なので）。 */
const PART_COST = 10;
/** 分ける位置ごとの手間。しおり・見出しは手間なし、ファイルの境目は少し、候補の無いところは重い。 */
const BREAK_COST = { outline: 0, heading: 0, file: 2, running: 1, restart: 1, opening: 1 };
const NO_BREAK_COST = 50;
/** 表紙の後ろ・裏表紙の前（表紙と本文を別のファイルにしない）。 */
const COVER_COST = 1000;

/** その頁の前で分けたときの手間。 */
function breakCost(candidates, index, atCover) {
  if (atCover(index)) return COVER_COST;
  const candidate = candidates[index];
  if (!candidate) return NO_BREAK_COST;
  return BREAK_COST[candidate.kind];
}

/**
 * 上限に収まるように、分ける位置を提案する。
 *
 * 1 冊がそのまま上限に収まれば分けない。収まらなければ、ファイルの数と、
 * 候補でないところで分ける手間がいちばん少なくなる分け方を選ぶ（同じ手間
 * なら、いちばん大きなファイルが小さくなる方）。1 頁だけで上限を超える頁は、
 * その頁だけのファイルにする。
 *
 * @param {{role:string, bytes:number}[]} items 並べた順の頁（bytes は大きさの見積もり）
 * @param {ReturnType<typeof breakCandidates>} candidates
 * @param {{megabytes:number|null, pages:number|null}} limits
 * @param {(index:number) => boolean} [atCover] 表紙だけのファイルができる位置か
 *   （1 冊の一部を分けるときは、1 冊ぶんで決めたものを渡す。coverGuard）
 * @returns {number[]} 新しいファイルを始める頁の位置（小さい順。先頭の 0 は含めない）
 */
export function suggestSplits(items, candidates, limits, atCover = coverGuard(items)) {
  const count = items.length;
  const sums = [0];
  for (const item of items) sums.push(sums.at(-1) + item.bytes);
  const fits = (start, end) => !overLimit(end - start, sums[end] - sums[start], limits);
  if (fits(0, count)) return [];

  // best[end]: 頁 0〜end-1 を分けたときの、いちばん少ない手間と、そのときの
  // いちばん大きなファイルの大きさ、最後のファイルの始まり。
  const best = [{ cost: 0, largest: 0, from: null }];
  for (let end = 1; end <= count; end++) {
    let chosen = null;
    for (let start = end - 1; start >= 0; start--) {
      if (!fits(start, end)) break;
      const before = best[start];
      const cost = before.cost + (start === 0 ? 0 : PART_COST + breakCost(candidates, start, atCover));
      const largest = Math.max(before.largest, sums[end] - sums[start]);
      if (!chosen || cost < chosen.cost || (cost === chosen.cost && largest < chosen.largest)) {
        chosen = { cost, largest, from: start };
      }
    }
    best.push(chosen);
  }

  const starts = [];
  for (let at = best[count].from; at > 0; at = best[at].from) starts.unshift(at);
  return starts;
}

/**
 * 分ける位置から、ファイルごとの頁の範囲を作る。
 *
 * @param {number} count 頁の数
 * @param {number[]} starts 新しいファイルを始める頁の位置（小さい順）
 * @returns {{start:number, end:number}[]} end は含まない
 */
export function splitRanges(count, starts) {
  const bounds = [0, ...starts, count];
  return bounds.slice(0, -1).map((start, k) => ({ start, end: bounds[k + 1] }));
}

/**
 * 分けたファイルの名前。「猫.pdf」を 3 つに分けるなら「猫_1.pdf」〜「猫_3.pdf」
 * （10 以上に分けるなら「猫_01.pdf」のように桁を揃え、名前の順に並ぶようにする）。
 * 区切りの名前（partLabel）があれば添える（「猫_2_第2章 壁.pdf」）。検索や
 * Gemini で参照するときに、どのファイルに何が載っているかが名前で分かる。
 *
 * @param {string} name 1 冊ぶんの名前（.pdf 付き）
 * @param {number} index 何番目か（0 から）
 * @param {number} count いくつに分けるか
 * @param {string} [label] 区切りの名前
 */
export function partFileName(name, index, count, label = '') {
  if (count <= 1) return name;
  const stem = name.replace(/\.pdf$/i, '');
  const number = String(index + 1).padStart(String(count).length, '0');
  // 名前が長すぎるときは、区切りの名前を短くする（多くのファイルシステムは
  // UTF-8 で 255 バイトまで。日本語は 1 字 3 バイト）。
  const bytes = (text) => new TextEncoder().encode(text).length;
  let chars = Array.from(label);
  const nameOf = () => {
    // 切ったところに残った終わりの点・空白は除く（sanitizeFileName）。
    const cut = sanitizeFileName(chars.join(''));
    return `${stem}_${number}${cut ? `_${cut}` : ''}.pdf`;
  };
  while (chars.length && bytes(nameOf()) > NAME_BYTES) chars = chars.slice(0, -1);
  return nameOf();
}

/** ファイルの名前の長さの上限（UTF-8 のバイト。255 に少し余裕を持たせる）。 */
const NAME_BYTES = 240;

/**
 * 1 冊ぶんの頁ラベルの範囲（ordering.js の pageLabelRanges）から、分けた
 * ファイルの分を切り出す。分けたファイルでも、ビューアーには本の頁番号が出る。
 *
 * @param {{start:number, style:string|null, prefix:string, first:number}[]} ranges
 * @param {number} start
 * @param {number} end 含まない
 */
export function sliceLabelRanges(ranges, start, end) {
  const sliced = [];
  ranges.forEach((range, k) => {
    const next = k + 1 < ranges.length ? ranges[k + 1].start : Infinity;
    if (next <= start || range.start >= end) return;
    const from = Math.max(range.start, start);
    sliced.push({ ...range, start: from - start, first: range.first + (from - range.start) });
  });
  return sliced;
}

/**
 * 区切りの確からしさの順位（小さいほど確か）。しおり（作った人が付けたもの）、部・編の
 * 見出し、章の見出し、節などの見出し（小さなまとまりで、読み違いもしやすい）、取り込んだ
 * ファイルの境目（連続スキャンでは、束の切れ目は意味が無いことが多い）の順。
 */
export const RANKS = { outline: 1, part: 2, chapter: 3, section: 4, file: 5 };

/** 見出しの順位（部・編、章、そのほか）。 */
export function headingRank(title) {
  if (/^(?:第[^章部編]*[部編]|part\b)/i.test(title)) return RANKS.part;
  if (/^(?:第[^章部編]*章|chapter\b)/i.test(title)) return RANKS.chapter;
  return RANKS.section;
}

/**
 * しおりの項目・見出し・ファイルの境目がこれだけ以上あって、頁の半分より多ければ、
 * 頁ごとの細かい区切り（頁ごとのしおり・スライドの頁ごとの見出し・何百もの 1 頁の
 * ファイル）とみなし、その順位の区切りは使わない（細かいファイルが何百もできるので）。
 */
const DENSE_BREAKS = 20;

/**
 * 区切りの候補ごとの順位（RANKS。候補でなければ null）。ファイルの境目の頁にしおり・
 * 見出しもあれば、その順位にする。
 *
 * 細かすぎる区切り（しおり・見出し・ファイルの境目のそれぞれで、DENSE_BREAKS 以上あって
 * 頁の半分より多いもの）は使わない（null）。見出しは部・章・節をまとめて数える。
 *
 * 見出しの頁のすぐ後ろの頁にも同じか上の階層の見出しがあれば（目次の頁の行を見出しと
 * 読んだときなど）、前の頁の見出しはファイルの境目と同じ順位に下げる。部の扉のすぐ
 * 後ろに章の扉が続くような、上の階層から下の階層へ続くところは下げない。
 *
 * @param {{outline?:string|null}[]} items 並べた順の頁
 * @param {ReturnType<typeof breakCandidates>} candidates
 * @returns {(number|null)[]}
 */
export function breakRanks(items, candidates) {
  // 見出しの順位（ファイルの境目なら、その頁の見出しの順位）。見出しでなければ null。
  const headingOf = (candidate, index) => {
    if (candidate?.kind === 'heading') return headingRank(candidate.title);
    if (candidate?.kind === 'file' && candidate.chapter && !items[index].outline) return headingRank(candidate.chapter);
    return null;
  };
  const headings = candidates.map(headingOf);
  // しおりの題に階層の形があれば、その階層（「第2章 …」は章、「01. マウス操作」は節）。
  const outlineLevel = outlineLevels(items.flatMap((item) => (item.outline ? [item.outline] : [])));
  const outlines = candidates.map((candidate, index) => {
    const title = candidate?.kind === 'outline' ? candidate.title : candidate?.chapter && items[index].outline;
    return title ? outlineLevel(title) : null;
  });
  // 区切りらしさの点数。候補そのものの点数（しおり 5・部 4・章 3・節 2・ファイルの境目 1・
  // 柱や頁番号だけの候補 0）に、裏付けの手掛かりを足す（目次の項目が指す +2・柱の章の
  // 番号が変わる +3・節の番号が変わる +2・番号の無い柱が変わる +1・頁番号が戻る +2）。目次の頁の行らしい見出し（すぐ後ろの頁にも
  // 同じか上の階層の見出しがある）は、候補そのものの点数を 1 に下げる。
  // 柱の変わり目が細かすぎれば（本文の行を柱と読んだときなど）、柱は当てにしない（点数に足さない）。
  const runningMarks = candidates.filter((candidate) => candidate?.running).length;
  const noisyRunning = runningMarks >= DENSE_BREAKS && runningMarks > items.length / 3;
  const scores = candidates.map((candidate, index) => {
    if (!candidate) return null;
    const next = headings[index + 1];
    // （目次の項目が指す頁は、目次の行ではないので下げない）
    const toc = !candidate.toc && headings[index] !== null && next !== null && next !== undefined && next <= headings[index];
    let base;
    if (toc) base = 1;
    else if (headings[index] !== null) base = SCORE_OF_RANK[headings[index]];
    else if (outlines[index] !== null) base = SCORE_OF_RANK[outlines[index]];
    else if (candidate.kind === 'outline' || candidate.chapter) base = SCORE_OF_RANK[RANKS.outline];
    else base = candidate.kind === 'file' ? 1 : 0;
    const bonus =
      (candidate.toc ? 2 : 0) +
      (noisyRunning ? 0 : RUNNING_SCORE[candidate.running] ?? 0) +
      (candidate.restart ? 2 : 0) +
      (candidate.opening ? 3 : 0);
    return Math.max(1, base + bonus);
  });
  // 細かすぎる区切りは、候補の種類（しおり・見出し・ファイルの境目・柱・頁番号）ごとに数える
  // （見出しは部・章・節をまとめて、目次の行らしいものも含めて）。
  const kinds = candidates.map((candidate, index) => {
    if (!candidate) return null;
    if (headings[index] !== null) return 'heading';
    if (candidate.kind === 'file' && candidate.chapter) return 'outline';
    return candidate.kind;
  });
  // 階層の形の無いしおりは、作った人が付けた区切りなので、手掛かりを足したほかの候補より
  // 確かにする（階層の形のあるしおりは、その階層の見出しと比べる）。
  const plainOutline = (index) => kinds[index] === 'outline' && outlines[index] === null;
  const count = new Map();
  for (const kind of kinds) if (kind) count.set(kind, (count.get(kind) ?? 0) + 1);
  const dense = (kind) => count.get(kind) >= DENSE_BREAKS && count.get(kind) > items.length / 2;
  const ranks = scores.map((score, index) => (score === null || dense(kinds[index]) ? null : rankOfScore(score)));
  // しおり（作った人が付けたもの）は、手掛かりを足したほかの候補より確かにする。
  const others = ranks.filter((rank, index) => rank !== null && !plainOutline(index));
  const top = Math.min(RANKS.outline, ...others.map((rank) => rank - 1));
  return ranks.map((rank, index) => (rank !== null && plainOutline(index) ? Math.min(rank, top) : rank));
}

/** 柱の変わり目の点数（章の番号 3・節の番号 2・番号の無い柱の文字 1）。 */
const RUNNING_SCORE = { chapter: 3, section: 2, text: 1 };

/** 順位ごとの点数（しおり 5・部 4・章 3・節 2・ファイルの境目 1）。 */
const SCORE_OF_RANK = { 1: 5, 2: 4, 3: 3, 4: 2, 5: 1 };

/**
 * 点数を順位に戻す（5 がしおりと同じ 1、1 がファイルの境目と同じ 5）。5 より高い点数は
 * しおりより確かな順位（0, -1, …）にする（目次が裏付ける部と章を、同じ順位にしないように）。
 */
function rankOfScore(score) {
  return RANKS.file + 1 - score;
}

/**
 * 分ける位置。本の全体が上限に収まれば分けない。収まらなければ、いちばん確からしい
 * 順位の区切りのすべてで分け（セクションに分ける）、まだ上限を超えるセクションだけを、
 * 次の順位の区切りで分ける。これを節の見出しまで繰り返す。しおり・見出しで分けられない
 * のに上限を超えるセクションは、上限に収まる最少の数で、大きさがほぼ同じになるように
 * 分ける（suggestSplits。ファイルの境目は、連続スキャンでは束の切れ目に意味が無いことが
 * 多いので、すべてでは分けず、そのときの分ける位置の候補にする）。上限に収まる小さいセクションは、まとめない（章などの
 * まとまりを保つ）。
 *
 * しおり・見出しで 1 頁だけのファイルはできないようにする（目次の頁のすぐ後ろに部の
 * 扉、そのすぐ後ろに章の扉、と続くときなど。ファイルの境目は、取り込んだファイルの
 * まとまりなので、1 頁でも分ける）。表紙だけ・裏表紙だけのファイルもできない（その
 * 位置は候補にならない。breakCandidates）。
 *
 * @param {{role:string, bytes:number, outline?:string|null}[]} items 並べた順の頁
 * @param {ReturnType<typeof breakCandidates>} candidates
 * @param {{megabytes:number|null, pages:number|null}} limits
 * @param {(number|null)[]} [ranks] 区切りの順位（breakRanks）
 * @returns {number[]} 新しいファイルを始める頁の位置（小さい順）
 */
export function splitByRank(items, candidates, limits, ranks = breakRanks(items, candidates)) {
  const sums = [0];
  for (const item of items) sums.push(sums.at(-1) + item.bytes);
  const fits = (start, end) => !overLimit(end - start, sums[end] - sums[start], limits);
  const atCover = coverGuard(items);
  const split = (start, end, rank) => {
    if (fits(start, end)) return [];
    for (let at = rank; at <= RANKS.section; at++) {
      const bounds = [start];
      for (let index = start + 1; index < end; index++) if (ranks[index] === at) bounds.push(index);
      bounds.push(end);
      dropSinglePages(bounds, candidates);
      if (bounds.length < 3) continue;
      const starts = [];
      for (let k = 0; k + 1 < bounds.length; k++) {
        if (k > 0) starts.push(bounds[k]);
        starts.push(...split(bounds[k], bounds[k + 1], at + 1));
      }
      return starts;
    }
    // しおり・見出しで分けられなければ、上限に収まる最少の数で、大きさがほぼ同じになる
    // ように分ける。分ける位置には、ファイルの境目と、1 頁だけになるので使わなかった
    // しおり・見出しを選ぶ（ファイルの境目と順位を下げた見出しは、ほかより重く）。
    const part = items.slice(start, end);
    const inner = part.map((_, k) => {
      const rank = ranks[start + k];
      if (rank === null || k === 0) return null;
      return { kind: rank === RANKS.file ? 'file' : 'heading' };
    });
    return suggestSplits(part, inner, limits, (index) => atCover(index + start)).map((index) => index + start);
  };
  const most = Math.min(RANKS.outline, ...ranks.filter((rank) => rank !== null));
  return split(0, items.length, most);
}

/**
 * しおり・見出しで分けて 1 頁だけになるまとまりを、隣と一緒にする（bounds を
 * 書き換える）。次の区切りがしおり・見出しなら、次と一緒にする（目次の頁・部の
 * 扉は、続く章と同じファイルに）。次がファイルの境目か本の終わりなら、前と一緒に
 * する（ファイルの最後の頁にある章の扉など）。ファイルの境目で始まるまとまりは、
 * 1 頁でもそのまま（取り込んだファイルのまとまりなので）。
 */
function dropSinglePages(bounds, candidates) {
  const isFile = (index) => candidates[index]?.kind === 'file';
  for (let k = 0; k + 1 < bounds.length; ) {
    const single = bounds[k + 1] - bounds[k] < 2;
    const next = bounds[k + 1];
    if (single && k + 2 < bounds.length && !isFile(next)) {
      bounds.splice(k + 1, 1);
    } else if (single && k > 0 && !isFile(bounds[k])) {
      bounds.splice(k, 1);
      k--;
    } else {
      k++;
    }
  }
}

/**
 * 頁の帯に ▲ で示す区切りの候補とその順位（示さなければ null）。しおりと見出し
 * （と、しおり・見出しのあるファイルの境目）。ただのファイルの境目は、連続スキャン
 * では意味が無いことが多いので示さない（分けているなら ✂ が出る）。細かすぎる順位の
 * 区切りも示さない（breakRanks）。
 *
 * @param {ReturnType<typeof breakCandidates>} candidates
 * @param {(number|null)[]} ranks breakRanks
 */
export function seamCandidates(candidates, ranks) {
  return ranks.map((rank, index) => (rank !== null && rank < RANKS.file && (candidates[index].kind !== 'file' || candidates[index].chapter) ? rank : null));
}

/**
 * start〜end（end は含まない）のまとまりを 2 つに分ける位置（「このファイルを 2 つに
 * 分ける」）。中の区切りのうち、いちばん確からしい順位のもので、真ん中にいちばん近い
 * ところ。区切りが無ければ真ん中。1 頁だけのファイルができる位置（両端）は選ばない。
 *
 * @param {(number|null)[]} ranks 並べた順の頁ごとの区切りの順位（breakRanks）
 */
export function middleCut(ranks, start, end) {
  const middle = Math.floor((start + end) / 2);
  let best = null;
  // 1 頁だけのファイルはできないように、両端の頁では分けない。
  for (let index = start + 2; index < end - 1; index++) {
    const rank = ranks[index];
    if (rank === null) continue;
    const better =
      best === null ||
      rank < ranks[best] ||
      (rank === ranks[best] && Math.abs(index - middle) < Math.abs(best - middle));
    if (better) best = index;
  }
  return best ?? middle;
}

/** ファイルの名前に添える、区切りの名前の長さの上限。 */
const LABEL_LENGTH = 40;

/**
 * 分けたファイルの名前に添える、区切りの名前（しおり・見出し・ファイルの名前）。
 * ファイルの名前なら、終わりの括弧の中（「…ガイドブック14（柱脚金物）.pdf」なら
 * 「柱脚金物」）を使う。括弧が無ければ、その頁のしおり・見出し（chapter）、それも
 * 無ければ、拡張子を除いた名前から、分けたファイルの始まりになるファイルに共通
 * する頭（prefix）を除いたもの（「本_051-100.pdf」なら「051-100」）。
 * ダウンロードし直したときに付く「 (1)」（空白と半角の括弧の中の 1〜2 桁の数）は、
 * 名前に含めない。
 *
 * @param {{kind:string, title:string}|null} candidate
 * @param {string} [prefix] 取り込んだファイルの名前に共通する頭
 * @returns {string} 添えるものが無ければ ''
 */
export function partLabel(candidate, prefix = '') {
  if (!candidate) return '';
  let title = candidate.title;
  if (candidate.kind === 'file') {
    const stem = title.replace(/\.pdf$/i, '').replace(/\s+\([0-9]{1,2}\)$/, '');
    // 括弧の中が数だけ（年・巻）なら、中身を表さないので使わない。
    const bracket = stem.match(/[（(【［「]([^（()）【】［］「」]+)[）)】］」]$/)?.[1].replace(/^[0-9０-９]+$/, '') || null;
    const rest = prefix && stem.startsWith(prefix) ? stem.slice(prefix.length) : '';
    title = bracket ?? (candidate.chapter || rest || stem);
  }
  // 改行・タブは、使えない字として除く前に空白にする（言葉どうしがくっつかないように）。
  // 長さは字で数える（UTF-16 で切ると、𠮷 のような字が半分になる）。切ったあとの
  // 終わりの点も除く（pdf-file-ops.js の sanitizeFileName。サーバーと同じ決まり）。
  const clean = sanitizeFileName(title.replace(/\s+/g, ' '));
  return sanitizeFileName(Array.from(clean).slice(0, LABEL_LENGTH).join(''));
}

/**
 * 分けたファイルごとの、名前に添える区切りの名前（partLabel）。2 つ目からは、
 * そのファイルを始める区切り。最初のファイルは、表紙を除いた最初の頁の
 * しおり・見出しか、ファイルの境目で分けているなら、その頁のファイルの名前。
 *
 * @param {{role:string, fileName:string, outline?:string|null, heading?:string|null}[]} items
 * @param {ReturnType<typeof breakCandidates>} candidates
 * @param {number[]} starts 新しいファイルを始める頁の位置
 * @param {{joinNext?:boolean}} [options] joinNext: 1 頁だけのまとまりを次と一緒にした
 *   とき（区切りごとに分けたとき。splitAtBreaks）、次の区切りの名前も並べる
 * @returns {string[]}
 */
export function partLabels(items, candidates, starts, { joinNext = false, ranks = null } = {}) {
  const end = starts[0] ?? items.length;
  const first = items.slice(0, end).find((item) => item.role !== 'front') ?? items[0];
  const byFile = starts.some((index) => candidates[index]?.kind === 'file');
  const at = items.indexOf(first);
  const chapter = first?.outline || first?.heading || null;
  // 最初のファイルも、ほかと同じ形の区切りとして名前を付ける。
  const head = first && (byFile ? { kind: 'file', title: first.fileName, chapter } : chapter && { kind: 'outline', title: chapter });
  // 次の頁の名前を並べるのは、次の頁の区切りが、その区切りと同じか、より確からしいとき
  // だけ（目次の頁・部の扉を次の章と一緒にしたとき。分けなかった弱い区切りの名前は並べない）。
  const weaker = (index) => {
    if (!ranks || ranks[index] === null || ranks[index] === undefined) return false;
    const next = ranks[index + 1];
    return next === null || next === undefined || next > ranks[index];
  };
  const join = (own, index, until) => (joinNext && !weaker(index) ? withNext(own, candidates[index + 1], index + 1 < until) : own);
  const heads = [
    join(head || null, at, end),
    ...starts.map((index, k) => join(candidates[index], index, starts[k + 1] ?? items.length)),
  ];
  // 共通する頭は、分けたファイルの始まりになるファイルの名前だけで求める（表紙など
  // 名前の違うファイルに引きずられないように）。
  const stems = heads.filter((c) => c?.kind === 'file').map((c) => c.title.replace(/\.pdf$/i, ''));
  const prefix = commonPrefix([...new Set(stems)]);
  return heads.map((candidate) => partLabel(candidate, prefix));
}

/**
 * 分けたファイルの始まりの区切り。しおり・見出しの区切りのすぐ次の頁にも、同じ
 * ファイルの中でしおり・見出しの区切りがあれば（目次の頁・部の扉のすぐ次の章）、
 * 両方の名前を並べる（「目次 第1章」「第2部 第5章」。中身の大半はあとの方なので）。
 *
 * @param {{kind:string, title:string}|null} own
 * @param {{kind:string, title:string}|null|undefined} next
 * @param {boolean} inside 次の頁が同じファイルの中か
 */
function withNext(own, next, inside) {
  if (!own || own.kind === 'file' || !inside || !next || next.kind === 'file') return own;
  return { kind: own.kind, title: `${own.title} ${next.title}` };
}

/**
 * 名前に共通する頭。区切りの字（空白・_・-・・）までにそろえる（「本_001-050」
 * 「本_051-100」なら「本_」。数の途中では切らない）。名前が 1 つだけなら ''。
 */
function commonPrefix(names) {
  if (names.length < 2) return '';
  let prefix = names[0];
  for (const name of names) {
    let i = 0;
    while (i < prefix.length && prefix[i] === name[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.slice(0, prefix.search(/[\s_\-・][^\s_\-・]*$/) + 1);
}

/**
 * 分ける位置の候補の理由（画面に出す）。ファイルの境目の頁にしおり・見出しも
 * あれば、その名前も添える（「ファイルの境目「b.pdf」（第2章）」）。
 *
 * @param {{kind:string, title:string, chapter?:string}} candidate
 */
export function breakReason(candidate) {
  const chapter = candidate.chapter ? `（${candidate.chapter}）` : '';
  return `${BREAK_KINDS[candidate.kind]}「${candidate.title}」${chapter}`;
}
