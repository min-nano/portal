// 分ける位置を学んで判定するための、頁ごとの特徴（区切りの判定の手掛かりを数にしたもの）。
//
// 分ける位置の候補（split.js）は、見出し・柱・目次などの手掛かりの点数を手で決めた表で
// 足している。本のレイアウトはさまざまなので、手で直した分け方を正解として、これらの
// 特徴から区切りらしさを学ばせる（軽い分類器。この端末の中だけで動かす）。ここでは、
// 頁ごとの特徴を数にまとめ、学ぶためのデータとして書き出せる形にする。
//
// DOM には触らない（テストで縛るため）。

import { headingRank, RANKS } from './split.js';

/**
 * 学ぶためのデータの形の版（特徴を足したり変えたり、残す文字を変えたりしたら上げる）。
 * 4: 頁のすべての文字のかたまり（rawItems）と、余白を OCR で読んだ文字の確信度を残す。
 */
export const FEATURE_VERSION = 4;

/** 文字のかたまり 1 つを残す形の項目の並び（JSON の itemFields に書く）。 */
export const ITEM_FIELDS = ['text', 'x0', 'x1', 'y', 'h'];

/**
 * 区切りの判定の特徴を、あとから求め直せるように残す頁の文字（PDF の文字情報のかたまり。
 * OCR の読み違いもそのまま。本文も含む）。行にまとめる前のもので、文字・左右の端・高さの
 * 中ほど・字の高さ（頁の幅・高さに対する割合）。何百頁ぶん持つので、かたまりごとに
 * [文字, x0, x1, y, h] の並び（ITEM_FIELDS の順。余白を OCR で読んだものは、後ろに確信度）にし、
 * 頁ごとに 1 つの文字列にしておく（JSON.parse で戻す）。
 *
 * @param {{text:string, x0:number, x1:number, y:number, h:number, confidence?:number}[]} items
 * @returns {string}
 */
export function rawItems(items) {
  return JSON.stringify(
    items.map((item) => [
      item.text,
      round4(item.x0),
      round4(item.x1),
      round4(item.y),
      round4(item.h),
      ...(item.confidence === undefined ? [] : [item.confidence]),
    ])
  );
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/** 白紙とみなす文字の数（頁番号や、ごみの点を読んだ数文字は白紙のうち）。 */
const BLANK_CHARS = 8;

/** 題として残す、いちばん大きな字の行の長さの上限。 */
const LARGEST_TEXT = 40;

/**
 * 頁のレイアウトの特徴（文字の行から）。章の扉は、行が少なく、大きな字の行が
 * 真ん中あたりにある。白紙は文字がほとんど無い。
 *
 * @param {{text:string, x0:number, x1:number, y:number, h:number}[]} lines 頁の文字を行にまとめたもの
 *   （x・y・h は頁の幅・高さに対する割合）
 * @returns {{lines:number, chars:number, scale:number, height:number, median:number, largestY:number|null,
 *   centered:boolean, largest:string}}
 *   scale: いちばん大きな字の行の高さと、行の高さの中央値の比（行が無ければ 0）
 */
export function pageLayout(lines) {
  const chars = lines.reduce((sum, line) => sum + line.text.replace(/\s/g, '').length, 0);
  if (!lines.length) {
    return { lines: 0, chars, scale: 0, height: 0, median: 0, largestY: null, centered: false, largest: '' };
  }
  const heights = lines.map((line) => line.h).sort((a, b) => a - b);
  const median = heights[Math.floor((heights.length - 1) / 2)];
  const largest = lines.reduce((best, line) => (line.h > best.h ? line : best));
  const middle = (largest.x0 + largest.x1) / 2;
  return {
    lines: lines.length,
    chars,
    scale: round(median > 0 ? largest.h / median : 0),
    // いちばん大きな字の行の高さと、行の高さの中央値（頁の高さに対する割合。本のほかの頁と比べる）。
    height: round4(largest.h),
    median: round4(median),
    largestY: round(largest.y),
    centered: Math.abs(middle - 0.5) < 0.1,
    largest: largest.text.slice(0, LARGEST_TEXT),
  };
}

/** 柱の変わり目の段を数にする（章 3・節 2・文字 1・無し 0）。 */
const RUNNING_LEVEL = { chapter: 3, section: 2, text: 1 };

/** 見出しの階層を数にする（部 3・章 2・節 1・無し 0）。 */
const HEADING_LEVEL = { [RANKS.part]: 3, [RANKS.chapter]: 2, [RANKS.section]: 1 };

/**
 * 並べた頁ごとの特徴（数の組）。その頁の前で分けるかを判定する手掛かり。前の頁の
 * 特徴（白紙の頁のあとか・頁番号がつながるか）も入れる。
 *
 * @param {{role:string, bytes:number, number?:number|null, outline?:string|null, heading?:string|null,
 *   toc?:string|null, layout?:ReturnType<typeof pageLayout>|null, fileKey:string}[]} items 並べた順の頁
 * @param {ReturnType<import('./split.js').breakCandidates>} candidates
 * @param {(number|null)[]} ranks breakRanks
 * @returns {Record<string, number>[]}
 */
export function pageFeatures(items, candidates, ranks) {
  // 頁の大きさは、本の頁の大きさの中央値との比で見る（スキャンの白紙は小さい）。
  const sizes = items.map((item) => item.bytes).sort((a, b) => a - b);
  const medianBytes = sizes[Math.floor((sizes.length - 1) / 2)] || 1;
  const layouts = items.map((item) => item.layout ?? pageLayout([]));
  const blank = (k) => k >= 0 && layouts[k].chars < BLANK_CHARS;
  let lastNumber = null;
  return items.map((item, index) => {
    const candidate = candidates[index];
    const layout = layouts[index];
    const before = lastNumber;
    if (Number.isFinite(item.number)) lastNumber = item.number;
    const heading = item.heading ? headingRank(item.heading) : null;
    return {
      position: round(items.length > 1 ? index / (items.length - 1) : 0),
      body: item.role === 'body' ? 1 : 0,
      fileStart: index > 0 && items[index - 1].fileKey !== item.fileKey ? 1 : 0,
      outline: item.outline ? 1 : 0,
      heading: heading === null ? 0 : HEADING_LEVEL[heading],
      toc: item.toc ? 1 : 0,
      running: RUNNING_LEVEL[candidate?.running] ?? 0,
      restart: candidate?.restart ? 1 : 0,
      opening: candidate?.opening ? 1 : 0,
      candidate: candidate ? 1 : 0,
      rank: ranks[index] ?? 6,
      numbered: Number.isFinite(item.number) ? 1 : 0,
      // 前の頁番号からの進み（番号が無ければ 0。1 なら続き、0 以下なら戻り）。
      step: Number.isFinite(item.number) && before !== null ? item.number - before : 0,
      lines: layout.lines,
      chars: layout.chars,
      scale: layout.scale,
      largestY: layout.largestY ?? 1,
      centered: layout.centered ? 1 : 0,
      blank: blank(index) ? 1 : 0,
      blankBefore: blank(index - 1) ? 1 : 0,
      bytes: round(item.bytes / medianBytes),
      bytesBefore: index > 0 ? round(items[index - 1].bytes / medianBytes) : 0,
    };
  });
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
