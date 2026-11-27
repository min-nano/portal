// PDF 結合ツール: 前付けのローマ数字の頁番号（i, ii, iii …）。
//
// 前付けはローマ数字で頁番号を刷ることが多い。読み取り（文字情報・OCR）から、ファイルの中の
// 並びの推定、1 冊の並び（本文より前）、並びの確かめ、頁ラベル、一覧の見出しまでを縛る。

import { describe, expect, it } from 'vitest';
import {
  arrangeBook,
  checkSequence,
  compressRanges,
  numberFiles,
  pageLabelRanges,
  pageLabelTexts,
  ROMAN_PART,
} from '../src/pdf-book-merger/ordering.js';
import {
  detectStep,
  formatNumber,
  inferFileNumbers,
  mergeCandidates,
  normalizeRoman,
  numberingSequence,
  numberText,
  pageNumberCandidates,
  pageNumberText,
  parsePageNumber,
  parseRoman,
  readMargin,
  stripPageNumber,
} from '../src/pdf-book-merger/page-numbers.js';
import { displayLabel, gridItems, missingLabel, pageIssues } from '../src/pdf-book-merger/review.js';

/** 頁に対する割合で置いた文字の断片。 */
function item(text, { x = 0.5, y = 0.95, h = 0.012, w = 0.02 } = {}) {
  return { text, x0: x - w / 2, x1: x + w / 2, y, h };
}

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8 };

/** 頁の候補。'ii' はローマ数字、12 は数字、'1-3' はハイフンで区切った番号、null は読めない頁。 */
function read(value) {
  if (value === null) return [];
  const c = { score: 3.5, source: 'text', zone: 'bottom' };
  if (ROMAN[value]) return [{ path: [ROMAN[value]], roman: true, ...c }];
  return [{ path: String(value).split('-').map(Number), ...c }];
}

function file(key, values, extra = {}) {
  return {
    key,
    role: 'body',
    manual: null,
    ...extra,
    pages: values.map((value, index) => ({ key: `${key}:${index}`, candidates: read(value) })),
  };
}

function arrange(files, overrides = new Map()) {
  const numberings = numberFiles(files, overrides);
  return { numberings, ...arrangeBook(files, numberings, overrides) };
}

const labels = (order) => order.map((entry) => pageNumberText(entry));

