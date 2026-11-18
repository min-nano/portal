// PDF 結合ツール: 頁番号の読み取りと、ファイルの中での並びの推定。
//
// 裁断した本を分けてスキャンすると、1 ファイルの中では番号が一定の歩幅で
// 進む（奇数頁の束なら 2 つずつ、裏返した偶数頁の束なら 2 つずつ逆順）。
// その性質で、番号の刷られていない頁を補い、読み違えた頁を外れ値にできる
// ことを縛る。

import { describe, expect, it } from 'vitest';
import {
  detectStep,
  formatNumber,
  groupLines,
  inferFileNumbers,
  manualFileNumbers,
  mergeCandidates,
  normalizeDigits,
  numberingSequence,
  pageNumberCandidates,
  pageNumberText,
  parsePageNumber,
  unsettledPages,
} from '../src/pdf-book-merger/page-numbers.js';

/** 頁に対する割合で置いた文字の断片。 */
function item(text, { x = 0.5, y = 0.95, h = 0.012, w = 0.02 } = {}) {
  return { text, x0: x - w / 2, x1: x + w / 2, y, h };
}

/** 頁番号だけが読めた頁の候補（頁番号の読み取りを通さず、直接作る）。 */
const read = (value, score = 3.5) => [{ value, score, source: 'text', zone: 'bottom' }];
const none = () => [];
/** 枝番の付いた番号（57-1）だけが読めた頁の候補。 */
const branch = (value, number) => [{ value, branch: number, score: 3.5, source: 'text', zone: 'bottom' }];

describe('normalizeDigits / groupLines', () => {
  it('全角の数字を半角にする', () => {
    expect(normalizeDigits('１２３頁')).toBe('123頁');
  });

  it('1 文字ずつの断片を、同じ高さのものどうしで行にまとめる', () => {
    const lines = groupLines([
      { text: '1', x0: 0.49, x1: 0.5, y: 0.95, h: 0.01 },
      { text: '2', x0: 0.5, x1: 0.51, y: 0.9502, h: 0.01 },
      { text: '本文', x0: 0.1, x1: 0.3, y: 0.5, h: 0.01 },
    ]);

    expect(lines.map((line) => line.text)).toEqual(['本文', '12']);
  });

  it('字の間が開いていれば区切る（柱と頁番号をくっつけない）', () => {
    const [line] = groupLines([
      { text: '第3章 運動の法則', x0: 0.1, x1: 0.4, y: 0.05, h: 0.012 },
      { text: '57', x0: 0.85, x1: 0.88, y: 0.05, h: 0.012 },
    ]);

    expect(line.text).toBe('第3章 運動の法則 57');
  });
});

describe('pageNumberCandidates', () => {
  it('下の余白に番号だけが置かれた行は、強い候補', () => {
    const [candidate] = pageNumberCandidates([item('- 12 -')]);

    expect(candidate).toMatchObject({ value: 12, source: 'text', zone: 'bottom' });
    expect(candidate.score).toBeGreaterThanOrEqual(3);
  });

  it.each(['12', '(12)', 'p.12', '12頁', '－１２－', '— 12 —'])('飾りの付いた番号 %s', (text) => {
    expect(pageNumberCandidates([item(text)]).map((c) => c.value)).toEqual([12]);
  });

  it('柱の末尾・先頭に付いた番号は、弱い候補', () => {
    const trailing = pageNumberCandidates([item('第3章 運動の法則 57', { y: 0.04, w: 0.6 })]);
    const leading = pageNumberCandidates([item('58 第3章 運動の法則', { y: 0.04, w: 0.6 })]);

    expect(trailing.map((c) => c.value)).toEqual([57]);
    expect(trailing[0].score).toBeLessThan(3);
    expect(leading.map((c) => c.value)).toEqual([58]);
  });

  it('本文の中の数字・章番号・年号は拾わない', () => {
    expect(
      pageNumberCandidates([
        item('12', { y: 0.5 }), // 本文の真ん中
        item('第3章', { y: 0.04 }), // 柱の章番号（数字だけの行ではない）
        item('2024', { y: 0.96 }), // 年号
        item('0', { y: 0.96 }),
      ])
    ).toEqual([]);
  });

  it('上下の帯の両方に候補があれば、両方を挙げる（どちらが合うかは並びで決める）', () => {
    const values = pageNumberCandidates([item('3', { y: 0.04 }), item('15', { y: 0.96 })]).map(
      (c) => c.value
    );

    expect(values.sort((a, b) => a - b)).toEqual([3, 15]);
  });

  it('OCR の結果も同じ読み方で扱い、出どころを残す', () => {
    expect(pageNumberCandidates([item('7')], 'ocr')[0].source).toBe('ocr');
  });
});

