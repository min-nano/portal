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
const BAND = 0.06;

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

/** 文字（数・記号を除く）の 2 字ずつの組（目次の項目の題と、本文の行を比べる）。 */
function letterGrams(text) {
  const plain = text.replace(/[^\p{L}]/gu, '');
  const set = new Set();
  for (let k = 0; k + 1 < plain.length; k++) set.add(plain.slice(k, k + 2));
  return set;
}

/** 2 字ずつの組の重なり（Dice 係数。どちらも空でないものを比べる——字が 2 つ以上ある題と行）。 */
function dice(a, b) {
  let common = 0;
  for (const gram of a) if (b.has(gram)) common++;
  return (2 * common) / (a.size + b.size);
}

/**
 * 目次の項目の形（題のあとに、点線か空白、P のあと、頁番号——「1-23」のような段のある
 * ものも——で終わる行）。題の最後は点線・空白でない字。
 */
const TOC_ENTRY = /^(.*?[^\s.．…・‥_－‐-])[\s.．…・‥_]*(?:[PpＰ]\.?\s*)?((?:\d{1,3}\s*[-－‐−]\s*)*\d{1,4})$/;

/** 目次とみなす、1 頁の項目の数の下限。 */
const TOC_MIN_ENTRIES = 3;

/** 目次とみなす、頁番号が前の項目から戻らない項目の割合の下限（本文の、数で終わる表の行と分ける）。 */
const TOC_ORDERED = 0.8;

/** 目次の項目の題と、本文の行の似ている度合いを比べる、本文の行の長さの上限。 */
const TOC_TITLE_LINE = 80;

/** 右の段だけの行を右の段とみなす、右の段の左端（行の中の字の位置から見積もったもの）からのずれの許し（頁の幅に対する割合）。 */
const TOC_COLUMN_SLACK = 0.05;

/**
 * 行の途中の、点線のあとの頁番号（2 段組の目次で、左の段の項目の終わり。そのあとに右の段の項目が続く）。
 * 終わりは空白か行の終わり（後読みは iOS 16.3 以前の Safari が読めないので、先読みだけ使う）。
 */
const TOC_LEADER_REF = /[.．…・‥]{2,}\s*(?:[PpＰ]\.?\s*)?(?:\d{1,3}\s*[-－‐−]\s*)*\d{1,4}(?=\s|$)/g;

/**
 * 頁の行のうち、目次の項目の形のもの（題・頁番号・左端の位置）。題に字が 2 つ以上あるもの。2 段組の
 * 目次の行（「項目 …… 12 項目 …… 34」）は、点線のあとの頁番号ごとに分け、左端の位置は行の中の字の
 * 位置で割り振り、読む順（左の段を上から下まで、次に右の段）に並べる。右の段だけの行は、右の段の
 * 左端より右にあれば右の段とする。
 *
 * @param {{text:string, x0:number, x1:number}[]} lines
 * @returns {{title:string, ref:string, x0:number, column:number}[]} column は段（0 が左）
 */
export function tocEntries(lines) {
  const pieces = lines.flatMap((line) => {
    const bounds = [];
    let start = 0;
    for (const found of line.text.matchAll(TOC_LEADER_REF)) {
      bounds.push([start, found.index + found[0].length]);
      start = found.index + found[0].length;
    }
    bounds.push([start, line.text.length]);
    return bounds.map(([from, to], index) => ({
      text: line.text.slice(from, to).trim(),
      index,
      x0: line.x0 + ((line.x1 - line.x0) * from) / line.text.length,
    }));
  });
  // 右の段だけの行（左の段の項目が前の行で終わっている）は、右の段の左端より右にあることで見分ける。
  const right = Math.min(...pieces.filter((piece) => piece.index > 0).map((piece) => piece.x0));
  const columns = [];
  for (const piece of pieces) {
    const found = piece.text.match(TOC_ENTRY);
    if (!found || found[1].replace(/[^\p{L}]/gu, '').length < 2) continue;
    const column = piece.index || (piece.x0 >= right - TOC_COLUMN_SLACK ? 1 : 0);
    (columns[column] ??= []).push({ title: found[1], ref: found[2].replace(/\s/g, '').replace(/[－‐−]/g, '-'), x0: piece.x0, column });
  }
  return columns.flat();
}

/** 頁番号の最後の段（「1-23」は 23）。 */
const lastNumber = (ref) => Number(ref.split('-').at(-1));

