// 分ける位置を学んで判定するための、頁ごとの特徴と分類器（多クラスのロジスティック回帰）。
//
// 本のレイアウトはさまざまなので、「第N章」のような決まった言葉や、手で決めた境目には
// 頼らず、頁の文字のかたまり（OCR の読み違いもそのまま）から測った数（字の大きさの比・
// 位置・番号らしい形の段の数・柱の変わり方など）を特徴にし、その重みを正解から学ぶ。
// 学ぶのは「頁の頭からどの深さの単位が始まるか」と「頁の途中からどの深さの単位が
// 始まるか」の 2 つ（structure.js の pageTargets）。重みは scripts/train-split-model.mjs で
// 求め、split-model.json に書く（判定はこの端末の中だけで動く）。
//
// DOM には触らない（テストと学習のスクリプトで使うため）。

import { groupLines } from './page-numbers.js';

/** 頁の上下の余白の帯（柱・頁番号）とみなす高さ（頁の高さに対する割合）。 */
const BAND = 0.075;

/** 番号らしい形（頭の 8 字までの言葉と、点・ハイフンで続く数）。言葉そのものは見ない。 */
const NUMBERING = /^\s*[^\s\d]{0,8}?\s*([0-9０-９]+(?:\s*[.．\-−－‐ー一]\s*[0-9０-９]+)*)/;

/** 本文の脇の行番号（5 の倍数）が行の頭に付いたもの。 */
const MARGIN_LINE_NUMBER = /^\s*(?:[1-9]?[05])\s+(?=\S)/;

/** 本の中で比べる頁の数（柱の変わり方・前後の頁）。 */
const CONTEXT = 3;

/**
 * 番号らしい形の段の数（「6.2.1 …」は 3、「第6 章 …」は 1、無ければ 0）。行の頭から
 * 8 字までに数が無ければ 0。
 */
export function numberingDepth(text) {
  return numberingParts(text).length;
}

/** 番号らしい形の数の並び（「6. 2.1 …」は ['6', '2', '1']。4 段まで。無ければ空）。 */
function numberingParts(text) {
  // 行の頭の、本文の脇の行番号（5・10・15…）は除く（「10 3. 1 基礎」の 10）。
  const found = text.replace(MARGIN_LINE_NUMBER, '').match(NUMBERING);
  if (!found) return [];
  return found[1]
    .split(/[.．\-−－‐ー一]/)
    .map((part) => part.replace(/\s/g, '').replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)))
    .filter((part) => /\d/.test(part))
    .slice(0, 4);
}

/** 柱の中の番号らしい形（2 段以上のもの。頁番号だけの数は除く）を、つないだ文字列の集まり。 */
function headNumbers(head) {
  const set = new Set();
  // 語に分ける（数のあとの空白は、番号の続き——「6. 2」——のことがあるので分けない。後読みは
  // iOS 16.3 以前の Safari が読めないので使わない）。
  for (const word of head.split(/\s+(?=[^\s\d])/)) {
    const parts = numberingParts(word);
    if (parts.length >= 2) set.add(parts.join('.'));
  }
  return set;
}

/** 文字の 2 字ずつの組（柱の文字の似ている度合いを比べる）。 */
function bigrams(text) {
  const plain = text.replace(/[\s\d０-９]/g, '');
  const set = new Set();
  for (let k = 0; k + 1 < plain.length; k++) set.add(plain.slice(k, k + 2));
  return set;
}

