// 書籍スキャン PDF 結合ツール: 1 冊の並びと、並びの確かめ方。
//
// 実際の作業の形——奇数頁の束を 2 回、裏返した偶数頁の束を 2 回、表紙と
// 裏表紙を 1 回でスキャン——をそのまま組み立て、1 冊の順に並ぶこと、
// 束の入れ忘れ・2 度入れ・手直しが並びと指摘に表れることを縛る。

import { describe, expect, it } from 'vitest';
import {
  buildBookOrder,
  checkSequence,
  compressRanges,
  guessRole,
  numberFiles,
  orderedFile,
  pageLabelRanges,
  pageLabelTexts,
  roleFromName,
  romanNumeral,
  sideOf,
} from '../src/pdf-book-merger/ordering.js';

/**
 * ファイル 1 つ。numbers は頁ごとに読めた番号（null は読めなかった頁）。
 */
function file(key, numbers, { role = 'body', manual = null } = {}) {
  return {
    key,
    role,
    manual,
    pages: numbers.map((value, index) => ({
      key: `${key}:${index}`,
      candidates: value === null ? [] : [{ value, score: 3.5, source: 'text', zone: 'bottom' }],
    })),
  };
}

const range = (from, to, step) => {
  const list = [];
  for (let n = from; step > 0 ? n <= to : n >= to; n += step) list.push(n);
  return list;
};

/** 1〜20 頁の本。奇数頁を 2 回、偶数頁を裏返して 2 回、表紙と裏表紙を 1 回。 */
function book() {
  return [
    file('odd-a', range(1, 9, 2)),
    file('odd-b', [11, 13, null, 17, 19]), // 15 頁は番号が読めない（章の扉）
    file('even-b', range(20, 12, -2)), // 裏返したので逆順
    file('even-a', range(10, 2, -2)),
    file('cover', [null, null], { role: 'split' }),
  ];
}

function arrange(files, overrides) {
  const numberings = numberFiles(files);
  return buildBookOrder(files, numberings, overrides);
}

describe('guessRole', () => {
  it.each([
    ['吾輩は猫である_表紙.pdf', 'front'],
    ['吾輩は猫である_裏表紙.pdf', 'back'],
    ['表紙と裏表紙.pdf', 'split'],
    ['cover.pdf', 'front'],
  ])('名前から決める: %s → %s', (name, role) => {
    expect(guessRole(name, [{ candidates: [] }, { candidates: [] }])).toBe(role);
  });

  it('名前に手掛かりが無く、番号も読めない数頁だけなら、表紙と裏表紙', () => {
    expect(guessRole('scan_0005.pdf', [{ candidates: [] }, { candidates: [] }])).toBe('split');
    expect(guessRole('scan_0005.pdf', [{ candidates: [] }])).toBe('front');
  });

  it('名前だけで分かる役割（画像から番号を読むかどうかを決める）', () => {
    expect(roleFromName('猫_表紙.pdf')).toBe('front');
    expect(roleFromName('猫_裏表紙.pdf')).toBe('back');
    expect(roleFromName('猫_奇数1.pdf')).toBeNull();
  });

  it('それ以外は本文', () => {
    expect(guessRole('scan_0001.pdf', file('x', [1, 3, 5]).pages)).toBe('body');
    expect(guessRole('scan_0001.pdf', file('x', [null, null, null, null, null]).pages)).toBe('body');
  });
});

