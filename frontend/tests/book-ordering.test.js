// PDF 結合ツール: 1 冊の並びと、並びの確かめ方。
//
// 実際の作業の形——奇数頁の束を 2 回、裏返した偶数頁の束を 2 回、表紙と
// 裏表紙を 1 回でスキャン——をそのまま組み立て、1 冊の順に並ぶこと、
// 束の入れ忘れ・2 度入れ・手直しが並びと指摘に表れることを縛る。

import { describe, expect, it } from 'vitest';
import {
  arrangeBook,
  branchLayout,
  checkSequence,
  compressRanges,
  guessRole,
  numberFiles,
  pageLabelRanges,
  pageLabelTexts,
  placeFiles,
  isCoverName,
  nameRank,
  roleFromName,
  romanNumeral,
} from '../src/pdf-book-merger/ordering.js';
import { sideOf } from '../src/pdf-book-merger/page-numbers.js';

/**
 * ファイル 1 つ。numbers は頁ごとに読めた番号（null は読めなかった頁、'57-1' は枝番の頁）。
 */
function file(key, numbers, { role = 'body', manual = null, coverStep = 1 } = {}) {
  return {
    key,
    role,
    manual,
    coverStep,
    pages: numbers.map((value, index) => ({
      key: `${key}:${index}`,
      candidates: value === null ? [] : [{ ...readValue(value), score: 3.5, source: 'text', zone: 'bottom' }],
    })),
  };
}

/** 12 → { path: [12] }、'57-1' → { path: [57, 1] }。 */
function readValue(value) {
  if (typeof value === 'number') return { path: [value] };
  return { path: value.split('-').map(Number) };
}

/** 並びの頁の番号（枝番の頁は '57-1'）。 */
const labelOf = (entry) => (entry.branch ? `${entry.number}-${entry.branch}` : entry.number);

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

const buildBookOrder = (...args) => arrangeBook(...args).order;

function arrange(files, overrides = new Map()) {
  return buildBookOrder(files, numberFiles(files, overrides), overrides);
}