describe('detectStep', () => {
  it('奇数頁の束は 2 つずつ', () => {
    expect(detectStep([read(1), read(3), none(), read(7)]).step).toBe(2);
  });

  it('裏返した偶数頁の束は 2 つずつ逆順', () => {
    expect(detectStep([read(20), read(18), read(16)]).step).toBe(-2);
  });

  it('両面の束は 1 つずつ', () => {
    expect(detectStep([read(5), read(6), read(7)]).step).toBe(1);
  });

  it('番号が 1 つしか読めなければ決めない', () => {
    expect(detectStep([none(), read(5), none()]).step).toBeNull();
  });
});

describe('inferFileNumbers', () => {
  it('番号の刷られていない頁を、前後から補う', () => {
    const { step, pages } = inferFileNumbers([read(1), read(3), none(), read(7), none()]);

    expect(step).toBe(2);
    expect(pages.map((p) => p.number)).toEqual([1, 3, 5, 7, 9]);
    expect(pages.map((p) => p.status)).toEqual([
      'detected',
      'detected',
      'inferred',
      'detected',
      'inferred',
    ]);
  });

  it('読み違えた 1 頁は、前後と合わないので外れ値として扱う', () => {
    const { pages } = inferFileNumbers([read(2), read(4), read(8), read(8), read(10)]);

    expect(pages.map((p) => p.number)).toEqual([2, 4, 6, 8, 10]);
    expect(pages[2]).toMatchObject({ status: 'conflict', read: { value: 8 } });
  });

  it('柱の章番号よりも、並びに合う頁番号を選ぶ', () => {
    const header = (chapter, page) => [
      { value: chapter, score: 2.5, source: 'text', zone: 'top' },
      { value: page, score: 3.5, source: 'text', zone: 'bottom' },
    ];
    const { pages } = inferFileNumbers([header(3, 41), header(3, 43), header(3, 45)]);

    expect(pages.map((p) => p.number)).toEqual([41, 43, 45]);
  });

  it('番号の無い前付けは、歩幅を延ばして 0 以下になる（1 頁より前に並ぶ）', () => {
    const { pages } = inferFileNumbers([none(), none(), read(1), read(3), read(5)]);

    expect(pages.map((p) => p.number)).toEqual([-3, -1, 1, 3, 5]);
  });

  it('裏返した束（逆順）も同じように補う', () => {
    const { step, pages } = inferFileNumbers([read(10), none(), read(6), read(4), none()]);

    expect(step).toBe(-2);
    expect(pages.map((p) => p.number)).toEqual([10, 8, 6, 4, 2]);
  });

  it('番号が本当に飛んでいるところでは並びを切り替え、境目の頁は要確認にする', () => {
    // 15 と 17 の間に、番号に数えない図版が 1 枚挟まっている。
    const { pages } = inferFileNumbers([read(11), read(13), read(15), none(), read(17), read(19)]);

    expect(pages.map((p) => p.number).filter((_, i) => i !== 3)).toEqual([11, 13, 15, 17, 19]);
    expect(pages[3].status).toBe('uncertain');
  });

  it('分かっている歩幅を借りて、番号が 1 つだけのファイルも並べる', () => {
    const { pages } = inferFileNumbers([none(), read(23), none()], { step: 2 });

    expect(pages.map((p) => p.number)).toEqual([21, 23, 25]);
  });

  it('歩幅が決まらなければ、読めた頁にだけ番号を付ける', () => {
    const { step, pages } = inferFileNumbers([none(), read(23), none()]);

    expect(step).toBeNull();
    expect(pages.map((p) => p.number)).toEqual([null, 23, null]);
    expect(pages.map((p) => p.status)).toEqual(['unknown', 'detected', 'unknown']);
  });

  it('手掛かりが何も無ければ、すべて不明', () => {
    const { pages } = inferFileNumbers([none(), none()], { step: 2 });

    expect(pages).toEqual([
      { number: null, status: 'unknown', read: null },
      { number: null, status: 'unknown', read: null },
    ]);
  });
});