/** 頁番号の前の段（「1-23」は「1」。段の無いものは空）。 */
const refPrefix = (ref) => ref.split('-').slice(0, -1).join('-');

/** 目次の頁か（項目が多く、頁番号がおおむね前の項目から戻らない——段が変われば戻ってよい）。 */
function isToc(entries) {
  if (entries.length < TOC_MIN_ENTRIES) return false;
  let ordered = 0;
  for (let k = 1; k < entries.length; k++) {
    const [a, b] = [entries[k - 1].ref, entries[k].ref];
    if (lastNumber(b) >= lastNumber(a) || refPrefix(b) !== refPrefix(a)) ordered++;
  }
  return ordered >= (entries.length - 1) * TOC_ORDERED;
}

/**
 * 目次と本文の対応付け。目次の頁の項目ごとに、その頁番号の頁（目次の頁の次、または前の項目の頁から
 * 後ろで、いちばん近いもの。前の段の無い頁番号は、どの部の頁とも合う——部ごとに振り直す本では、
 * 後ろで最初に合う部の頁になる）を探し、その頁に手掛かりを残す: 項目が指すか・項目の数・項目の題と
 * いちばん似ている行（似ている度合い・高さの位置・頁の最初の行か）・項目の字下げの段（目次の中の
 * 左端の位置の、浅い順に 0, 1, 2）・項目の題の番号の段の数（本の目次の中でいちばん浅いものを 0 とする）。
 *
 * @param {{key:{number:number, full:string}|null}[]} keys 頁ごとの頁番号（full は前の段とつないだもの）
 * @param {{text:string, x0:number, y:number}[][]} body 頁ごとの本文の行
 */
function tocLinks(keys, body) {
  const links = body.map(() => ({ hit: 0, entries: 0, match: 0, matchY: 1, matchFirst: 0, indent: null, depth: null }));
  for (const [tocPage, lines] of body.entries()) {
    const entries = tocEntries(lines);
    if (!isToc(entries)) continue;
    // 字下げの段は、目次の段（2 段組の左右）ごとに数える。
    const indents = [];
    for (const entry of entries) (indents[entry.column] ??= new Set()).add(Math.round(entry.x0 * 50));
    const indentOf = (entry) => [...indents[entry.column]].sort((a, b) => a - b).indexOf(Math.round(entry.x0 * 50));
    // 目次の頁そのものは指さない（目次の頁の頁番号と同じ頁番号の項目——部の目次の 1 頁と、部の最初の 1 頁——で）。
    let from = tocPage + 1;
    for (const entry of entries) {
      const plain = !entry.ref.includes('-');
      const target = keys.findIndex(
        (key, page) =>
          page >= from &&
          key !== null &&
          (plain ? key.number === lastNumber(entry.ref) : key.full === entry.ref || key.full.endsWith(`-${entry.ref}`))
      );
      if (target < 0) continue;
      from = target;
      const link = links[target];
      link.hit = 1;
      link.entries++;
      link.indent = Math.min(link.indent ?? 2, indentOf(entry), 2);
      const depth = numberingDepth(entry.title);
      if (depth > 0) link.depth = Math.min(link.depth ?? depth, depth);
      const grams = letterGrams(entry.title);
      const content = body[target].filter((line) => line.text.replace(/[^\p{L}]/gu, '').length > 1);
      content.forEach((line, k) => {
        if (line.text.length > TOC_TITLE_LINE) return;
        const score = dice(grams, letterGrams(line.text));
        if (score <= link.match) return;
        link.match = score;
        link.matchY = line.y;
        link.matchFirst = k === 0 ? 1 : 0;
      });
    }
  }
  const shallowest = Math.min(...links.map((link) => link.depth ?? Infinity));
  return links.map((link) => ({ ...link, depth: link.depth === null ? null : link.depth - shallowest }));
}