describe('guessRole', () => {
  const blank = [{ candidates: [] }, { candidates: [] }];

  it('名前に「表紙と裏表紙」とあれば、前半を先頭・後半を末尾', () => {
    expect(guessRole('表紙と裏表紙.pdf', blank)).toBe('split');
  });

  it.each(['吾輩は猫である_表紙.pdf', '吾輩は猫である_裏表紙.pdf', 'cover.pdf'])(
    '表紙・裏表紙だけの名前は本文（置き場所は一覧の位置で決める）: %s',
    (name) => {
      expect(guessRole(name, blank)).toBe('body');
    }
  );

  it('名前に手掛かりが無く、番号も読めない数頁だけなら、表紙と裏表紙', () => {
    expect(guessRole('scan_0005.pdf', blank)).toBe('split');
  });

  it('1 頁だけなら、名前によらず本文', () => {
    expect(guessRole('scan_0005.pdf', [{ candidates: [] }])).toBe('body');
    expect(guessRole('表紙と裏表紙.pdf', [{ candidates: [] }])).toBe('body');
  });

  it('名前だけで分かる置き場所（一覧の並べ替えと、画像から番号を読むかどうかに使う）', () => {
    expect(roleFromName('猫_表紙.pdf')).toBe('front');
    expect(roleFromName('猫_裏表紙.pdf')).toBe('back');
    expect(roleFromName('猫_表紙・裏表紙.pdf')).toBe('split');
    expect(roleFromName('猫_奇数1.pdf')).toBeNull();
    // cover は英単語の一部（discovery・recover）を拾わない。
    expect(roleFromName('book-cover.pdf')).toBe('front');
    expect(roleFromName('discovery_odd.pdf')).toBeNull();
    expect(roleFromName('recover_scan.pdf')).toBeNull();
    expect(roleFromName('recovered_backup.pdf')).toBeNull();
    expect(roleFromName('coverage_report.pdf')).toBeNull();
    expect(roleFromName('cover_and_back.pdf')).toBe('split');
    expect(roleFromName('frontcover-backcover.pdf')).toBe('split');
    expect(
      ['FrontCover.pdf', 'bookcover.pdf', 'covers.pdf', 'StoreCover.pdf', 'CoverYellow.pdf', 'uncover_cover.pdf'].map(roleFromName)
    ).toEqual(['front', 'front', 'front', 'front', 'front', 'front']);
    expect(
      ['uncovered.pdf', 'covering_letter.pdf', 'AutoRecover_odd.pdf', 'MyDiscover.pdf', 'RECOVER_scan.pdf', 'DISCOVER_odd.pdf'].map(
        roleFromName
      )
    ).toEqual([null, null, null, null, null, null]);
    expect(['BOOK_COVER.pdf', 'STORECOVER.pdf', 'STOREcover.pdf'].map(roleFromName)).toEqual(['front', 'front', 'front']);
    expect(['unrecoverable.pdf', 'coverable.pdf'].map(roleFromName)).toEqual([null, null]);
    expect(['coverpage.pdf', 'coverfront.pdf', 'coverback.pdf'].map(roleFromName)).toEqual(['front', 'front', 'split']);
    expect(['COVERAGE_REPORT.pdf', '別表1.pdf', '図表1.pdf'].map(roleFromName)).toEqual([null, null, null]);
  });

  it('一覧の並べ替えでの寄せ方（表紙は上、裏表紙は下）', () => {
    expect(['猫_表紙.pdf', '表紙と裏表紙.pdf', '猫_奇数.pdf', '猫_裏表紙.pdf'].map(nameRank)).toEqual([0, 0, 1, 2]);
    expect(['猫_表紙.pdf', '猫_奇数.pdf'].map(isCoverName)).toEqual([true, false]);
  });

  it('それ以外は本文', () => {
    expect(guessRole('scan_0001.pdf', file('x', [1, 3, 5]).pages)).toBe('body');
    expect(guessRole('scan_0001.pdf', file('x', [null, null, null, null, null]).pages)).toBe('body');
  });
});

describe('placeFiles', () => {
  it('番号の無いファイルは、一覧で本文のファイルより上なら先頭、下なら末尾、間なら決められない', () => {
    const files = [
      file('a', [null]),
      file('odd', [1, 3]),
      file('b', [null]),
      file('even', [2, 4]),
      file('c', [null]),
      file('d', [null], { role: 'split' }),
      file('e', [null], { role: 'exclude' }),
    ];

    expect(Object.fromEntries(placeFiles(files, numberFiles(files)))).toEqual({
      a: 'front',
      odd: 'numbered',
      b: 'between',
      even: 'numbered',
      c: 'back',
      d: 'split',
      e: 'exclude',
    });
  });

  it('本文が無ければ、すべて先頭（一覧の順につなぐ）', () => {
    const files = [file('a', [null]), file('b', [null, null])];

    expect([...placeFiles(files, numberFiles(files)).values()]).toEqual(['front', 'front']);
  });
});

