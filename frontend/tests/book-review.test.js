// PDF 結合ツール: 確認の画面に出すもの（頁ごとの指摘・一覧の並び）。

import { describe, expect, it } from 'vitest';
import {
  displayLabel,
  gridItems,
  issueGroups,
  mergeIssues,
  missingLabel,
  pageIssues,
  suggestBookName,
  textCoverage,
  textIssues,
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
    expect(displayLabel({ role: 'front', status: 'listed' })).toBe('番号なし');
    expect(displayLabel({ role: 'back', status: 'listed' })).toBe('番号なし');
    expect(displayLabel(body('a', 12))).toBe('12 頁');
    expect(displayLabel(body('a', null, 'unknown'))).toBe('番号不明');
    expect(displayLabel({ ...body('a', 57), branch: [1] })).toBe('57-1 頁');
  });

  it('頁番号が戻ったところで分けたまとまりの頁は、まとまりの番号を頭に付ける', () => {
    expect(displayLabel({ ...body('a', 3), part: 1, section: [2] })).toBe('2-3 頁');
    expect(displayLabel({ ...body('a', 30), prefix: [4], part: 1, section: [6] })).toBe('6-4-30 頁');
    expect(displayLabel({ ...body('a', 3), part: null })).toBe('3 頁');
  });

  it('頁番号の前に刷られた部・編などの番号は、頁番号に付けて書く', () => {
    expect(displayLabel({ ...body('a', 21), prefix: [2], part: 1 })).toBe('2-21 頁');
    expect(displayLabel({ ...body('a', 21), prefix: [2, 2], branch: [3] })).toBe('2-2-21-3 頁');
    expect(displayLabel({ ...body('a', 0), prefix: [2] })).toBe('2-0 頁');
    expect(displayLabel({ ...body('a', -1), prefix: [2] })).toBe('2-前付(-1) 頁');
    expect(displayLabel({ ...body('a', 16.5), prefix: [2] })).toBe('2-16と2-17の間 頁');
  });
});