/** 頁番号（前の段とつないだもの）。頁番号の構造（版 5 から）か、頁のラベルの頭の数から。 */
function pageKey(page) {
  const numbering = page.numbering;
  if (numbering && Number.isFinite(numbering.number)) {
    return { number: numbering.number, full: [...(numbering.prefix ?? []), numbering.number].join('-') };
  }
  const found = page.label.match(/^-?\d+(?:-\d+)*/);
  return found ? { number: lastNumber(found[0]), full: found[0] } : null;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((x, y) => x - y);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * 頁ごとに測った数（特徴を組み立てる元）。
 *
 * @param {{items:Array<[string, number, number, number, number]>, bytes:number, label:string,
 *   numbering?:{role:string, number:number|null, prefix:number[]|null, part:number|null}}[]} pages
 *   学習データの頁（items は [文字, x0, x1, y, h]。座標は頁の幅・高さに対する割合。numbering は
 *   頁番号の構造で、版 5 から）
 */
export function measurePages(pages) {
  const lines = pages.map((page) =>
    groupLines(page.items.map(([text, x0, x1, y, h]) => ({ text, x0, x1, y, h })))
  );
  const body = lines.map((ls) => ls.filter((line) => line.y > BAND && line.y < 1 - BAND));
  // 本の本文の字の高さ（頁ごとの行の高さの中央値の、さらに中央値）。
  const typical = median(body.map((ls) => median(ls.map((line) => line.h))).filter((h) => h > 0)) || 0.01;
  const typicalBytes = median(pages.map((page) => page.bytes).filter((bytes) => bytes > 0)) || 1;
  const styles = headingStyles(body, typical);
  const links = tocLinks(pages.map(pageKey), body);
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
    // 頁番号の構造（版 5 から。それより前は、頁のラベルの頭の数を頁番号とする）。
    const numbering = page.numbering;
    const number = numbering ? (numbering.number ?? NaN) : Number(page.label.match(/^-?\d+/)?.[0] ?? NaN);
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
      front: (numbering ? numbering.role === 'front' : /^(?:前付|表紙)/.test(page.label)) ? 1 : 0,
      // 何部目か・前の段（部・編・章などの番号）。変わるところは、本の番号の構造の区切り。
      part: numbering?.part ?? null,
      prefix: numbering?.prefix ? numbering.prefix.join('-') : null,
      number,
      bytes: Math.log((page.bytes || typicalBytes) / typicalBytes),
      ...styles[index],
      toc: links[index],
    };
  });
}

/** 目次の項目の形（点線か空白のあとの頁番号で終わる行）。 */
const TOC_LIKE = /(?:[.．…・]{2,}|\s)\d{1,4}$/;

/** 見出しの形の段の数の上限（これより下の段と、段の分からない形は、この数にする）。 */
const LEVELS = 5;

/** 見出しの形が順に進むとみなす、順に進んだ出現の割合の下限。 */
const SEQUENTIAL = 0.6;

/**
 * 本の中の見出しの形の繰り返し（決まった言葉に頼らず、その本の中から見出しの作りを読む）。
 * 見出しらしい行（短く、番号らしい形で始まるか、本文より大きな字の行）を、形——番号の前の
 * 言葉・番号の段の数・字の大きさ（本文に対する比。4 分の 1 刻み）——でまとめ、形ごとに、本の中で
 * 何度出るか、番号が前の同じ形の行から順に進むか（最後の段が 1 つ進むか、1 に戻る）、頁の最初の行として出るか、を数える。順に進む形を字の大きい順に並べ、その本の
 * 中での段（0 がいちばん上）とする。頁ごとに、最初の行の形と、いちばん上の段の行を返す。
 *
 * @param {{text:string, x0:number, y:number, h:number}[][]} body 頁ごとの本文の行
 * @param {number} typical 本文の字の高さ
 */
