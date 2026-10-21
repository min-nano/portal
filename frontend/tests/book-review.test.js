// 書籍スキャン PDF 結合ツール: 確認の画面に出すもの（頁ごとの指摘・一覧の並び）。

import { describe, expect, it } from 'vitest';
import {
  displayLabel,
  gridItems,
  pageIssues,
  suggestBookName,
  textCoverage,
  worstLevel,
} from '../src/pdf-book-merger/review.js';

const body = (pageKey, number, status = 'detected', read = null) => ({
  pageKey,
  role: 'body',
  number,
  status,
  read,
});

describe('displayLabel', () => {
  it('表紙・裏表紙・本文の頁', () => {
    expect(displayLabel({ role: 'front' })).toBe('表紙');
    expect(displayLabel({ role: 'back' })).toBe('裏表紙');
    expect(displayLabel(body('a', 12))).toBe('12 頁');
    expect(displayLabel(body('a', null, 'unknown'))).toBe('番号不明');
  });
});

describe('pageIssues', () => {
  it('番号の決まり方・並びの指摘・スキャンの検査・文字情報を、頁ごとにまとめる', () => {
    const order = [
      body('a', 1),
      body('b', 2, 'conflict', { value: 8 }),
      body('c', 3, 'uncertain'),
      body('d', null, 'unknown'),
    ];
    const problems = [
      { kind: 'duplicate', pageKeys: ['a'] },
      { kind: 'missing', pageKeys: [] },
    ];
    const scan = new Map([['c', [{ kind: 'skew', level: 'warn', message: '0.9° 左に傾いています' }]]]);

    const issues = pageIssues(order, problems, scan, new Set(['d']));

    expect(issues.get('a').map((i) => [i.kind, i.level])).toEqual([['duplicate', 'error']]);
    expect(issues.get('b')[0].message).toBe('読み取った番号（8）が前後の並びと合いません');
    expect(issues.get('c').map((i) => i.kind)).toEqual(['uncertain', 'skew']);
    expect(issues.get('d').map((i) => [i.kind, i.level])).toEqual([
      ['unknown', 'error'],
      ['textless', 'info'],
    ]);
  });

  it('いちばん重い指摘', () => {
    expect(worstLevel(undefined)).toBeNull();
    expect(worstLevel([{ level: 'info' }])).toBe('info');
    expect(worstLevel([{ level: 'info' }, { level: 'warn' }])).toBe('warn');
    expect(worstLevel([{ level: 'warn' }, { level: 'error' }])).toBe('error');
  });
});

describe('gridItems', () => {
  it('抜けている頁の札を、あるべき位置に挟む', () => {
    const order = [{ role: 'front', pageKey: 'f' }, body('1', 1), body('4', 4), body('5', 5)];

    expect(gridItems(order).map((item) => (item.type === 'missing' ? `-${item.from}` : item.entry.pageKey))).toEqual([
      'f',
      '1',
      '-2',
      '-3',
      '4',
      '5',
    ]);
  });

  it('長く抜けていたら、1 枚の札にまとめる', () => {
    const items = gridItems([body('1', 1), body('40', 40)]);

    expect(items[1]).toEqual({ type: 'missing', from: 2, to: 39 });
    expect(items).toHaveLength(3);
  });
});

describe('textCoverage', () => {
  const pages = new Map([
    ['a', { signature: { length: 10 } }],
    ['b', { signature: { length: 0 } }],
  ]);
  const pageOf = (entry) => pages.get(entry.pageKey);

  it('一部の頁にだけ文字情報が無ければ、その頁を挙げる', () => {
    expect(textCoverage([body('a', 1), body('b', 2)], pageOf)).toEqual({
      textless: new Set(['b']),
      problem: null,
    });
  });

  it('本文のどこにも無ければ、本全体の指摘にする', () => {
    const { textless, problem } = textCoverage([body('b', 2)], pageOf);

    expect(textless.size).toBe(0);
    expect(problem.kind).toBe('no-text');
  });
});

describe('suggestBookName', () => {
  it('束の番号や「奇数」「表紙」を落とした、共通の頭', () => {
    expect(
      suggestBookName(['吾輩は猫である_奇数1.pdf', '吾輩は猫である_奇数2.pdf', '吾輩は猫である_偶数1.pdf', '吾輩は猫である_表紙.pdf'])
    ).toBe('吾輩は猫である.pdf');
    expect(suggestBookName(['book-odd-01.pdf', 'book-even-01.pdf'])).toBe('book.pdf');
  });

  it('共通するところが無ければ空', () => {
    expect(suggestBookName(['scan1.pdf', 'other.pdf'])).toBe('');
    expect(suggestBookName([])).toBe('');
  });
});