describe('orderedFile', () => {
  it('逆順のファイルは頁を並べ直し、結合では元の頁を引く', () => {
    const cover = { ...file('cover', [null, null], { role: 'split' }), reversed: true };
    cover.pages.forEach((page, index) => (page.index = index));
    const files = [orderedFile(cover), file('body', [1, 2])];

    const order = buildBookOrder(files, numberFiles(files));

    expect(order.map((e) => [e.role, e.pageKey, e.pageIndex])).toEqual([
      ['front', 'cover:1', 1],
      ['body', 'body:0', 0],
      ['body', 'body:1', 1],
      ['back', 'cover:0', 0],
    ]);
  });

  it('逆順でなければ、そのまま', () => {
    const plain = file('x', [1]);

    expect(orderedFile(plain)).toBe(plain);
  });

  it('逆順にした本文の束も、頁番号から同じ並びになる', () => {
    const odd = file('odd', [1, 3, 5]);
    odd.pages.forEach((page, index) => (page.index = index));
    const even = file('even', [2, 4, 6]);
    const reversed = [orderedFile({ ...odd, reversed: true }), even];

    expect(buildBookOrder(reversed, numberFiles(reversed)).map((e) => e.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('buildBookOrder', () => {
  it('奇数・偶数の束と表紙を、1 冊の順に並べる', () => {
    const order = arrange(book());

    expect(order.map((e) => (e.role === 'body' ? e.number : e.role))).toEqual([
      'front',
      ...range(1, 20, 1),
      'back',
    ]);
    // 番号の読めなかった 15 頁は、束の中の位置から補っている。
    expect(order.find((e) => e.number === 15)).toMatchObject({
      fileKey: 'odd-b',
      pageIndex: 2,
      status: 'inferred',
    });
  });

  it('先頭・末尾に置くファイルは、画面の並び順のまま', () => {
    const files = [
      file('back', [null], { role: 'back' }),
      file('body', [1, 2]),
      file('front2', [null], { role: 'front' }),
      file('front1', [null], { role: 'front' }),
    ];

    expect(arrange(files).map((e) => e.fileKey)).toEqual(['front2', 'front1', 'body', 'body', 'back']);
  });

  it('結合しないファイルは並びに入れない', () => {
    const files = [file('body', [1, 2]), file('extra', [5], { role: 'exclude' })];

    expect(arrange(files).map((e) => e.fileKey)).toEqual(['body', 'body']);
  });

  it('頁ごとに手で直した番号を優先する（小数で間に入れられる）', () => {
    const order = arrange(book(), new Map([['odd-a:0', 2.5]]));

    const at = order.findIndex((e) => e.pageKey === 'odd-a:0');
    expect(order[at]).toMatchObject({ number: 2.5, status: 'manual' });
    expect(order[at - 1].number).toBe(2);
    expect(order[at + 1].number).toBe(3);
  });

  it('ファイルごとに手で決めた番号で並べる', () => {
    const files = [file('odd', [null, null, null], { manual: { start: 1, step: 2 } }), file('even', [2, 4, 6])];

    expect(arrange(files).map((e) => e.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('番号が 1 つしか読めないファイルは、他の束の歩幅を借りる', () => {
    const files = [file('odd', [1, 3, 5]), file('even', [null, 4, null])];

    expect(arrange(files).map((e) => e.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('番号の決まらない頁は本文の最後に置く', () => {
    const files = [file('a', [1, 2, 3]), file('b', [null, null, null, null, null])];
    const order = arrange(files);

    expect(order.slice(-5).every((e) => e.number === null && e.status === 'unknown')).toBe(true);
  });
});

describe('checkSequence', () => {
  it('揃っていれば何も指摘しない', () => {
    expect(checkSequence(arrange(book()), { sheets: true })).toEqual([]);
  });

  it('束を入れ忘れると、抜けている頁を挙げる', () => {
    const files = book().filter((f) => f.key !== 'even-b');
    const problems = checkSequence(arrange(files), { sheets: true });

    const missing = problems.find((p) => p.kind === 'missing');
    expect(missing.level).toBe('error');
    expect(missing.numbers).toEqual([12, 14, 16, 18]);
    expect(missing.message).toContain('12・14・16・18 頁');
    // 最後の紙の裏（20 頁）も無い。
    expect(problems.find((p) => p.kind === 'sheet-end').message).toContain('20 頁');
  });

  it('同じ束を 2 度入れると、重なっている頁を挙げる', () => {
    const files = [...book(), file('odd-a-again', range(1, 9, 2))];
    const duplicates = checkSequence(arrange(files)).filter((p) => p.kind === 'duplicate');

    expect(duplicates.map((p) => p.message)).toContain(
      '1 頁が 2 回あります（同じ束を 2 度スキャンした・番号の読み違い）。'
    );
    expect(duplicates).toHaveLength(5);
    expect(duplicates[0].pageKeys).toEqual(['odd-a:0', 'odd-a-again:0']);
  });

  it('最初の紙の表が無ければ指摘する', () => {
    const problems = checkSequence(arrange([file('even', [2, 4]), file('odd', [3, 5])]), {
      sheets: true,
    });

    expect(problems.map((p) => p.kind)).toEqual(['sheet-start', 'sheet-end']);
  });

  it('両面の束（紙の表裏を数えない）なら、表と裏の揃いは見ない', () => {
    expect(checkSequence(arrange([file('all', [2, 3, 4, 5])]))).toEqual([]);
  });

  it('番号の決まらない頁と、並びと合わない頁を指摘する', () => {
    const files = [file('odd', [1, 3, 9, 7, 9]), file('other', [null, null, null, null, null])];
    const kinds = checkSequence(arrange(files)).map((p) => [p.kind, p.level]);

    expect(kinds).toContainEqual(['unknown', 'error']);
    expect(kinds).toContainEqual(['conflict', 'warn']);
  });

  it('本文が無ければ、それだけを指摘する', () => {
    const problems = checkSequence(arrange([file('cover', [null], { role: 'front' })]));

    expect(problems.map((p) => p.kind)).toEqual(['no-body']);
  });

  it('飛びの境目で位置を決めきれない頁を指摘する', () => {
    const problems = checkSequence(arrange([file('odd', [11, 13, 15, null, 17, 19])]));

    expect(problems.find((p) => p.kind === 'uncertain').pageKeys).toEqual(['odd:3']);
  });
});

describe('頁ラベル', () => {
  it('表紙・本文・裏表紙をそれぞれのラベルにする', () => {
    const order = arrange(book());
    const ranges = pageLabelRanges(order);

    expect(ranges).toEqual([
      { start: 0, style: null, prefix: '表紙', first: 1 },
      { start: 1, style: 'D', prefix: '', first: 1 },
      { start: 21, style: null, prefix: '裏表紙', first: 1 },
    ]);
    expect(pageLabelTexts(ranges, order.length)).toEqual([
      '表紙',
      ...range(1, 20, 1).map(String),
      '裏表紙',
    ]);
  });

  it('前付けはローマ数字、間に入れた頁は「差込」、複数頁の表紙は番号付き', () => {
    const files = [
      file('cover', [null, null], { role: 'front' }),
      file('body', [null, null, 1, 2, 3]),
    ];
    const order = buildBookOrder(files, numberFiles(files), new Map([['body:4', 2.5]]));
    const ranges = pageLabelRanges(order);

    expect(pageLabelTexts(ranges, order.length)).toEqual([
      '表紙1',
      '表紙2',
      'i',
      'ii',
      '1',
      '2',
      '差込',
    ]);
  });

  it('番号が飛んだら新しい範囲にする', () => {
    const order = [1, 2, 5, 6].map((number) => ({ role: 'body', number }));
    const ranges = pageLabelRanges(order);

    expect(ranges).toEqual([
      { start: 0, style: 'D', prefix: '', first: 1 },
      { start: 2, style: 'D', prefix: '', first: 5 },
    ]);
  });

  it('範囲の無い頁は 1 から数える', () => {
    expect(pageLabelTexts([], 2)).toEqual(['1', '2']);
  });
});

describe('小物', () => {
  it('抜けた番号を範囲にまとめて書く', () => {
    expect(compressRanges([10, 1, 2, 3, 7, 9])).toBe('1〜3・7・9〜10');
    expect(compressRanges([])).toBe('');
  });

  it('ローマ数字', () => {
    expect([1, 4, 9, 14, 40, 90, 400, 1994].map(romanNumeral)).toEqual([
      'i',
      'iv',
      'ix',
      'xiv',
      'xl',
      'xc',
      'cd',
      'mcmxciv',
    ]);
  });

  it('奇数側・偶数側', () => {
    expect([1, 2, -1, 0, 2.5, null].map(sideOf)).toEqual(['odd', 'even', 'odd', 'even', null, null]);
  });
});