function headingStyles(body, typical) {
  const stats = new Map();
  const previous = new Map();
  const occurrences = body.map((ls) => {
    const first = ls.find((line) => line.text.replace(/[^\p{L}\p{N}]/gu, '').length > 1) ?? null;
    return ls
      // 目次の項目の形（頁番号で終わる行）は、見出しの並びを乱すので数えない。
      .filter((line) => line.text.length <= 60 && !TOC_LIKE.test(line.text))
      .flatMap((line) => {
        const parts = numberingParts(line.text);
        const height = Math.round((line.h / typical) * 4) / 4;
        if (!parts.length && height < 1.2) return [];
        const word = parts.length ? line.text.replace(MARGIN_LINE_NUMBER, '').match(/^\s*([^\d０-９]*)/)[1].trim() : '';
        const key = [word, parts.length, height].join('|');
        const numbers = parts.map(Number);
        const before = previous.get(key);
        const inSequence = parts.length > 0 && followsAfter(before, numbers);
        if (parts.length) previous.set(key, numbers);
        const stat = stats.get(key) ?? { count: 0, sequential: 0, first: 0, height, depth: parts.length };
        stat.count++;
        stat.sequential += inSequence ? 1 : 0;
        stat.first += line === first ? 1 : 0;
        stats.set(key, stat);
        return [{ key, line, inSequence, isFirst: line === first }];
      });
  });
  // 順に進む形（2 度以上出て、順に進む出現が多いもの）を、字の大きい順（同じなら段の浅い順）に並べる。
  const ordered = [...stats.entries()]
    .filter(([, stat]) => stat.count >= 2 && stat.sequential / stat.count >= SEQUENTIAL)
    .sort(([, a], [, b]) => b.height - a.height || a.depth - b.depth);
  const level = new Map(ordered.map(([key], rank) => [key, Math.min(rank, LEVELS)]));
  return occurrences.map((found) => {
    const first = found.find((occurrence) => occurrence.isFirst);
    const best = found.reduce((top, occurrence) => {
      const own = level.get(occurrence.key) ?? LEVELS;
      return own < (top ? (level.get(top.key) ?? LEVELS) : LEVELS + 1) ? occurrence : top;
    }, null);
    const stat = first ? stats.get(first.key) : null;
    return {
      firstStyleCount: stat ? Math.log1p(stat.count) : 0,
      firstStyleSequential: stat ? stat.sequential / stat.count : 0,
      firstInSequence: first?.inSequence ? 1 : 0,
      firstLevel: first ? (level.get(first.key) ?? LEVELS) : LEVELS,
      bestLevel: best ? (level.get(best.key) ?? LEVELS) : LEVELS,
      bestY: best ? best.line.y : 1,
      bestInSequence: best?.inSequence ? 1 : 0,
      bestIsFirst: best?.isFirst ? 1 : 0,
    };
  });
}

/**
 * 番号が、前の同じ形の番号から順に進んだか（前の段が同じで最後の段が 1 つ進むか、最後の段が
 * 1 に戻る——前の段が進んだか、章が変わって 01 に戻った）。前が無ければ、最後の段が 1 以下なら順。
 */