describe('manualFileNumbers / numberingSequence / formatNumber', () => {
  it('手で決めた先頭の番号と歩幅で並べる', () => {
    expect(manualFileNumbers(3, 20, -2).pages.map((p) => [p.number, p.status])).toEqual([
      [20, 'manual'],
      [18, 'manual'],
      [16, 'manual'],
    ]);
  });

  it('番号の付き方を、番号を並べて言い表す（長い並びは間を詰める）', () => {
    expect(numberingSequence(inferFileNumbers([read(1), read(3), read(5)]))).toBe('1, 3, 5');
    expect(numberingSequence(inferFileNumbers([read(6), read(4), read(2)]))).toBe('6, 4, 2');
    expect(numberingSequence(manualFileNumbers(5, 1, 1))).toBe('1, 2, 3, 4, 5');
    // 前付け（0 以下の番号）から始まる束。
    expect(numberingSequence(manualFileNumbers(14, -11, 2))).toBe('-11, -9, -7...13, 15');
    expect(numberingSequence(manualFileNumbers(6, 12, -2))).toBe('12, 10, 8...4, 2');
    expect(numberingSequence(inferFileNumbers([none()]))).toBe('?');
    // 歩幅をほかの束から借りても、番号の候補が無ければ決まらない。
    expect(numberingSequence(inferFileNumbers([none(), none(), none()], { step: 2 }))).toBe('?');
  });

  it('番号が飛んでいるところは詰めずに、飛んだ先から並べ直す', () => {
    const numbers = (...list) => ({ step: 2, pages: list.map((number) => ({ number })) });
    expect(numberingSequence(numbers(1, 3, 9, 11))).toBe('1, 3, 9, 11');
    expect(numberingSequence(numbers(1, 3, 5, 7, 9, 11, 21, 23, 25, 27, 29, 31))).toBe(
      '1, 3, 5...9, 11, 21, 23, 25...29, 31'
    );
  });

  it('前付けと、間に入れた頁の番号の見せ方', () => {
    expect(formatNumber(12)).toBe('12');
    expect(formatNumber(-1)).toBe('前付(-1)');
    expect(formatNumber(16.5)).toBe('16と17の間');
    expect(formatNumber(null)).toBe('?');
  });
});

