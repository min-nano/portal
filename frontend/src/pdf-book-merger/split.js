// 結合した PDF を、いくつかのファイルに分ける（分割）。
//
// 大きすぎる PDF は、スマートフォンでは開くのも送るのも重く、取り込んで
// 検索・要約するサービスでは、後ろの方の中身が索引に入らないことがある。
// Google Workspace に置いて検索や Gemini で参照するときは、章などのまとまり
// ごとのファイルの方が、まとまった中身を保ったまま参照できる。分け方は 2 通り:
//
//   breaks  区切りごとに分ける（既定）。区切りの候補のすべてで分け、1 ファイルの
//           上限（大きさ・頁数）を超えるまとまりは、さらに分ける（splitAtBreaks）
//   limit   上限を超えるときだけ、区切りを選んで分ける（suggestSplits）
//
// 提案は画面で足したり外したりできる。
//
// 分ける位置の候補（その頁の前で分ける）:
//
//   しおり       元の PDF のしおり（目次）の、いちばん上の段の項目が指す頁
//   見出し       「第 3 章」「Chapter 3」のような、大きな字の見出しのある頁
//   ファイルの境目 ファイルをそのまま続けてつないだところ（奇数頁・偶数頁の
//                束のように、ファイルが入り混じるところは境目にしない）
//
// 候補だけでは上限に収まらないときは、候補の無いところでも分ける。表紙は
// 最初のファイルに、裏表紙は最後のファイルに付ける（表紙だけ・裏表紙だけの
// ファイルを作らない。先頭・末尾に置く頁が COVER_PAGES より多ければ、目次などが
// まとまっているとみなし、本文とは分けてよい）。本文が 1 頁も無いとき（すべて
// 「先頭に置く」にして、ファイルの並びのままつなぐとき）は、表紙として扱わない。
//
// DOM には触らない（テストで縛るため）。

import { sanitizeFileName } from '../pdf-file-ops.js';
import { COVER_PAGES } from './ordering.js';
import { MARGIN_ZONE } from './page-numbers.js';

/** 分ける位置の候補の種類（画面に出す名前）。 */
export const BREAK_KINDS = {
  outline: 'しおり',
  heading: '見出し',
  file: 'ファイルの境目',
};

/** 1 MB（分ける上限の大きさは MB で入れる）。 */
export const MEGABYTE = 1024 * 1024;

/**
 * 分け方。breaks: 区切りごとに分ける（上限を超えるところは、さらに分ける）。
 * limit: 上限を超えるときだけ分ける（区切りは、分ける位置を選ぶのに使う）。
 */
export const SPLIT_MODES = ['breaks', 'limit'];

/**
 * 分ける上限と分け方の既定。大きさは 100 MB、頁数は上限なし（null）で、区切り
 * ごとに分ける（Google Workspace に置いて検索・Gemini で参照するので、章などの
 * まとまりごとのファイルにする）。
 */
export const DEFAULT_LIMITS = { megabytes: 100, pages: null, mode: 'breaks' };

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

/** 見出しとみなす、行の文字の高さ（頁の中の行の高さの中央値に対する倍率）。 */
const HEADING_SCALE = 1.3;

/** 番号だけの見出しに続ける題の字の大きさ（本文の字に対する倍率）。 */
const TITLE_SCALE = 1.2;

/** 見出しの行の長さの上限（本文の行の頭に「第 3 章で…」とあるのを拾わない）。 */
const HEADING_LENGTH = 40;

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
 * 番号だけの見出し（「Section 2」）なら、すぐ下にある大きな字の行を題として
 * 続ける（「Section 2 プレセッターの解説」）。分けたファイルの名前に添えるため。
 *
 * @param {{text:string, x0:number, x1:number, y:number, h:number}[]} lines
 *   頁の文字を行にまとめたもの（page-numbers.js の groupLines）
 * @returns {string|null}
 */
export function chapterHeading(lines) {
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
 * @param {{fileKey:string, fileName:string, role:string, outline?:string|null, heading?:string|null}[]} items
 *   並べた順の頁
 * @returns {({kind:'outline'|'heading'|'file', title:string, chapter?:string|null}|null)[]}
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
  return items.map((item, index) => {
    if (index === 0 || atCover(index)) return null;
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
  });
}

/** 分けるたびに掛かる手間（ファイルを増やすほど、使う側が手間なので）。 */
const PART_COST = 10;
/** 分ける位置ごとの手間。章の区切りは手間なし、候補の無いところは重い。 */
const BREAK_COST = { outline: 0, heading: 0, file: 2 };
const NO_BREAK_COST = 50;
/** 表紙の後ろ・裏表紙の前（表紙と本文を別のファイルにしない）。 */
const COVER_COST = 1000;