/** 2 字ずつの組の重なり（Jaccard 係数。どちらも空でないものを比べる）。 */
function similarity(a, b) {
  let common = 0;
  for (const gram of a) if (b.has(gram)) common++;
  return common / (a.size + b.size - common);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((x, y) => x - y);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * 頁ごとに測った数（特徴を組み立てる元）。
 *
 * @param {{items:Array<[string, number, number, number, number]>, bytes:number, label:string}[]} pages
 *   学習データの頁（items は [文字, x0, x1, y, h]。座標は頁の幅・高さに対する割合）
 */
export function measurePages(pages) {
  const lines = pages.map((page) =>
    groupLines(page.items.map(([text, x0, x1, y, h]) => ({ text, x0, x1, y, h })))
  );
  const body = lines.map((ls) => ls.filter((line) => line.y > BAND && line.y < 1 - BAND));
  // 本の本文の字の高さ（頁ごとの行の高さの中央値の、さらに中央値）。
  const typical = median(body.map((ls) => median(ls.map((line) => line.h))).filter((h) => h > 0)) || 0.01;
  const typicalBytes = median(pages.map((page) => page.bytes).filter((bytes) => bytes > 0)) || 1;
  return pages.map((page, index) => {
    const ls = body[index];
    const chars = ls.reduce((sum, line) => sum + line.text.replace(/\s/g, '').length, 0);
    const largest = ls.reduce((best, line) => (line.h > (best?.h ?? 0) ? line : best), null);
    const first = ls.find((line) => line.text.replace(/[^\p{L}\p{N}]/gu, '').length > 1) ?? null;
    // 見出しらしい行: 短く、番号らしい形で始まる行。いちばん浅い段と、その高さ・位置。
    const numbered = ls.filter((line) => line.text.length <= 60 && numberingDepth(line.text) > 0);
    const shallowest = numbered.reduce((best, line) => {
      const depth = numberingDepth(line.text);
      return !best || depth < best.depth ? { depth, line } : best;
    }, null);
    const head = lines[index].filter((line) => line.y <= BAND).map((line) => line.text).join(' ');
    const number = Number(page.label.match(/^-?\d+/)?.[0] ?? NaN);
    return {
      blank: chars < 8 ? 1 : 0,
      lines: Math.log1p(ls.length),
      chars: Math.log1p(chars),
      largest: largest ? largest.h / typical : 0,
      largestY: largest ? largest.y : 1,
      centered: largest && Math.abs((largest.x0 + largest.x1) / 2 - 0.5) < 0.1 ? 1 : 0,
      firstHeight: first ? first.h / typical : 0,
      firstY: first ? first.y : 1,
      firstDepth: first ? numberingDepth(first.text) : 0,
      firstShort: first && first.text.length <= 40 ? 1 : 0,
      numberedLines: Math.log1p(numbered.length),
      shallowestDepth: shallowest ? shallowest.depth : 0,
      shallowestHeight: shallowest ? shallowest.line.h / typical : 0,
      shallowestY: shallowest ? shallowest.line.y : 1,
      headDepth: numberingDepth(head.replace(/^\s*\d+\s+/, '')),
      // 柱の番号（頁番号を除いた、柱の中の番号らしい形）。章・節が変わると変わる。
      headNumber: headNumbers(head),
      headGrams: bigrams(head),
      front: /^(?:前付|表紙)/.test(page.label) ? 1 : 0,
      number,
      bytes: Math.log((page.bytes || typicalBytes) / typicalBytes),
    };
  });
}

/** 特徴の名前（重みの並びと同じ順）。 */
export const FEATURE_NAMES = [
  'blank',
  'lines',
  'chars',
  'largest',
  'largestY',
  'centered',
  'firstHeight',
  'firstY',
  'firstDepth1',
  'firstDepth2',
  'firstDepth3',
  'firstShort',
  'numberedLines',
  'shallowest1',
  'shallowest2',
  'shallowest3',
  'shallowestHeight',
  'shallowestY',
  'headDepth',
  'headChange',
  'headEmpty',
  'front',
  'numberRestart',
  'bytes',
  'prevBlank',
  'prevLargest',
  'prevChars',
  'nextFirstDepth',
  'nextFirstHeight',
  'nextHeadChange',
  'headNumberNew',
  'nextHeadNumberNew',
];

/** 柱の番号が、前の柱のある頁（CONTEXT まで）に無い番号に変わったか（0 か 1）。 */
function headNumberNew(measures, index) {
  const own = measures[index].headNumber;
  if (!own.size) return 0;
  for (let k = index - 1; k >= Math.max(0, index - CONTEXT); k--) {
    for (const number of own) if (measures[k].headNumber.has(number)) return 0;
  }
  return 1;
}

/** 前の柱のある頁（CONTEXT まで）の柱との似ている度合いから、柱の変わり目らしさ（0〜1）。 */
function headChange(measures, index) {
  const own = measures[index].headGrams;
  if (!own.size) return 0;
  let best = null;
  for (let k = index - 1; k >= Math.max(0, index - CONTEXT); k--) {
    if (!measures[k].headGrams.size) continue;
    best = Math.max(best ?? 0, similarity(own, measures[k].headGrams));
  }
  return best === null ? 0 : 1 - best;
}

/**
 * 頁ごとの特徴（FEATURE_NAMES の順の数の並び）。前後の頁の特徴の一部も入れる（扉の次の頁、
 * 白紙の次の頁など）。
 *
 * @param {Parameters<typeof measurePages>[0]} pages
 * @returns {number[][]}
 */
export function featureVectors(pages) {
  const measures = measurePages(pages);
  const changes = measures.map((_, index) => headChange(measures, index));
  const numbersNew = measures.map((_, index) => headNumberNew(measures, index));
  let lastNumber = null;
  return measures.map((m, index) => {
    const prev = measures[index - 1];
    const next = measures[index + 1];
    const restart = Number.isFinite(m.number) && lastNumber !== null && m.number < lastNumber ? 1 : 0;
    if (Number.isFinite(m.number)) lastNumber = m.number;
    const depthIs = (depth, value) => (value === depth ? 1 : 0);
    return [
      m.blank,
      m.lines,
      m.chars,
      m.largest,
      m.largestY,
      m.centered,
      m.firstHeight,
      m.firstY,
      depthIs(1, m.firstDepth),
      depthIs(2, m.firstDepth),
      m.firstDepth >= 3 ? 1 : 0,
      m.firstShort,
      m.numberedLines,
      depthIs(1, m.shallowestDepth),
      depthIs(2, m.shallowestDepth),
      m.shallowestDepth >= 3 ? 1 : 0,
      m.shallowestHeight,
      m.shallowestY,
      m.headDepth,
      changes[index],
      m.headGrams.size ? 0 : 1,
      m.front,
      restart,
      m.bytes,
      prev ? prev.blank : 1,
      prev ? prev.largest : 0,
      prev ? prev.chars : 0,
      next ? next.firstDepth : 0,
      next ? next.firstHeight : 0,
      next ? changes[index + 1] : 0,
      numbersNew[index],
      next ? numbersNew[index + 1] : 0,
    ];
  });
}

/**
 * 多クラスのロジスティック回帰を学ぶ（特徴は平均と標準偏差でそろえる。少ないクラスは
 * 重みを付けて数を釣り合わせる。L2 の正則化）。
 *
 * @param {number[][]} rows 特徴
 * @param {number[]} labels クラス（0 から classes - 1）
 * @param {number} classes
 * @param {{epochs?:number, rate?:number, l2?:number}} [options]
 * @returns {{mean:number[], scale:number[], weights:number[][]}} weights はクラスごとの [切片, 重み…]
 */
export function trainSoftmax(rows, labels, classes, { epochs = 400, rate = 0.5, l2 = 0.01 } = {}) {
  const width = rows[0].length;
  const mean = Array.from({ length: width }, (_, j) => rows.reduce((sum, row) => sum + row[j], 0) / rows.length);
  const scale = mean.map((m, j) => Math.sqrt(rows.reduce((sum, row) => sum + (row[j] - m) ** 2, 0) / rows.length) || 1);
  const xs = rows.map((row) => [1, ...row.map((value, j) => (value - mean[j]) / scale[j])]);
  const counts = Array.from({ length: classes }, (_, c) => labels.filter((label) => label === c).length);
  const present = counts.filter((count) => count > 0).length;
  // 少ないクラスの重み（数をそろえる重みの平方根。そろえきると、区切りでない頁も区切りとしすぎる）。
  const classWeight = counts.map((count) => (count ? Math.sqrt(rows.length / (present * count)) : 0));
  const weights = Array.from({ length: classes }, () => new Array(width + 1).fill(0));
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradient = weights.map((row) => row.map(() => 0));
    let total = 0;
    xs.forEach((x, i) => {
      const probs = softmax(weights.map((w) => dot(w, x)));
      const weight = classWeight[labels[i]];
      total += weight;
      probs.forEach((p, c) => {
        const error = (p - (c === labels[i] ? 1 : 0)) * weight;
        for (let j = 0; j <= width; j++) gradient[c][j] += error * x[j];
      });
    });
    weights.forEach((w, c) => {
      for (let j = 0; j <= width; j++) w[j] -= rate * (gradient[c][j] / total + (j ? l2 * w[j] : 0));
    });
  }
  return { mean, scale, weights };
}

/** 学んだ重みで、頁ごとのクラスの確からしさを求める。 */
export function predictSoftmax(model, rows) {
  return rows.map((row) => {
    const x = [1, ...row.map((value, j) => (value - model.mean[j]) / model.scale[j])];
    return softmax(model.weights.map((w) => dot(w, x)));
  });
}

function dot(a, b) {
  let sum = 0;
  for (let j = 0; j < a.length; j++) sum += a[j] * b[j];
  return sum;
}

function softmax(scores) {
  const top = Math.max(...scores);
  const exps = scores.map((score) => Math.exp(score - top));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return exps.map((value) => value / total);
}

/** 確からしさのいちばん高いクラス。 */
export function argmax(probs) {
  return probs.reduce((best, p, c) => (p > probs[best] ? c : best), 0);
}
