// 分ける位置を学んで判定するための、頁ごとの特徴（区切りの判定の手掛かりを数にしたもの）。
//
// 分ける位置の候補（split.js）は、見出し・柱・目次などの手掛かりの点数を手で決めた表で
// 足している。本のレイアウトはさまざまなので、手で直した分け方を正解として、これらの
// 特徴から区切りらしさを学ばせる（軽い分類器。この端末の中だけで動かす）。ここでは、
// 頁ごとの特徴を数にまとめ、学ぶためのデータとして書き出せる形にする。
//
// DOM には触らない（テストで縛るため）。

import { MARGIN_ZONE } from './page-numbers.js';
import { headingRank, RANKS } from './split.js';

/**
 * 学ぶためのデータの形の版（特徴を足したり変えたり、残す文字を変えたりしたら上げる）。
 * 3: 頁の元の文字（余白の帯の行と大きな字の行。sourceLines）を残す。
 */
export const FEATURE_VERSION = 3;

/** 余白の帯の外から残す、大きな字の行の数。 */
const LARGE_LINES = 6;

/** 残す行の文字の長さの上限。 */
const LINE_TEXT = 80;

/**
 * 区切りの判定の特徴を、あとから求め直せるように残す頁の元の文字（OCR の読み違いも
 * そのまま）。上下の余白の帯の行（柱・頁番号）と、帯の外の大きな字の行（見出し・扉の題）
 * だけで、本文の行は残さない。
 *
 * @param {{text:string, x0:number, x1:number, y:number, h:number}[]} lines 頁の文字を行にまとめたもの
 * @returns {{median:number, lines:{text:string, x0:number, x1:number, y:number, h:number}[]}}
 *   median: 行の高さの中央値（字の大きさを比べるため）。lines は上から順
 */
export function sourceLines(lines) {
  const heights = lines.map((line) => line.h).sort((a, b) => a - b);
  const median = heights.length ? heights[Math.floor((heights.length - 1) / 2)] : 0;
  const band = (line) => line.y < MARGIN_ZONE || line.y > 1 - MARGIN_ZONE;
  const large = lines
    .filter((line) => !band(line) && line.h > median)
    .sort((a, b) => b.h - a.h)
    .slice(0, LARGE_LINES);
  const kept = lines.filter((line) => band(line) || large.includes(line));
  return {
    median: round(median),
    lines: kept.map((line) => ({
      text: line.text.slice(0, LINE_TEXT),
      x0: round(line.x0),
      x1: round(line.x1),
      y: round(line.y),
      h: round(line.h),
    })),
  };
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
 * @returns {{lines:number, chars:number, scale:number, largestY:number|null, centered:boolean, largest:string}}
 *   scale: いちばん大きな字の行の高さと、行の高さの中央値の比（行が無ければ 0）
 */
export function pageLayout(lines) {
  const chars = lines.reduce((sum, line) => sum + line.text.replace(/\s/g, '').length, 0);
  if (!lines.length) return { lines: 0, chars, scale: 0, largestY: null, centered: false, largest: '' };
  const heights = lines.map((line) => line.h).sort((a, b) => a - b);
  const median = heights[Math.floor((heights.length - 1) / 2)];
  const largest = lines.reduce((best, line) => (line.h > best.h ? line : best));
  const middle = (largest.x0 + largest.x1) / 2;
  return {
    lines: lines.length,
    chars,
    scale: round(median > 0 ? largest.h / median : 0),
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