/** その頁の前で分けたときの手間。 */
function breakCost(candidates, index, atCover) {
  if (atCover(index)) return COVER_COST;
  const candidate = candidates[index];
  if (!candidate) return NO_BREAK_COST;
  // ファイルの境目でも、しおり・見出しがあれば章の区切り。
  return candidate.chapter ? 0 : BREAK_COST[candidate.kind];
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
 * 区切りごとに分ける位置（分け方 breaks）。区切りの候補のすべてで分け、上限を
 * 超えるまとまりは、その中でさらに分ける（suggestSplits）。
 *
 * ただし本文が無いとき（すべて「先頭に置く」にして、ファイルの並びのままつなぐ
 * とき）は、ファイルの境目では分けない。何百もの 1 頁のファイルを 1 つにつなぐ
 * ようなときに、ファイルの数だけに分けてしまわないように（しおり・見出しでは
 * 分ける）。また、しおり・見出しで 1 頁だけのファイルはできないようにする（目次の
 * 頁のすぐ後ろに部の扉、そのすぐ後ろに章の扉、と続くときなど。ファイルの境目は、
 * 取り込んだファイルのまとまりなので、1 頁でも分ける）。
 *
 * @param {{role:string, bytes:number}[]} items 並べた順の頁
 * @param {ReturnType<typeof breakCandidates>} candidates
 * @param {{megabytes:number|null, pages:number|null}} limits
 * @returns {number[]} 新しいファイルを始める頁の位置（小さい順）
 */
export function splitAtBreaks(items, candidates, limits) {
  const hasBody = hasBodyPages(items);
  // 項目の多すぎるしおり（頁ごと・節ごとのしおり）は、章のまとまりではないので使わない。
  // ファイルの境目も同じ（何百もの 1 頁のファイルをつなぐときなど）。
  const dense = denseBreaks(items, candidates);
  const used = (candidate) => {
    if (!candidate) return false;
    if (candidate.kind !== 'file') return !dense.chapter;
    // ファイルの境目。細かすぎるときと本文が無いときは、しおり・見出しもあるときだけ。
    const chapter = Boolean(candidate.chapter) && !dense.chapter;
    return dense.file ? chapter : hasBody || chapter;
  };
  const bounds = [0];
  candidates.forEach((candidate, index) => {
    if (used(candidate)) bounds.push(index);
  });
  bounds.push(items.length);
  dropSinglePages(bounds, candidates);
  const atCover = coverGuard(items);
  const starts = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const [from, to] = [bounds[k], bounds[k + 1]];
    if (k > 0) starts.push(from);
    // まとまりの中の、使わなかった候補（ファイルの境目）は、さらに分ける位置を選ぶのに使う。
    const inner = suggestSplits(
      items.slice(from, to),
      [null, ...candidates.slice(from + 1, to)],
      limits,
      (index) => atCover(index + from)
    );
    starts.push(...inner.map((index) => index + from));
  }
  return starts;
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
 * しおりの項目（ファイルの境目）がこれだけ以上あって、頁の半分より多ければ、
 * 頁ごと・節ごとの細かいしおり（何百もの 1 頁のファイル）とみなす。区切りごとに
 * 分けると、細かいファイルが何百もできるので、その区切りでは分けない。
 */
const DENSE_BREAKS = 20;

/**
 * 細かすぎる区切り。file: ファイルの境目が細かすぎる。chapter: しおり・見出し（と、
 * しおり・見出しのあるファイルの境目）が細かすぎる（1 頁ずつのファイルに、それぞれ
 * しおりがあるとき・スライドの頁ごとに違う見出しがあるときなど）。
 *
 * @returns {{file:boolean, chapter:boolean}}
 */
function denseBreaks(items, candidates) {
  const dense = (count) => count >= DENSE_BREAKS && count > items.length / 2;
  return {
    file: dense(candidates.filter((candidate) => candidate?.kind === 'file').length),
    chapter: dense(candidates.filter((candidate) => candidate && (candidate.kind !== 'file' || candidate.chapter)).length),
  };
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
export function partLabels(items, candidates, starts, { joinNext = false } = {}) {
  const end = starts[0] ?? items.length;
  const first = items.slice(0, end).find((item) => item.role !== 'front') ?? items[0];
  const byFile = starts.some((index) => candidates[index]?.kind === 'file');
  const at = items.indexOf(first);
  const chapter = first?.outline || first?.heading || null;
  // 最初のファイルも、ほかと同じ形の区切りとして名前を付ける。
  const head = first && (byFile ? { kind: 'file', title: first.fileName, chapter } : chapter && { kind: 'outline', title: chapter });
  const join = (own, index, until) => (joinNext ? withNext(own, candidates[index + 1], index + 1 < until) : own);
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