describe('枝番の頁（加除式の差し替え）', () => {
  it.each(['57-1', '57 - 1', '５７－１', '- 57-1 -', '57ー1頁'])('枝番の付いた番号 %s', (text) => {
    const [candidate] = pageNumberCandidates([item(text)]);

    expect(candidate).toMatchObject({ value: 57, branch: 1 });
    expect(candidate.score).toBeGreaterThanOrEqual(3);
  });

  it('枝番の無い番号には branch を付けない', () => {
    expect(pageNumberCandidates([item('57')])[0]).not.toHaveProperty('branch');
    expect(pageNumberCandidates([item('57-0')])).toEqual([]);
  });

  it('同じ番号でも、枝番が違えば別の候補', () => {
    const values = pageNumberCandidates([item('57', { y: 0.04 }), item('57-1')]).map((c) => [c.value, c.branch]);
    expect(values).toEqual(
      expect.arrayContaining([
        [57, undefined],
        [57, 1],
      ])
    );
    expect(values).toHaveLength(2);
  });

  it('同じ番号が上下に 2 度あれば、候補は 1 つ', () => {
    expect(pageNumberCandidates([item('12', { y: 0.04 }), item('12', { y: 0.96 })])).toHaveLength(1);
  });

  it('奇数頁の束: 枝番の頁は読めたまま置き、その前後で番号が飛んでもよい', () => {
    // 57・58 頁の紙が 57-1〜57-4 に差し替えられている。59 頁は束の最後の 1 頁だけ。
    const { step, pages } = inferFileNumbers([read(51), read(53), read(55), branch(57, 1), branch(57, 3), read(59)]);

    expect(step).toBe(2);
    expect(pages.map((p) => [p.number, p.branch ?? null, p.status])).toEqual([
      [51, null, 'detected'],
      [53, null, 'detected'],
      [55, null, 'detected'],
      [57, 1, 'detected'],
      [57, 3, 'detected'],
      [59, null, 'detected'],
    ]);
  });

  it('裏返した偶数頁の束も同じ', () => {
    const { step, pages } = inferFileNumbers([read(62), read(60), branch(57, 4), branch(57, 2), read(56), none()]);

    expect(step).toBe(-2);
    expect(pages.map((p) => (p.branch ? `${p.number}-${p.branch}` : p.number))).toEqual([62, 60, '57-4', '57-2', 56, 54]);
  });

  it('枝番の頁をまたぐ頁どうしの差は、歩幅の票に数えない', () => {
    // 55 → 59（間に枝番の頁）を数えると、歩幅 4 にも 2 にもならない並びが混ざる。
    expect(detectStep([read(55), read(59)], new Set([1])).step).toBeNull();
    expect(detectStep([read(55), read(57)]).step).toBe(2);
  });

  it('枝番の頁だけのファイル', () => {
    const { step, pages } = inferFileNumbers([branch(57, 1), branch(57, 3)]);

    expect(step).toBeNull();
    expect(pages.map((p) => p.status)).toEqual(['detected', 'detected']);
  });

  it('番号の付き方の要約では、枝番の頁を前後と続けない', () => {
    const numbering = inferFileNumbers([
      read(49), read(51), read(53), read(55), branch(57, 1), branch(57, 3), read(59), read(61),
    ]);

    expect(numberingSequence(numbering)).toBe('49, 51, 53, 55, 57-1, 57-3, 59, 61');
  });

  it('見せ方と、手で入れる番号の読み方', () => {
    expect(formatNumber(57, 1)).toBe('57-1');
    expect(parsePageNumber('57-1')).toEqual({ number: 57, branch: 1 });
    expect(parsePageNumber(' ５７－２ ')).toEqual({ number: 57, branch: 2 });
    expect(parsePageNumber('12.5')).toEqual({ number: 12.5 });
    expect(parsePageNumber('-3')).toEqual({ number: -3 });
    expect(parsePageNumber('abc')).toBeNull();
    expect(parsePageNumber('')).toBeNull();
    expect(pageNumberText({ number: 57, branch: 1 })).toBe('57-1');
    expect(pageNumberText({ number: 12.5 })).toBe('12.5');
  });
});

describe('本文の脇の行番号（5 行おき）', () => {
  /** 左の余白に右端を揃えて刷った行番号と、それに続く本文の行。 */
  const left = (number, y, text = '') =>
    text
      ? { text: `${number} ${text}`, x0: 0.08, x1: 0.89, y, h: 0.011 }
      : { text: String(number), x0: 0.1 - 0.006 * String(number).length, x1: 0.1, y, h: 0.011 };
  const pageNumber = (value, x = 0.88) => item(String(value), { x, y: 0.95 });

  it('下の帯に来た行番号を、頁番号と取り違えない', () => {
    const items = [
      left(5, 0.2),
      left(10, 0.31, '本文の行'),
      left(35, 0.79, '本文の行'),
      left(40, 0.9, 'されており,当該調査を的確に実施するためには'), // 行の先頭に付いた行番号
      left(45, 0.93), // 番号だけの行
      pageNumber(91),
    ];

    expect(pageNumberCandidates(items).map((c) => c.value)).toEqual([91]);
  });

  it('図で間が空いても、すぐ上の行番号から 5 増えていれば行番号', () => {
    const items = [left(15, 0.4, '本文の行'), left(20, 0.51, '本文の行'), left(25, 0.89), pageNumber(79)];

    expect(pageNumberCandidates(items).map((c) => c.value)).toEqual([79]);
  });

  it('すぐ下に 5 大きい番号がある行番号も外す（右の余白の、行の末尾に付いた行番号）', () => {
    const right = (number, y) => ({ text: `本文の行 ${number}`, x0: 0.1, x1: 0.92, y, h: 0.011 });
    const items = [right(35, 0.87), right(40, 0.9), pageNumber(64, 0.1)];

    expect(pageNumberCandidates(items).map((c) => c.value)).toEqual([64]);
  });

  it('行番号の列にあっても、5 ずつ続かない番号は頁番号として残す', () => {
    // 偶数頁の頁番号が、左の行番号の列の真下に来ることがある。
    const items = [left(35, 0.79, '本文の行'), left(40, 0.86, '本文の行'), left(80, 0.95)];

    expect(pageNumberCandidates(items).map((c) => c.value)).toEqual([80]);
  });

  it('5 の倍数でない番号、別の列の番号、上下の向きが逆のものは行番号とみなさない', () => {
    expect(pageNumberCandidates([left(40, 0.86, '本文の行'), left(41, 0.95)]).map((c) => c.value)).toEqual([41]);
    // 枝番の付いた番号は、行番号の列の真下にあっても頁番号。
    const branchPage = { ...left(45, 0.95), text: '45-1' };
    expect(pageNumberCandidates([left(40, 0.86, '本文の行'), branchPage])).toMatchObject([{ value: 45, branch: 1 }]);
    expect(pageNumberCandidates([left(40, 0.86, '本文の行'), pageNumber(45)]).map((c) => c.value)).toEqual([45]);
    // 5 大きい番号が上にある（行番号は上から増える）。
    expect(pageNumberCandidates([left(50, 0.5, '本文の行'), left(45, 0.95)]).map((c) => c.value)).toEqual([45]);
  });
});

