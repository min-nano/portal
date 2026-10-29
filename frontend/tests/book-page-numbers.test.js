// 書籍スキャン PDF 結合ツール: 頁番号の読み取りと、ファイルの中での並びの推定。
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
  normalizeDigits,
  numberingFormula,
  pageNumberCandidates,
} from '../src/pdf-book-merger/page-numbers.js';

/** 頁に対する割合で置いた文字の断片。 */
function item(text, { x = 0.5, y = 0.95, h = 0.012, w = 0.02 } = {}) {
  return { text, x0: x - w / 2, x1: x + w / 2, y, h };
}

/** 頁番号だけが読めた頁の候補（頁番号の読み取りを通さず、直接作る）。 */
const read = (value, score = 3.5) => [{ value, score, source: 'text', zone: 'bottom' }];
const none = () => [];

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

describe('manualFileNumbers / numberingFormula / formatNumber', () => {
  it('手で決めた先頭の番号と歩幅で並べる', () => {
    expect(manualFileNumbers(3, 20, -2).pages.map((p) => [p.number, p.status])).toEqual([
      [20, 'manual'],
      [18, 'manual'],
      [16, 'manual'],
    ]);
  });

  it('番号の付き方を、何頁目か（n）の式で言い表す', () => {
    expect(numberingFormula(inferFileNumbers([read(1), read(3), read(5)]))).toBe('2n-1[n=1..3]');
    expect(numberingFormula(inferFileNumbers([read(6), read(4), read(2)]))).toBe('-2n+8[n=1..3]');
    expect(numberingFormula(inferFileNumbers([read(6), read(7)]))).toBe('n+5[n=1..2]');
    expect(numberingFormula(manualFileNumbers(3, 3, -1))).toBe('-n+4[n=1..3]');
    expect(numberingFormula(manualFileNumbers(2, 2, 2))).toBe('2n[n=1..2]');
    // 前付け（0 以下の番号）から始まる束。
    expect(numberingFormula(manualFileNumbers(14, -11, 2))).toBe('2n-13[n=1..14]');
    expect(numberingFormula(inferFileNumbers([none()]))).toBe('?[n=1..1]');
  });

  it('番号が飛んでずれが切り替わるところでは、区間ごとの式を並べる', () => {
    const numbers = (...list) => ({ step: 2, pages: list.map((number) => ({ number })) });
    expect(numberingFormula(numbers(1, 3, 9, 11))).toBe('2n-1[n=1..2], 2n+3[n=3..4]');
    expect(numberingFormula(numbers(1, 3, 9))).toBe('2n-1[n=1..2], 2n+3[n=3]');
  });

  it('前付けと、間に入れた頁の番号の見せ方', () => {
    expect(formatNumber(12)).toBe('12');
    expect(formatNumber(-1)).toBe('前付(-1)');
    expect(formatNumber(16.5)).toBe('16と17の間');
    expect(formatNumber(null)).toBe('?');
  });
});