function followsAfter(before, numbers) {
  const last = numbers.at(-1);
  if (!before) return last <= 1;
  const head = numbers.slice(0, -1);
  const beforeHead = before.slice(0, -1);
  // 最後の段が 1 に戻るのは、前の段が進んだか、段が 1 つだけの番号（章が変わって 01 に戻る）とき。
  if (last === 1) return true;
  return head.every((part, k) => part === beforeHead[k]) && last === before.at(-1) + 1;
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
  'partChange',
  'prefixChange',
  'bytes',
  'prevBlank',
  'prevLargest',
  'prevChars',
  'nextFirstDepth',
  'nextFirstHeight',
  'nextHeadChange',
  'headNumberNew',
  'nextHeadNumberNew',
  'firstStyleCount',
  'firstStyleSequential',
  'firstInSequence',
  'firstLevel',
  'bestLevel',
  'bestY',
  'bestInSequence',
  'bestIsFirst',
  'tocHit',
  'tocEntries',
  'tocMatch',
  'tocMatchY',
  'tocMatchFirst',
  'tocIndent0',
  'tocIndent1',
  'tocDepth0',
  'tocDepth1',
  'tocDepth2',
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
  let lastPart = null;
  let lastPrefix = null;
  return measures.map((m, index) => {
    const prev = measures[index - 1];
    const next = measures[index + 1];
    const restart = Number.isFinite(m.number) && lastNumber !== null && m.number < lastNumber ? 1 : 0;
    if (Number.isFinite(m.number)) lastNumber = m.number;
    // 前の、部・前の段の分かる頁から変わったか（分からない頁は飛ばして比べる）。
    const partChange = m.part !== null && lastPart !== null && m.part !== lastPart ? 1 : 0;
    const prefixChange = m.prefix !== null && lastPrefix !== null && m.prefix !== lastPrefix ? 1 : 0;
    if (m.part !== null) lastPart = m.part;
    if (m.prefix !== null) lastPrefix = m.prefix;
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
      partChange,
      prefixChange,
      m.bytes,
      prev ? prev.blank : 1,
      prev ? prev.largest : 0,
      prev ? prev.chars : 0,
      next ? next.firstDepth : 0,
      next ? next.firstHeight : 0,
      next ? changes[index + 1] : 0,
      numbersNew[index],
      next ? numbersNew[index + 1] : 0,
      m.firstStyleCount,
      m.firstStyleSequential,
      m.firstInSequence,
      m.firstLevel,
      m.bestLevel,
      m.bestY,
      m.bestInSequence,
      m.bestIsFirst,
      m.toc.hit,
      Math.log1p(m.toc.entries),
      m.toc.match,
      m.toc.matchY,
      m.toc.matchFirst * m.toc.match,
      depthIs(0, m.toc.indent),
      depthIs(1, m.toc.indent),
      depthIs(0, m.toc.depth),
      depthIs(1, m.toc.depth),
      depthIs(2, m.toc.depth),
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

/** 本の中で学ぶときに、本をまたいで学んだ判定で区切りでないとみなす、区切りでない確からしさの下限。 */
const IN_BOOK_NEGATIVE = 0.5;

/** 本の中で学んだ判定で区切りとみなす、区切りでない確からしさの上限。 */
const IN_BOOK_POSITIVE = 0.05;

/** 本の中で学ぶ手本とする、目次の項目の題と頁の最初の行の似ている度合いの下限。 */
const IN_BOOK_MATCH = 0.5;

/** 本の中で学ぶのに要る、区切りの手本の数の下限。 */
const IN_BOOK_MIN_EXAMPLES = 3;

/**
 * 本の中で学び直す（その本の目次を手本にして、その本のレイアウトを読む）。本をまたいで学んだ判定は、
 * 見たことのないレイアウト（扉の作りなど）を読み違える。そこで、目次の項目が頁の最初の行の題を指す頁を、
 * その深さ（項目の題の番号の段、無ければ字下げの段に 1 を足したもの）の単位が頭から始まる手本、
 * 目次から指されず、本をまたいで学んだ判定で区切りでないとみなす頁を、区切りでない手本にして、
 * その本の頁の特徴（目次の特徴は除く。手本の選び方そのものなので）から分類器を学び、
 * (1) 手本の頁は区切りとし（深さは本をまたいで学んだ判定のもの、区切りでないとしていれば手本の深さ）、
 * (2) どちらの手本でもない頁（目次が頁の途中の行を指す頁も。目次の題の読み違いで頭の題と合わないことが
 * 多いので）は、本の中で学んだ判定で区切りと確かなら、その深さにする。
 * 手本が少なければ（区切りの手本が 3 つ未満、または区切りでない手本が無ければ）、そのまま返す。
 *
 * @param {Parameters<typeof measurePages>[0]} pages
 * @param {number[][]} rows featureVectors(pages)
 * @param {number[][]} probs 本をまたいで学んだ判定の、頁ごとの「頭から始まる単位の深さ」の確からしさ
 * @returns {number[]} 頁ごとの、頭から始まる単位の深さ（0 は無し）
 */
export function refineInBook(pages, rows, probs) {
  if (!probs.length) return [];
  const classes = probs[0].length;
  const top = probs.map(argmax);
  const measures = measurePages(pages);
  const examples = measures.map(({ toc }, page) => {
    if (toc.hit && toc.matchFirst && toc.match >= IN_BOOK_MATCH) return Math.min(classes - 1, (toc.depth ?? toc.indent) + 1);
    if (!toc.hit && probs[page][0] > IN_BOOK_NEGATIVE) return 0;
    return null;
  });
  const taught = examples.map((example, page) => (example === null ? -1 : page)).filter((page) => page >= 0);
  if (taught.filter((page) => examples[page] > 0).length < IN_BOOK_MIN_EXAMPLES || !taught.some((page) => examples[page] === 0)) {
    return top;
  }
  const columns = FEATURE_NAMES.map((name, j) => (name.startsWith('toc') ? -1 : j)).filter((j) => j >= 0);
  const pick = (row) => columns.map((j) => row[j]);
  const model = trainSoftmax(
    taught.map((page) => pick(rows[page])),
    taught.map((page) => examples[page]),
    classes,
    { epochs: 200 }
  );
  return predictSoftmax(model, rows.map(pick)).map((own, page) => {
    if (examples[page] > 0) return top[page] || examples[page];
    if (examples[page] === null && own[0] < IN_BOOK_POSITIVE) return argmax(own.map((p, c) => (c ? p : 0)));
    return top[page];
  });
}

/** 確からしさのいちばん高いクラス。 */
export function argmax(probs) {
  return probs.reduce((best, p, c) => (p > probs[best] ? c : best), 0);
}