describe('arrangeBook', () => {
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

  it('番号の無いファイルは、一覧の位置で先頭・末尾に、一覧の順で置く', () => {
    const files = [
      file('front1', [null]),
      file('front2', [null, null], { role: 'split' }),
      file('body', [1, 2]),
      file('back1', [null]),
      file('back2', [null]),
    ];

    // 数頁だけのファイルは、表紙として置く（頁の多いものは「番号なし」。下の頁ラベルの例）。
    expect(arrange(files).map((e) => e.status)).toEqual(['cover', 'cover', 'detected', 'detected', 'cover', 'cover', 'cover']);
    expect(arrange(files).map((e) => [e.role, e.pageKey])).toEqual([
      ['front', 'front1:0'],
      ['front', 'front2:0'],
      ['body', 'body:0'],
      ['body', 'body:1'],
      ['back', 'front2:1'],
      ['back', 'back1:0'],
      ['back', 'back2:0'],
    ]);
  });

  it('本文が無ければ、一覧の順にそのままつなぐ', () => {
    const files = [file('b', [null, null]), file('a', [null])];

    expect(arrange(files).map((e) => [e.role, e.pageKey])).toEqual([
      ['front', 'b:0'],
      ['front', 'b:1'],
      ['front', 'a:0'],
    ]);
  });

  it('本文が無ければ、表紙と裏表紙のファイルも一覧の順にそのままつなぐ', () => {
    const files = [file('a', [null, null, null]), file('b', [null, null], { role: 'split' }), file('c', [null])];

    expect(arrange(files).map((e) => [e.pageKey, e.status])).toEqual([
      ['a:0', 'listed'],
      ['a:1', 'listed'],
      ['a:2', 'listed'],
      ['b:0', 'listed'],
      ['b:1', 'listed'],
      ['c:0', 'listed'],
    ]);
  });

  it('番号の無いファイルも、頁ごとに手で番号を入れれば本文として並べる（入れていない頁は番号不明）', () => {
    const files = [file('x', [null, null]), file('odd', [1, 3]), file('even', [2, 4])];
    const order = arrange(files, new Map([['x:0', { path: [2.5] }]]));

    expect(order.map((e) => [e.pageKey, e.status])).toEqual([
      ['odd:0', 'detected'],
      ['even:0', 'detected'],
      ['x:0', 'manual'],
      ['odd:1', 'detected'],
      ['even:1', 'detected'],
      ['x:1', 'unknown'],
    ]);
    // 名前で表紙と分かるファイルも同じ。
    const named = arrange([{ ...files[0], coverByName: true }, ...files.slice(1)], new Map([['x:0', { path: [2.5] }]]));
    expect(named.map((e) => e.pageKey)[2]).toBe('x:0');
  });

  it('名前で表紙と見たファイルに頁番号らしい番号が 2 頁以上あれば、知らせる', () => {
    const cover = (numbers) => ({ ...file('cover', numbers), coverByName: true });
    const problems = (numbers) => checkSequence(arrange([cover(numbers), file('odd', [1, 3]), file('even', [2, 4])]));

    expect(problems([5, 6]).find((p) => p.kind === 'cover-numbers')).toMatchObject({
      level: 'warn',
      pageKeys: ['cover:0', 'cover:1'],
    });
    // 番号のある頁にだけ印を付ける。
    expect(problems([5, null, 6]).find((p) => p.kind === 'cover-numbers').pageKeys).toEqual(['cover:0', 'cover:2']);
    // 1 頁だけ・同じ巻数が表と裏にあるだけなら知らせない。
    expect(problems([3, null]).some((p) => p.kind === 'cover-numbers')).toBe(false);
    expect(problems([3, null, null, 3]).some((p) => p.kind === 'cover-numbers')).toBe(false);
    // 番号が読めなくても（画像だけの PDF は名前で表紙と見ると余白を読まない）、表紙にしては頁が
    // 多ければ（9 頁以上）、すべての頁に印を付けて知らせる。番号のある頁があっても、すべての頁。
    expect(problems([5, 6, ...Array(7).fill(null)]).find((p) => p.kind === 'cover-numbers').pageKeys).toHaveLength(9);
    // 表紙・袖・帯などを 1 つにした数頁の表紙には出さない。
    expect(problems(Array(8).fill(null)).some((p) => p.kind === 'cover-numbers')).toBe(false);
    // 本文のファイルの間にあっても知らせる。
    const between = checkSequence(arrange([file('odd', [1, 3]), cover([5, 6]), file('even', [2, 4])]));
    expect(between.map((p) => p.kind)).toEqual(expect.arrayContaining(['unplaced', 'cover-numbers']));
    // 本文が無くても知らせる（その束が唯一の本文のこともある）。
    expect(checkSequence(arrange([cover([5, 6])])).map((p) => p.kind)).toEqual(['cover-numbers']);
    // 表紙と裏表紙のファイルは、名前によらず番号を見ないので知らせない。
    const split = { ...cover([5, 6]), role: 'split' };
    expect(checkSequence(arrange([split, file('odd', [1, 3])])).some((p) => p.kind === 'cover-numbers')).toBe(false);
  });

  it('名前で表紙と見たファイルも、頁ごとに番号を入れれば、残りの頁はその番号から推定する', () => {
    const cover = { ...file('cover', [null, null, null]), coverByName: true };
    const files = [file('odd', [1, 3]), cover, file('even', [2, 4])];
    const order = arrange(files, new Map([['cover:0', { path: [5] }]]));

    expect(order.filter((e) => e.fileKey === 'cover').map((e) => e.number)).toEqual([5, 7, 9]);
  });

  it('名前で表紙と分かるファイルの番号は、ほかの束の歩幅の手掛かりにしない', () => {
    // 表紙に 1 つずつ進む番号（巻数・定価など）が読めても、番号が 1 つだけの束は奇数頁の束から歩幅を借りる。
    const files = [
      { ...file('cover', [5, 6, 7, 8, 9]), coverByName: true },
      file('odd', [1, 3]),
      file('one', [null, 7, null]),
    ];
    expect(numberFiles(files).get('one').pages.map((p) => p.number)).toEqual([5, 7, 9]);
  });

  it('名前で表紙と分かるファイルは、余白の番号を読んでも一覧の位置で置く（手で番号を入れれば本文）', () => {
    const cover = { ...file('cover', [3]), coverByName: true }; // 余白に刷られた巻数など
    const files = [cover, file('odd', [1, 3]), file('even', [2, 4])];

    expect(arrange(files).map((e) => [e.pageKey, e.role, e.status])[0]).toEqual(['cover:0', 'front', 'cover']);
    const manual = [{ ...cover, manual: { start: 5, step: 1 } }, ...files.slice(1)];
    expect(arrange(manual).map((e) => e.pageKey).at(-1)).toBe('cover:0');
  });

  it('本文のファイルの間にある番号の無いファイルは、本文の最後に置く（手で番号を入れれば並ぶ）', () => {
    const files = [file('odd', [1, 3]), file('x', [null, null]), file('even', [2, 4])];

    expect(arrange(files).map((e) => [e.pageKey, e.status])).toEqual([
      ['odd:0', 'detected'],
      ['even:0', 'detected'],
      ['odd:1', 'detected'],
      ['even:1', 'detected'],
      ['x:0', 'unplaced'],
      ['x:1', 'unplaced'],
    ]);
    const fixed = arrange(files, new Map([['x:1', { path: [2.5] }]]));
    expect(fixed.map((e) => [e.pageKey, e.number])).toEqual([
      ['odd:0', 1],
      ['even:0', 2],
      ['x:1', 2.5],
      ['odd:1', 3],
      ['even:1', 4],
      ['x:0', null],
    ]);
  });

  it('進み方が逆順のファイルは最後の頁から置き、結合では元の頁を引く', () => {
    const files = [
      file('cover', [null, null], { role: 'split', coverStep: -1 }),
      file('body', [1, 2]),
      file('x', [null, null, null], { coverStep: -1 }),
    ];

    expect(arrange(files).map((e) => [e.role, e.pageKey, e.pageIndex])).toEqual([
      ['front', 'cover:1', 1],
      ['body', 'body:0', 0],
      ['body', 'body:1', 1],
      ['back', 'cover:0', 0],
      ['back', 'x:2', 2],
      ['back', 'x:1', 1],
      ['back', 'x:0', 0],
    ]);
  });

  it('間にある逆順のファイルも、最後の頁から', () => {
    const files = [file('odd', [1, 3]), file('x', [null, null], { coverStep: -1 }), file('even', [2, 4])];

    expect(arrange(files).slice(-2).map((e) => e.pageKey)).toEqual(['x:1', 'x:0']);
  });

  it('結合しないファイルは並びに入れない', () => {
    const files = [file('body', [1, 2]), file('extra', [5], { role: 'exclude' })];

    expect(arrange(files).map((e) => e.fileKey)).toEqual(['body', 'body']);
  });

  it('頁ごとに手で直した番号を優先する（小数で間に入れられる）', () => {
    const order = arrange(book(), new Map([['odd-a:0', { path: [2.5] }]]));

    const at = order.findIndex((e) => e.pageKey === 'odd-a:0');
    expect(order[at]).toMatchObject({ number: 2.5, status: 'manual' });
    expect(order[at - 1].number).toBe(2);
    expect(order[at + 1].number).toBe(3);
  });

  it('頁ごとに直した番号から、同じファイルの残りの頁を決め直す', () => {
    // 読み違いだらけの奇数頁の束。1 頁直せば、偶数頁の束の歩幅を借りて残りも並ぶ。
    const files = [file('odd', [15, null, 2, null]), file('even', [2, 4, 6, 8])];
    const order = arrange(files, new Map([['odd:0', { path: [1] }]]));

    expect(order.map(labelOf)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(order.filter((e) => e.fileKey === 'odd').map((e) => e.status)).toEqual([
      'manual',
      'inferred',
      'conflict',
      'inferred',
    ]);
  });

  it('ファイルごとに番号を決めたファイルでは、頁ごとに直した番号はその頁だけ', () => {
    const files = [file('odd', [null, null, null], { manual: { start: 1, step: 2 } })];
    const order = arrange(files, new Map([['odd:0', { path: [7] }]]));

    expect(order.map(labelOf)).toEqual([3, 5, 7]);
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
    // 番号が 1 つだけ読めたファイル（歩幅を借りる束も無い）の、ほかの頁。
    const order = arrange([file('b', [null, null, 9, null])]);

    expect(order.map((e) => e.pageKey)[0]).toBe('b:2');
    expect(order.slice(-3).map((e) => [e.pageKey, e.status])).toEqual([
      ['b:0', 'unknown'],
      ['b:1', 'unknown'],
      ['b:3', 'unknown'],
    ]);
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
    expect(checkSequence(arrange([file('other', [null, 4, null])])).map((p) => [p.kind, p.level])).toEqual([
      ['unknown', 'error'],
    ]);
    expect(checkSequence(arrange([file('odd', [1, 3, 9, 7, 9])])).map((p) => [p.kind, p.level])).toContainEqual([
      'conflict',
      'warn',
    ]);
  });

  it('置き場所の決まらない頁を指摘する', () => {
    const files = [file('odd', [1, 3]), file('x', [null]), file('even', [2, 4])];
    const problem = checkSequence(arrange(files)).find((p) => p.kind === 'unplaced');

    expect(problem).toMatchObject({ level: 'error', pageKeys: ['x:0'] });
    expect(problem.message).toContain('一覧で本文のファイルより上');
  });

  it('結合する頁が無ければ指摘する', () => {
    expect(checkSequence(arrange([file('a', [1], { role: 'exclude' })])).map((p) => p.kind)).toEqual(['no-pages']);
  });

  it('本文が無ければ（一覧の順につなぐだけなら）何も指摘しない', () => {
    expect(checkSequence(arrange([file('a', [null]), file('b', [null])]))).toEqual([]);
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
      { ...file('cover', [null, null]), coverByName: true },
      file('body', [null, null, 1, 2, 3]),
    ];
    const order = buildBookOrder(files, numberFiles(files, new Map([['body:4', { path: [2.5] }]])), new Map([['body:4', { path: [2.5] }]]));
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

  it('一覧の位置で置いた、表紙と分からない頁は「番号なし」', () => {
    const order = arrange([file('body', [1, 2]), file('appendix', [null, null, null, null, null])]);

    expect(pageLabelTexts(pageLabelRanges(order), order.length)).toEqual(['1', '2', ...Array(5).fill('番号なし')]);
  });

  it('本文が無ければ付けない', () => {
    expect(pageLabelRanges(arrange([file('a', [null])]))).toEqual([]);
  });

  it('頁番号が戻ったところで分けたまとまりには、その番号を頭に付ける（ラベルが重ならない）', () => {
    const order = [
      { role: 'body', number: 1, part: 0 },
      { role: 'body', number: 1, part: 1, section: [2] },
      { role: 'body', number: 30, prefix: [4], part: 2, section: [6] },
    ];
    expect(pageLabelTexts(pageLabelRanges(order), 3)).toEqual(['1', '2-1', '6-4-30']);
  });

  it('頁番号の前に刷られた部・編などの番号で分けた部には、その番号を頭に付ける', () => {
    const order = [
      { role: 'body', number: 0, prefix: [1], part: 0 },
      { role: 'body', number: 1, prefix: [1], part: 0 },
      { role: 'body', number: 2, prefix: [1], part: 0 },
      { role: 'body', number: 1, prefix: [2], part: 1 },
      { role: 'body', number: 1, prefix: [2], branch: [1, 2], part: 1 },
    ];
    const ranges = pageLabelRanges(order);

    expect(pageLabelTexts(ranges, 5)).toEqual(['1-i', '1-1', '1-2', '2-1', '2-1-1-2']);
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
    expect([1, 2, -1, 0, 2.5, null].map((n) => sideOf(n))).toEqual(['odd', 'even', 'odd', 'even', null, null]);
  });
});

describe('枝番の頁（加除式の差し替え）', () => {
  // 49〜56、57-1〜57-4（57・58 頁の紙を差し替えたもの）、59〜62。
  const odd = () => file('odd', [49, 51, 53, 55, '57-1', '57-3', 59, 61]);
  const even = () => file('even', [62, 60, '57-4', '57-2', 56, 54, 52, 50]); // 裏返したので逆順

  it('枝番の頁を、同じ番号の頁のあと・次の番号の前に並べる', () => {
    const order = arrange([odd(), even()]);

    expect(order.map(labelOf)).toEqual([
      49, 50, 51, 52, 53, 54, 55, 56, '57-1', '57-2', '57-3', '57-4', 59, 60, 61, 62,
    ]);
    expect(order.every((entry) => entry.status === 'detected')).toBe(true);
  });

  it('差し替えられた番号は抜けとみなさず、そう読んだことを知らせる', () => {
    const problems = checkSequence(arrange([odd(), even()]), { sheets: true });

    expect(problems).toEqual([
      {
        level: 'info',
        kind: 'replaced',
        message: '57〜58 頁は無く、枝番の付いた頁（57-1〜57-4）があります。差し替えられた頁とみなしました。',
        pageKeys: ['odd:4', 'even:3', 'odd:5', 'even:2'],
        number: 57,
      },
    ]);
  });

  it('枝番の抜け・重なりを指摘する', () => {
    const files = [
      file('odd', [55, '57-1', 59]), // 57-3 を入れ忘れた
      file('even', [60, '57-4', '57-2', '57-2', 56]),
    ];
    const problems = checkSequence(arrange(files));

    expect(problems.map((p) => p.number)).toEqual(['57-2', 57, 57]);
    expect(problems.map((p) => p.message)).toEqual([
      '57-2 頁が 2 回あります（同じ束を 2 度スキャンした・番号の読み違い）。',
      '57-3 頁が見つかりません（枝番の付いた頁）。束の入れ忘れ・重送の可能性があります。',
      '57〜58 頁は無く、枝番の付いた頁（57-1〜57-4）があります。差し替えられた頁とみなしました。',
    ]);
  });

  it('抜けている枝番は、続くところを範囲で書く', () => {
    const problems = checkSequence(arrange([file('odd', [56, '57-1', '57-5', '57-7', '57-123', 59])]));

    expect(problems.find((p) => p.kind === 'missing').message).toBe(
      '57-2〜57-4・57-6・57-8〜57-122 頁が見つかりません（枝番の付いた頁）。束の入れ忘れ・重送の可能性があります。'
    );
    // 入れ子の枝番は、上の段ごとにまとめる（並びは番号の順のまま）。
    const nested = checkSequence(arrange([file('odd', [56, '57-1', '57-3-5', '57-5', 59])]));
    expect(nested.find((p) => p.kind === 'missing').message).toBe(
      '57-2・57-3-1〜57-3-4 頁が見つかりません（枝番の付いた頁）。束の入れ忘れ・重送の可能性があります。'
    );
  });

  it('枝番の頁で始まる・終わる束は、紙の表と裏を枝番で確かめる', () => {
    const problems = checkSequence(arrange([file('mid', ['57-2', '57-3'])]), { sheets: true });

    expect(problems.filter((p) => p.level === 'warn').map((p) => p.message)).toEqual([
      '最初の頁が偶数（57-2 頁）です。その表（57-1 頁）が欠けていないか確かめてください。',
      '最後の頁が奇数（57-3 頁）です。その裏（57-4 頁）が欠けていないか確かめてください（裏が白紙でスキャンしていない場合は問題ありません）。',
    ]);
  });

  it('枝番の頁を手で決められる', () => {
    const files = [file('body', [55, 56, null, 58])];
    const order = arrange(files, new Map([['body:2', { path: [57, 2] }]]));

    expect(order.map(labelOf)).toEqual([55, 56, '57-2', 58]);
    expect(order[2].status).toBe('manual');
  });

  it('頁ラベルは「57-」を頭に付けた番号', () => {
    const order = arrange([odd(), even()]);

    expect(pageLabelTexts(pageLabelRanges(order), order.length).slice(6, 14)).toEqual([
      '55', '56', '57-1', '57-2', '57-3', '57-4', '59', '60',
    ]);
    expect(pageLabelRanges(order)).toContainEqual({ start: 8, style: 'D', prefix: '57-', first: 1 });
  });

  it('番号の頁もあれば、枝番の頁は差し込まれたもの（抜けも差し替えも無い）', () => {
    const order = arrange([file('all', [55, 56, '56-1', '56-2', 57, 58])]);

    expect(order.map(labelOf)).toEqual([55, 56, '56-1', '56-2', 57, 58]);
    expect(checkSequence(order)).toEqual([]);
  });

  it('番号の頁があるなら、その裏が無いのは抜け（差し替えとみなさない）', () => {
    const problems = checkSequence(arrange([file('all', [56, 57, '57-1', '57-2', 59])]));

    expect(problems.map((p) => p.kind)).toEqual(['missing']);
    expect(problems[0].numbers).toEqual([58]);
  });

  it('束が枝番の頁で終われば、その先の番号を差し替えとは言わない', () => {
    const problems = checkSequence(arrange([file('all', [56, '57-1', '57-2'])]));

    expect(problems.map((p) => p.message)).toEqual([
      '57 頁は無く、枝番の付いた頁（57-1〜57-2）があります。差し替えられた頁とみなしました。',
    ]);
  });

  it('枝番の頁の表は奇数側、裏は偶数側', () => {
    expect([sideOf(56, [1]), sideOf(57, [2]), sideOf(57, [1, 2])]).toEqual(['odd', 'even', 'even']);
  });

  it('偶数の番号の枝番は、その番号だけを差し替えたとみなす', () => {
    const { replaced } = branchLayout([{ number: 55 }, { number: 56, branch: [1] }, { number: 56, branch: [2] }]);

    expect([...replaced]).toEqual([[56, 56]]);
  });
});