describe('ローマ数字の読み取り', () => {
  it('番号だけの行のローマ数字を、ローマ数字の候補として拾う', () => {
    for (const [text, value] of [
      ['ii', 2],
      ['- iv -', 4],
      ['(xiv)', 14],
      ['XIV', 14],
      ['Xiv', 14], // OCR は x と X を取り違える
      ['ⅱ', 2], // 1 字で 1 つの数を表すローマ数字
      ['Ⅻ', 12],
      ['ｖｉ', 6], // 全角の英字
      ['cccxcix', 399],
    ]) {
      expect(pageNumberCandidates([item(text)])).toEqual([
        { path: [value], roman: true, score: expect.any(Number), source: 'text', zone: 'bottom' },
      ]);
    }
  });

  it('正しい書き方でないもの・l と c の 1 字だけ・上限を超えるものは拾わない', () => {
    for (const text of ['iiii', 'vv', 'il', 'C', 'cd', 'ivx', 'page']) {
      expect(pageNumberCandidates([item(text)])).toEqual([]);
    }
  });

  it('I・II・l・ll は、1・11 の読み違いかもしれないので数字の候補も挙げる', () => {
    const read = (text) => pageNumberCandidates([item(text)]).map((c) => `${c.roman ? 'r' : ''}${c.path[0]}`);
    expect(read('I')).toEqual(['r1', '1']);
    expect(read('II')).toEqual(['r2', '11']);
    expect(read('l')).toEqual(['1']);
    expect(read('ll')).toEqual(['11']);
    expect(read('ii')).toEqual(['r2']); // 小文字の i は点があるので、1 とは取り違えない
  });

  it('OCR が 11 を II と読んでも、並びに合う数字の 11 として読む', () => {
    const ocr = (text) => pageNumberCandidates([item(text)], 'ocr');
    const { pages } = inferFileNumbers([ocr('9'), ocr('10'), ocr('II'), ocr('12')]);
    expect(pages[2]).toMatchObject({ number: 11, status: 'detected' });
    expect(pages[2].roman).toBeUndefined();
  });

  it('同じ値の数字とローマ数字は、別の候補として残す', () => {
    const candidates = pageNumberCandidates([item('ii', { y: 0.95 }), item('2', { y: 0.03 })]);
    expect(candidates.map((c) => [c.path[0], Boolean(c.roman)])).toEqual(
      expect.arrayContaining([
        [2, true],
        [2, false],
      ])
    );
    const ocr = [{ path: [2], roman: true, score: 4, source: 'ocr', zone: 'bottom' }];
    expect(mergeCandidates(candidates, ocr)).toHaveLength(2);
  });

  it('ローマ数字の v・x は、行番号の列にあっても行番号とみなさない', () => {
    // 5 行おきの行番号の列のすぐ下の「x」（10）。
    const items = [item('5', { x: 0.05, y: 0.8 }), item('x', { x: 0.05, y: 0.9 })];
    expect(pageNumberCandidates(items)).toEqual([expect.objectContaining({ path: [10], roman: true })]);
  });

  it('ローマ数字だけの行は柱にしない', () => {
    const { heads } = readMargin([item('ii', { y: 0.95 }), item('まえがき', { y: 0.03, w: 0.2 })]);
    expect(heads).toEqual(['まえがき']);
  });

  it('ローマ数字の頁は、柱から番号を落とさない（空白だけ詰める）', () => {
    expect(stripPageNumber('まえがき 2', { number: 2, roman: true })).toBe('まえがき2');
  });

  it('ローマ数字を読む・書く', () => {
    expect(parseRoman('xlix')).toBe(49);
    expect(parseRoman('IIII')).toBeNull();
    expect(parseRoman('cd')).toBeNull(); // 400 は上限を超える
    expect(normalizeRoman('Ⅰ・ⅳ・ＸＩＶ・ａ')).toBe('I・iv・XIV・a');
  });

  it('手で入れたローマ数字も読み、入れたとおりに書き戻す', () => {
    expect(parsePageNumber('ii')).toEqual({ path: [2], roman: true });
    expect(parsePageNumber('Ⅳ')).toEqual({ path: [4], roman: true });
    expect(parsePageNumber('iiii')).toBeNull();
    expect(numberText({ path: [4], roman: true })).toBe('iv');
    expect(numberText({ path: [57, 1] })).toBe('57-1');
  });

  it('番号の書き方（i より前に推定した頁は「前付」）', () => {
    expect(formatNumber(6, null, null, true)).toBe('vi');
    expect(formatNumber(0, null, null, true)).toBe('前付(0)');
    expect(pageNumberText({ number: 3, roman: true })).toBe('iii');
    expect(pageNumberText({ number: -1, roman: true })).toBe('前付-1');
  });
});

describe('ファイルの中の並び', () => {
  it('ローマ数字の並びと数字の並びを別に推定する（vi の次の 1 は飛びではなく別の並び）', () => {
    const { step, pages } = inferFileNumbers([null, 'i', 'ii', null, 'iv', 'v', 'vi', 1, 2, null, 4].map(read));
    expect(step).toBe(1);
    expect(pages.map((page) => pageNumberText(page))).toEqual(['前付0', 'i', 'ii', 'iii', 'iv', 'v', 'vi', '1', '2', '3', '4']);
    expect(pages.map((page) => page.status)).toEqual([
      'inferred', 'detected', 'detected', 'inferred', 'detected', 'detected', 'detected',
      'detected', 'detected', 'inferred', 'detected',
    ]);
  });

  it('隣の頁と同じ値のローマ数字（部の見出しのしるし）は、頁番号の候補にしない', () => {
    // 第 2 部の頁の柱に「Ⅱ」。番号の読めなかった頁も、食い違いにせず前後から補う。
    const mark = (value) => [...read(value), { path: [2], roman: true, score: 3.5, source: 'text', zone: 'top' }];
    const { pages } = inferFileNumbers([mark(1), mark(2), mark(null), mark(4)]);
    expect(pages.map((page) => [page.number, page.status])).toEqual([
      [1, 'detected'],
      [2, 'detected'],
      [3, 'inferred'],
      [4, 'detected'],
    ]);
  });

  it('ii と 3 は、並びの歩幅の手掛かりにしない', () => {
    expect(detectStep([read('ii'), read(3)])).toEqual({ step: null, votes: 0 });
  });

  it('部の番号を刷った本でも、ローマ数字の頁は段の足りない番号とみなさない', () => {
    const { pages } = inferFileNumbers(['ii', 'iii', 'iv', '1-1', '1-2', '1-3'].map(read));
    expect(pages.map((page) => pageNumberText(page))).toEqual(['ii', 'iii', 'iv', '1-1', '1-2', '1-3']);
    expect(pages.slice(0, 3).every((page) => page.status === 'detected' && page.roman)).toBe(true);
  });

  it('並びに合わないローマ数字は、食い違いとして読んだとおりに出す', () => {
    const { pages } = inferFileNumbers([1, 2, 'vii', 4, 5].map(read));
    expect(pages[2]).toMatchObject({ number: 3, status: 'conflict', read: { path: [7], roman: true } });
    expect(pages[2].roman).toBeUndefined();
  });

  it('手で入れたローマ数字の番号から、残りの頁を推定する（同じ値の数字の読みは「読めた」に数えない）', () => {
    const candidates = [[], read(2), [], []];
    const { pages } = inferFileNumbers(candidates, { step: 1, fixed: [null, { path: [2], roman: true }, null, null] });
    expect(pages.map((page) => pageNumberText(page))).toEqual(['i', 'ii', 'iii', 'iv']);
    expect(pages[1]).toMatchObject({ status: 'manual', read: null });
    const same = inferFileNumbers([[], read('ii'), [], []], { step: 1, fixed: [null, { path: [2], roman: true }, null, null] });
    expect(same.pages[1].read).toMatchObject({ path: [2], roman: true });
  });

  it('ローマ数字が 1 頁だけ読めたファイルは、その頁だけをローマ数字にする', () => {
    const { step, pages } = inferFileNumbers([[], read('iii'), []]);
    expect(step).toBeNull();
    expect(pages[1]).toMatchObject({ number: 3, roman: true, status: 'detected' });
  });

  it('ファイルの一覧の要約は、ローマ数字の並びと数字の並びを分けて書く', () => {
    const numbering = inferFileNumbers(['i', 'ii', 'iii', 1, 2].map(read));
    expect(numberingSequence(numbering)).toBe('i, ii, iii, 1, 2');
  });
});