describe('pageIssues', () => {
  it('番号の決まり方・並びの指摘・スキャンの検査・文字情報を、頁ごとにまとめる', () => {
    const order = [
      body('a', 1),
      body('b', 2, 'conflict', { path: [2, 8] }),
      body('c', 3, 'uncertain'),
      body('d', null, 'unknown'),
      body('e', null, 'unplaced'),
    ];
    const problems = [
      { kind: 'duplicate', pageKeys: ['a'] },
      { kind: 'missing', pageKeys: [] },
      { kind: 'listed', pageKeys: ['c'] },
      { kind: 'cover-numbers', pageKeys: ['b'] },
    ];
    const scan = new Map([['c', [{ kind: 'skew', level: 'warn', message: '0.9° 左に傾いています' }]]]);

    const issues = pageIssues(order, problems, scan, new Set(['d']));

    expect(issues.get('a').map((i) => [i.kind, i.level])).toEqual([['duplicate', 'error']]);
    expect(issues.get('b')[0].message).toBe('読み取った番号（2-8）が前後の並びと合いません');
    expect(issues.get('b').map((i) => [i.kind, i.level])).toEqual([
      ['conflict', 'warn'],
      ['cover-numbers', 'warn'],
    ]);
    expect(issues.get('c').map((i) => i.kind)).toEqual(['uncertain', 'listed', 'skew']);
    expect(issues.get('d').map((i) => [i.kind, i.level])).toEqual([
      ['unknown', 'error'],
      ['textless', 'info'],
    ]);
    expect(issues.get('e').map((i) => [i.kind, i.level])).toEqual([['unplaced', 'error']]);
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

    expect(items[1]).toEqual({ type: 'missing', from: 2, to: 39, part: undefined });
    expect(items).toHaveLength(3);
  });

  it('部が変わったところでは、番号が戻っても札を挟まない（部の中の抜けには挟む）', () => {
    const order = [
      { ...body('a', 1), part: 0 },
      { ...body('b', 2), part: 0 },
      { ...body('c', 1), part: 1 },
      { ...body('d', 3), part: 1 },
    ];

    expect(gridItems(order).map((item) => (item.type === 'missing' ? `-${item.part}:${item.from}` : item.entry.pageKey))).toEqual([
      'a',
      'b',
      'c',
      '-1:2',
      'd',
    ]);
  });

  it('枝番の頁に差し替えられた番号には札を挟まず、枝番の抜けには枝番の札を挟む', () => {
    const branch = (number, b) => ({ ...body(`${number}-${b}`, number), branch: [b] });
    const order = [
      body('55', 55),
      body('56', 56),
      branch(57, 1),
      branch(57, 2),
      branch(57, 4), // 57-3 が無い
      body('59', 59), // 58 は 57-1〜57-4 に差し替えられた
      branch(60, 2), // 60 は枝番の頁に差し替えられた（偶数なので裏の 61 は別）。60-1 が無い
    ];
    const labels = gridItems(order).map((item) => (item.type === 'missing' ? `-${missingLabel(item)}` : item.entry.pageKey));

    expect(labels).toEqual(['55', '56', '57-1', '57-2', '-57-3 頁', '57-4', '59', '-60-1 頁', '60-2']);
  });

  it('入れ子の枝番の抜けも段ごとに挟む（下の段の枝番の頁に差し替えられた枝番の頁には挟まない）', () => {
    const page = (...path) => ({
      ...body(path.join('-'), path[0]),
      ...(path.length > 1 ? { branch: path.slice(1) } : {}),
    });
    const order = [
      page(57, 1, 1), // 57-1 は 57-1-1・57-1-2 に差し替えられた（奇数なので裏の 57-2 も）
      page(57, 1, 2),
      page(57, 3), // 57-2 は差し替えられた
      page(57, 4),
      page(57, 4, 2), // 57-4-1 が無い
      page(57, 6, 2), // 57-5・57-6-1 が無い
    ];
    const labels = gridItems(order).map((item) => (item.type === 'missing' ? `-${missingLabel(item)}` : item.entry.pageKey));

    expect(labels).toEqual(['57-1-1', '57-1-2', '57-3', '57-4', '-57-4-1 頁', '57-4-2', '-57-5 頁', '-57-6-1 頁', '57-6-2']);
  });

  it('枝番の抜けも、長く続いていたら 1 枚の札にまとめる', () => {
    const page = (...path) => ({ ...body(path.join('-'), path[0]), branch: path.slice(1) });
    const labels = (order) =>
      gridItems(order).map((item) => (item.type === 'missing' ? `-${missingLabel(item)}` : item.entry.pageKey));

    // 57-1 の次が 57-1234（読み違い）でも、札は 1 枚。
    const items = gridItems([page(57, 1), page(57, 1234)]);
    expect(items).toHaveLength(3);
    expect(items[1]).toEqual({ type: 'missing', from: 57, to: 57, branch: [2], branchTo: 1233, part: undefined });
    expect(missingLabel(items[1])).toBe('57-2〜57-1233 頁');
    // MAX_MISSING_CARDS（6）までは 1 枚ずつ、それを超えたらまとめる。
    expect(labels([page(57, 1), page(57, 8)])).toEqual(['57-1', '-57-2 頁', '-57-3 頁', '-57-4 頁', '-57-5 頁', '-57-6 頁', '-57-7 頁', '57-8']);
    expect(labels([page(57, 1), page(57, 9)])).toEqual(['57-1', '-57-2〜57-8 頁', '57-9']);
    // 入れ子の段の抜けも、段ごとにまとめる。下の段の枝番の頁に差し替えられた枝番の頁
    // （57-3 と、その裏の 57-4）は抜けにしない。
    expect(labels([page(57, 1), page(57, 3, 9), page(57, 12)])).toEqual([
      '57-1',
      '-57-2 頁',
      '-57-3-1〜57-3-8 頁',
      '57-3-9',
      '-57-5〜57-11 頁',
      '57-12',
    ]);
    // 差し替えられた枝番の頁（57-3・57-4）で、続く抜けが切れる。
    expect(labels([page(57, 1), page(57, 12), page(57, 3, 1)])).toEqual(['57-1', '-57-2 頁', '-57-5〜57-11 頁', '57-12', '57-3-1']);
  });

  it('抜けの札は、前の頁の部・前の段を引き継ぐ', () => {
    const order = [
      { ...body('a', 1), prefix: [2], part: 1 },
      { ...body('b', 3), prefix: [2], part: 1 },
    ];

    expect(gridItems(order)[1]).toEqual({ type: 'missing', from: 2, to: 2, prefix: [2], part: 1 });
    const renumbered = [
      { ...body('a', 1), part: 1, section: [2] },
      { ...body('b', 3), part: 1, section: [2] },
    ];
    expect(missingLabel(gridItems(renumbered)[1])).toBe('2-2 頁');
  });

  it('抜けの札の見出し', () => {
    expect(missingLabel({ from: 58, to: 58 })).toBe('58 頁');
    expect(missingLabel({ from: 60, to: 70 })).toBe('60〜70 頁');
    expect(missingLabel({ from: 57, to: 57, branch: [2] })).toBe('57-2 頁');
    expect(missingLabel({ from: 58, to: 58, part: 1, section: [2] })).toBe('2-58 頁');
    expect(missingLabel({ from: 57, to: 57, branch: [2], part: 1, section: [6], prefix: [4] })).toBe('6-4-57-2 頁');
    expect(missingLabel({ from: 60, to: 70, part: 1, section: [6], prefix: [4] })).toBe('6-4-60〜6-4-70 頁');
    expect(missingLabel({ from: 58, to: 58, prefix: [2] })).toBe('2-58 頁');
    expect(missingLabel({ from: 60, to: 70, prefix: [2] })).toBe('2-60〜2-70 頁');
    expect(missingLabel({ from: 57, to: 57, branch: [1, 2], prefix: [2] })).toBe('2-57-1-2 頁');
    expect(missingLabel({ from: 57, to: 57, branch: [2], branchTo: 30 })).toBe('57-2〜57-30 頁');
    expect(missingLabel({ from: 57, to: 57, branch: [1, 2], branchTo: 30, part: 1, section: [6], prefix: [4] })).toBe(
      '6-4-57-1-2〜6-4-57-1-30 頁'
    );
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

describe('issueGroups', () => {
  it('本全体の指摘と、頁ごとの指摘の種類ごとの数を、重いものから並べる', () => {
    const order = [body('a', 1), body('b', 2), body('c', 3), body('d', 4)];
    const problems = [
      { level: 'warn', kind: 'conflict', message: '食い違い', pageKeys: ['b'] },
      { level: 'error', kind: 'duplicate', message: '1 頁が 2 回', pageKeys: ['a', 'c'], number: 1 },
      { level: 'error', kind: 'duplicate', message: '4 頁が 2 回', pageKeys: ['d', 'b'], number: 4 },
      { level: 'error', kind: 'missing', message: '抜け', pageKeys: [] },
    ];
    const issues = new Map([
      ['d', [{ kind: 'skew' }, { kind: 'blank' }]],
      ['b', [{ kind: 'skew' }, { kind: 'conflict' }]],
    ]);
    expect(issueGroups(order, problems, issues)).toEqual([
      { key: 'duplicate:1', level: 'error', message: '1 頁が 2 回', pageKeys: ['a', 'c'] },
      { key: 'duplicate:4', level: 'error', message: '4 頁が 2 回', pageKeys: ['d', 'b'] },
      { key: 'missing', level: 'error', message: '抜け', pageKeys: [] },
      { key: 'conflict', level: 'warn', message: '食い違い', pageKeys: ['b'] },
      { key: 'skew', level: 'warn', message: '傾いている頁が 2 頁あります。', pageKeys: ['b', 'd'] },
      { key: 'blank', level: 'info', message: '白紙の頁が 1 頁あります。', pageKeys: ['d'] },
    ]);
  });

  it('枝番の頁の抜け・差し替えは、番号ごとに別の項目にする', () => {
    const problems = [
      { level: 'error', kind: 'missing', message: '3 頁が見つかりません', pageKeys: [], numbers: [3] },
      { level: 'error', kind: 'missing', message: '57-3 頁が見つかりません', pageKeys: [], number: 57 },
      { level: 'info', kind: 'replaced', message: '57〜58 頁は無く', pageKeys: ['a'], number: 57 },
      { level: 'info', kind: 'replaced', message: '79〜80 頁は無く', pageKeys: ['b'], number: 79 },
    ];
    expect(issueGroups([], problems, new Map()).map((group) => group.key)).toEqual([
      'missing',
      'missing:57',
      'replaced:57',
      'replaced:79',
    ]);
  });

  it('同じ頁の重なりは、重なっている頁をすべて並べる', () => {
    const order = [body('a', 1), body('b', 2), body('c', 3)];
    const problems = [{ level: 'warn', kind: 'same-page', message: '同じ内容の頁が 1 組', pageKeys: ['c'] }];
    const issues = new Map([
      ['c', [{ kind: 'same-page' }]],
      ['a', [{ kind: 'same-page' }]],
    ]);
    expect(issueGroups(order, problems, issues)).toEqual([
      { key: 'same-page', level: 'warn', message: '同じ内容の頁が 1 組', pageKeys: ['a', 'c'] },
    ]);
  });

  it('指摘が無ければ空', () => {
    expect(issueGroups([body('a', 1)], [], new Map())).toEqual([]);
  });
});

describe('textIssues / mergeIssues', () => {
  it('文字情報の確かめの結果を、頁ごとの注意にし、ほかの指摘と 1 つにまとめる', () => {
    const order = [body('a', 1), body('b', 2), { pageKey: 'c', role: 'front', number: null, status: 'cover' }];
    const checks = {
      a: { kind: 'mojibake', sample: '縺ゅ≠縺' },
      b: null,
      c: { kind: 'reversed', sample: 'すまりあ' },
    };
    const text = textIssues(order, (entry) => ({ textCheck: checks[entry.pageKey] }));
    expect(text).toEqual(
      new Map([
        ['a', [{ kind: 'text', level: 'warn', message: '文字情報が文字化けしているようです（「縺ゅ≠縺」）' }]],
        ['c', [{ kind: 'text', level: 'warn', message: '文字情報の並びが逆順になっているようです（「すまりあ」）' }]],
      ])
    );
    const scan = new Map([['a', [{ kind: 'skew', level: 'warn', message: '傾いています' }]]]);
    const merged = mergeIssues(scan, text, new Map());
    expect(merged.get('a').map((issue) => issue.kind)).toEqual(['skew', 'text']);
    expect(merged.get('c').map((issue) => issue.kind)).toEqual(['text']);
    expect(merged.has('b')).toBe(false);
  });
});