describe('文字情報だけでは番号の決まらない頁（余白を OCR する頁）', () => {
  /** 柱や表の中の数字だけが拾えた頁（弱い候補）。 */
  const weak = (value) => [{ value, score: 2, source: 'text', zone: 'top' }];
  const ocr = (value, branchNumber) => [
    { value, ...(branchNumber ? { branch: branchNumber } : {}), score: 4, source: 'ocr', zone: 'bottom' },
  ];

  it('候補が無い頁・並びに合わない頁（弱い候補だけ・読み違え）を挙げ、並びに合う頁は挙げない', () => {
    // 実際のスキャン（加除式の本の奇数頁の束）: 181-1 は文字情報が読み落とし、
    // 柱の 3 だけが拾える。182 は読めている。184-1 は「184ソ」で読めない。
    // 175 は 171 と読み違えている。
    const text = [read(173), read(171), read(177), read(179), weak(3), read(182), weak(12), none()];

    expect([...unsettledPages(text)]).toEqual([1, 4, 5, 6, 7]);
  });

  it('OCR で読めた番号を足すと、枝番の頁を挟んで並びが変わっても、読めた頁を食い違いにしない', () => {
    const text = [read(173), read(171), read(177), read(179), weak(3), read(182), weak(12)];
    // 文字情報だけでは、182 が前後と食い違う（183 とされる）。
    expect(inferFileNumbers(text).pages[5]).toMatchObject({ number: 183, status: 'conflict' });

    const merged = text.slice();
    merged[1] = mergeCandidates(text[1], ocr(175));
    merged[4] = mergeCandidates(text[4], ocr(181, 1));
    merged[5] = mergeCandidates(text[5], ocr(182));
    merged[6] = mergeCandidates(text[6], ocr(184, 1));
    const { pages } = inferFileNumbers(merged);
    expect(pages.map((p) => [p.branch ? `${p.number}-${p.branch}` : p.number, p.status])).toEqual([
      [173, 'detected'],
      [175, 'detected'],
      [177, 'detected'],
      [179, 'detected'],
      ['181-1', 'detected'],
      [182, 'detected'],
      ['184-1', 'detected'],
    ]);
    expect(unsettledPages(merged).size).toBe(0);
  });

  it('同じ番号の候補は 1 つにして点数の高いほうを残し、点数の順に並べる', () => {
    const text = [
      { value: 182, score: 4, source: 'text', zone: 'bottom' },
      { value: 3, score: 2, source: 'text', zone: 'top' },
    ];
    const fromImage = [
      { value: 182, score: 3.5, source: 'ocr', zone: 'bottom' },
      { value: 182, branch: 1, score: 3.5, source: 'ocr', zone: 'bottom' },
      { value: 3, score: 4, source: 'ocr', zone: 'bottom' },
    ];
    // 同点なら後の読み（OCR）を残す。
    expect(mergeCandidates(text, [{ value: 182, score: 4, source: 'ocr', zone: 'bottom' }])[0].source).toBe('ocr');

    expect(mergeCandidates(text, fromImage)).toEqual([
      { value: 3, score: 4, source: 'ocr', zone: 'bottom' },
      { value: 182, score: 4, source: 'text', zone: 'bottom' },
      { value: 182, branch: 1, score: 3.5, source: 'ocr', zone: 'bottom' },
    ]);
  });
});