describe('1 冊の並び', () => {
  it('ローマ数字の頁は、部とは別のまとまりとして本文より前に並べる（部に分けない）', () => {
    // 奇数頁の束と、裏返した偶数頁の束。前付けは i〜vi、本文は 1〜6。
    const files = [file('odd', [null, 'i', 'iii', 'v', 1, 3, 5]), file('even', [6, 4, 2, 'vi', 'iv', 'ii', null])];
    const { order, mismatch } = arrange(files);
    // i より前に推定した頁（扉）は、紙の表裏を数えない（前付-1・前付0 の表を求めない）。
    expect(labels(order)).toEqual(['前付-1', '前付0', 'i', 'ii', 'iii', 'iv', 'v', 'vi', '1', '2', '3', '4', '5', '6']);
    expect(order.map((entry) => entry.part)).toEqual([...Array(8).fill(ROMAN_PART), ...Array(6).fill(null)]);
    expect(mismatch).toBe(false);
    expect(checkSequence(order, { sheets: true })).toEqual([]);
    expect(pageLabelTexts(pageLabelRanges(order), order.length)).toEqual([
      '前付', '前付', 'i', 'ii', 'iii', 'iv', 'v', 'vi', '1', '2', '3', '4', '5', '6',
    ]);
  });

  it('i より前に推定した頁が偶数でも、紙の表を求めない', () => {
    const { order } = arrange([file('a', [null, 'i', 'ii', 'iii', 'iv', 1, 2, 3, 4])]);
    expect(labels(order).slice(0, 2)).toEqual(['前付0', 'i']);
    expect(checkSequence(order, { sheets: true })).toEqual([]);
  });

  it('前付けのまとまりは部と数えない（部の番号の知らせに前付けを入れず、項目の見分けも分ける）', () => {
    const files = [file('a', ['i', 'ii', 'iii', '1-1', '1-2']), file('b', ['2-1', '2-2']), file('c', ['v'])];
    const { order } = arrange(files);
    // 前付けの後ろの 1-1, 1-2 は、枝番の頁ではなく「1-」の頁。
    expect(labels(order)).toEqual(['i', 'ii', 'iii', 'v', '1-1', '1-2', '2-1', '2-2']);
    const problems = checkSequence(order);
    const depth = problems.find((problem) => problem.kind === 'depth');
    expect(depth.message).toContain('（1-1〜1-2 頁・2-1〜2-2 頁）');
    expect(problems.find((problem) => problem.kind === 'missing')).toMatchObject({ number: 'roman' });
    // 部が 1 つなら、本文の項目は部を入れずに見分ける（前付けがあっても）。
    const single = checkSequence(arrange([file('a', ['i', 'iii', 1, 3])]).order);
    expect(single.filter((problem) => problem.kind === 'missing').map((problem) => [problem.message, problem.number])).toEqual([
      ['ii 頁が見つかりません（計 1 頁）。束の入れ忘れ・重送の可能性があります。', 'roman'],
      ['2 頁が見つかりません（計 1 頁）。束の入れ忘れ・重送の可能性があります。', undefined],
    ]);
  });

  it('ローマ数字の頁だけのファイルも並べる', () => {
    const { order } = arrange([file('front', ['i', 'ii', 'iii']), file('body', [1, 2, 3])]);
    expect(labels(order)).toEqual(['i', 'ii', 'iii', '1', '2', '3']);
  });

  it('部の番号を刷った本の前付けは、ローマ数字のまま。その後ろの番号の無い頁は「0-」の頁', () => {
    const files = [file('a', ['i', 'ii', 'iii', null, '1-1', '1-2', '1-3']), file('b', ['2-1', '2-2'])];
    const { order } = arrange(files);
    expect(labels(order)).toEqual(['i', 'ii', 'iii', '0-1', '1-1', '1-2', '1-3', '2-1', '2-2']);
  });

  it('前付けの束の要約にも、ローマ数字のまま出す', () => {
    const files = [file('a', ['i', 'ii', 'iii', 1, 2, 3])];
    const { numberings } = arrange(files);
    expect(numberingSequence(numberings.get('a'))).toBe('i, ii, iii, 1, 2, 3');
  });

  it('ファイルごとに番号を決めたファイルでも、頁ごとに入れたローマ数字はその頁だけ（前の段を付けない）', () => {
    const files = [file('a', [null, null, null, null], { manual: { start: 1, step: 1, prefix: [2] } })];
    const overrides = new Map([['a:0', { path: [3], roman: true }]]);
    const { order } = arrange(files, overrides);
    expect(labels(order)).toEqual(['iii', '2-2', '2-3', '2-4']);
    expect(order[0].prefix).toBeUndefined();
  });

  it('ローマ数字の頁の抜け・重なり・紙の表裏を、ローマ数字で指摘する', () => {
    const files = [file('a', ['ii', 'iii', 'iv']), file('b', ['viii']), file('c', ['iii']), file('d', [1, 2])];
    const { order } = arrange(files);
    const messages = checkSequence(order, { sheets: true }).map((problem) => problem.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'iii 頁が 2 回あります（同じ束を 2 度スキャンした・番号の読み違い）。',
        'v〜vii 頁が見つかりません（計 3 頁）。束の入れ忘れ・重送の可能性があります。',
        '最初の頁が偶数（ii 頁）です。その表（i 頁）が欠けていないか確かめてください。',
      ])
    );
  });

  it('頁ラベル: アラビア数字の前付けは、ローマ数字の頁の続きから数える', () => {
    const order = [
      { role: 'body', number: 1, roman: true, status: 'detected' },
      { role: 'body', number: 2, roman: true, status: 'detected' },
      { role: 'body', number: 0, status: 'inferred' },
      { role: 'body', number: 1, status: 'detected' },
    ];
    expect(pageLabelTexts(pageLabelRanges(order), order.length)).toEqual(['i', 'ii', 'iii', '1']);
  });

  it('抜けた番号をローマ数字の範囲で書く', () => {
    const roman = (n) => pageNumberText({ number: n, roman: true });
    expect(compressRanges([3, 4, 5, 9], '', roman)).toBe('iii〜v・ix');
  });
});

describe('一覧の見出しと指摘', () => {
  it('ローマ数字の頁の見出しと、抜けの札', () => {
    const { order } = arrange([file('a', ['i', 'ii', 'v', 'vi', 1, 2])]);
    expect(displayLabel(order[1])).toBe('ii 頁');
    const cards = gridItems(order).filter((entry) => entry.type === 'missing');
    expect(cards).toEqual([{ type: 'missing', from: 3, to: 3, part: ROMAN_PART, roman: true }, expect.anything()]);
    expect(cards.map(missingLabel)).toEqual(['iii 頁', 'iv 頁']);
    expect(missingLabel({ from: 3, to: 9, roman: true })).toBe('iii〜ix 頁');
  });

  it('並びに合わないローマ数字の読みは、読んだとおりのローマ数字で知らせる', () => {
    const { order } = arrange([file('a', [1, 2, 'vii', 4, 5])]);
    const issues = pageIssues(order, [], new Map());
    expect(issues.get('a:2')[0].message).toBe('読み取った番号（vii）が前後の並びと合いません');
  });
});
