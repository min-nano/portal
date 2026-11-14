// 結合した PDF を、いくつかのファイルに分ける（分割）。
//
// 大きすぎる PDF は、スマートフォンでは開くのも送るのも重く、取り込んで
// 検索・要約するサービスでは、後ろの方の中身が索引に入らないことがある。
// そこで、1 ファイルの上限（大きさ・頁数）を決め、それを超えるときは
// 章の区切りで分ける位置を提案する。提案は画面で足したり外したりできる。
//
// 分ける位置の候補（その頁の前で分ける）:
//
//   しおり       元の PDF のしおり（目次）の、いちばん上の段の項目が指す頁
//   見出し       「第 3 章」「Chapter 3」のような、大きな字の見出しのある頁
//   ファイルの境目 ファイルをそのまま続けてつないだところ（奇数頁・偶数頁の
//                束のように、ファイルが入り混じるところは境目にしない）
//
// 候補だけでは上限に収まらないときは、候補の無いところでも分ける。表紙は
// 最初のファイルに、裏表紙は最後のファイルに付ける（そこでは分けない）。
// ただし本文が 1 頁も無いとき（すべて「先頭に置く」にして、ファイルの並びの
// ままつなぐとき）は、表紙として扱わない。
//
// DOM には触らない（テストで縛るため）。

import { MARGIN_ZONE } from './page-numbers.js';

/** 分ける位置の候補の種類（画面に出す名前）。 */
export const BREAK_KINDS = {
  outline: 'しおり',
  heading: '見出し',
  file: 'ファイルの境目',
};

/** 1 MB（分ける上限の大きさは MB で入れる）。 */
export const MEGABYTE = 1024 * 1024;

/** 分ける上限の既定。大きさは 100 MB、頁数は上限なし（null）。 */
export const DEFAULT_LIMITS = { megabytes: 100, pages: null };

/**
 * 章の見出しらしい行の頭（「第 3 章」「第 十 二 章」「第Ⅱ部」「Chapter 3」）。
 * 字を空けて組んだ見出しは、行にまとめるときに字の間に空白が入る。
 */
const HEADING = /^(?:第\s*(?:[0-9一二三四五六七八九十百千〇零Ⅰ-Ⅻ]\s*)+[章部編]|(?:chapter|part)\s+(?:[0-9]+|[ivxlc]+|[Ⅰ-Ⅻ]+)(?![0-9a-z]))/i;

/**
 * 見出しの頭のあとの区切り（空白・コロン・句読点・括弧か、行の終わり）。字の
 * 大きさで見分けられない頁（行の少ない頁）では、これも求める（「第 3 章で
 * 述べた…」は本文の説明）。
 */
const HEADING_END = /^(?:[\s:：.．、「『（(【]|$)/;

/** 見出しとみなす、行の文字の高さ（頁の中の行の高さの中央値に対する倍率）。 */
const HEADING_SCALE = 1.3;

/** 見出しの行の長さの上限（本文の行の頭に「第 3 章で…」とあるのを拾わない）。 */
const HEADING_LENGTH = 40;

/**
 * 頁の文字情報から、章の見出しを探す。見つからなければ null。
 *
 * 頁の上の 6 割にあって、ほかの行（見出しの形でない行）より大きな字の行を
 * 見出しとする。柱（章の名前を載せた行）は章の途中の頁にも載るが、本文と同じ
 * くらいの字なので拾わない。行が 3 つまでしかない頁（章の扉）は、字の大きさを
 * 比べずに見出しとする（そのときは、余白の帯の中の行は見ない。柱と頁番号だけの
 * 白紙の頁を拾わないように。見出しの頭のあとの区切りも求める）。
 *
 * @param {{text:string, x0:number, x1:number, y:number, h:number}[]} lines
 *   頁の文字を行にまとめたもの（page-numbers.js の groupLines）
 * @returns {string|null}
 */
export function chapterHeading(lines) {
  // 比べる字の大きさは、見出しの形でない行の高さの中央値（見出しが何行かあっても
  // 引きずられないように。小さい方の中央値）。
  const heights = lines
    .filter((line) => !HEADING.test(line.text))
    .map((line) => line.h)
    .sort((a, b) => a - b);
  const median = heights[Math.floor((heights.length - 1) / 2)];
  const few = lines.length <= 3;
  for (const line of lines) {
    if (line.y > 0.6 || line.text.length > HEADING_LENGTH) continue;
    const head = line.text.match(HEADING);
    if (!head) continue;
    if (few) {
      if (line.y >= MARGIN_ZONE && HEADING_END.test(line.text.slice(head[0].length))) return line.text;
    } else if (line.h >= median * HEADING_SCALE) {
      return line.text;
    }
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

/**
 * その頁の前が、表紙の後ろか裏表紙の前か（表紙と本文を別のファイルにしない）。
 * 本文が無ければ（ファイルの並びのままつなぐとき）、表紙として扱わない。
 */
function atCover(items, index, hasBody) {
  return hasBody && (items[index - 1].role === 'front' || items[index].role === 'back');
}

function hasBodyPages(items) {
  return items.some((item) => item.role === 'body');
}

/**
 * 並べた頁ごとに、その頁の前で分ける候補を挙げる（先頭の頁と、表紙の後ろ・
 * 裏表紙の前は null）。
 *
 * @param {{fileKey:string, fileName:string, role:string, outline?:string|null, heading?:string|null}[]} items
 *   並べた順の頁
 * @returns {({kind:'outline'|'heading'|'file', title:string}|null)[]}
 */
export function breakCandidates(items) {
  const first = new Map();
  const last = new Map();
  const hasBody = hasBodyPages(items);
  items.forEach((item, index) => {
    if (!first.has(item.fileKey)) first.set(item.fileKey, index);
    last.set(item.fileKey, index);
  });
  return items.map((item, index) => {
    if (index === 0 || atCover(items, index, hasBody)) return null;
    if (item.outline) return { kind: 'outline', title: item.outline };
    if (item.heading) return { kind: 'heading', title: item.heading };
    const previous = items[index - 1];
    if (previous.fileKey !== item.fileKey && last.get(previous.fileKey) === index - 1 && first.get(item.fileKey) === index) {
      return { kind: 'file', title: item.fileName };
    }
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
function breakCost(items, candidates, index, hasBody) {
  if (atCover(items, index, hasBody)) return COVER_COST;
  const candidate = candidates[index];
  return candidate ? BREAK_COST[candidate.kind] : NO_BREAK_COST;
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
 * @returns {number[]} 新しいファイルを始める頁の位置（小さい順。先頭の 0 は含めない）
 */
export function suggestSplits(items, candidates, limits) {
  const count = items.length;
  const sums = [0];
  for (const item of items) sums.push(sums.at(-1) + item.bytes);
  const fits = (start, end) => !overLimit(end - start, sums[end] - sums[start], limits);
  if (fits(0, count)) return [];
  const hasBody = hasBodyPages(items);

  // best[end]: 頁 0〜end-1 を分けたときの、いちばん少ない手間と、そのときの
  // いちばん大きなファイルの大きさ、最後のファイルの始まり。
  const best = [{ cost: 0, largest: 0, from: null }];
  for (let end = 1; end <= count; end++) {
    let chosen = null;
    for (let start = end - 1; start >= 0; start--) {
      if (!fits(start, end)) break;
      const before = best[start];
      const cost = before.cost + (start === 0 ? 0 : PART_COST + breakCost(items, candidates, start, hasBody));
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
 *
 * @param {string} name 1 冊ぶんの名前（.pdf 付き）
 * @param {number} index 何番目か（0 から）
 * @param {number} count いくつに分けるか
 */
export function partFileName(name, index, count) {
  if (count <= 1) return name;
  const stem = name.replace(/\.pdf$/i, '');
  return `${stem}_${String(index + 1).padStart(String(count).length, '0')}.pdf`;
}

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
