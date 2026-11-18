// PDF 結合ツール: 部（頁番号の振り直し）の推定。
//
// 部が変わるところで頁番号が 1 から振り直されている本を、奇数頁・偶数頁の束に
// 分けてスキャンした形（束が部をまたぐ・裏返して逆順）を組み立て、1 冊の順に
// 並ぶこと、撮り直しや 2 度入れを部の始まりと取り違えないことを縛る。

import { describe, expect, it } from 'vitest';
import { arrangeBook, checkSequence, numberFiles, pageLabelRanges } from '../src/pdf-book-merger/ordering.js';
import { assignParts } from '../src/pdf-book-merger/parts.js';
import { displayLabel } from '../src/pdf-book-merger/review.js';

/**
 * ファイル 1 つ。numbers は頁ごとに読めた番号（null は読めなかった頁）。
 * heads は頁ごとの柱の文字、texts は頁ごとの文字情報（同じ文字なら同じ頁）。
 */
function file(key, numbers, { heads = [], texts = [], role = 'body', manual = null } = {}) {
  return {
    key,
    role,
    manual,
    pages: numbers.map((value, index) => ({
      key: `${key}:${index}`,
      candidates: value === null ? [] : [{ value, score: 3.5, source: 'text', zone: 'bottom' }],
      heads: heads[index] ?? [],
      signature: texts[index] ? { length: 40, hash: texts[index] } : { length: 0, hash: '' },
    })),
  };
}

function arrange(files) {
  const { order, mismatch } = arrangeBook(files, numberFiles(files));
  return { order, mismatch, problems: checkSequence(order, { sheets: true, mismatch }) };
}

/** 本文の頁を「部:番号」で並べる。 */
const labels = (order) => order.map((e) => (e.part === null ? `${e.number}` : `${e.part}:${e.number}`));

describe('部の推定', () => {
  // 第 1 部 1〜12 頁、第 2 部 1〜8 頁。奇数頁を 3 回、偶数頁を裏返して 3 回。
  // 2 回目の奇数頁の束と、2 回目の偶数頁の束が部をまたぐ。
  const book = () => [
    file('o1', [1, 3, 5]),
    file('o2', [7, 9, 11, 1, 3]),
    file('o3', [5, 7]),
    file('e1', [8, 6]), // 第 2 部
    file('e2', [4, 2, 12, 10]), // 第 2 部の 4, 2 → 第 1 部の 12, 10
    file('e3', [8, 6, 4, 2]), // 第 1 部
  ];

  it('束が部をまたいでも、部・番号の順に並べる', () => {
    const { order, problems, mismatch } = arrange(book());

    expect(labels(order)).toEqual([
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `0:${n}`),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `1:${n}`),
    ]);
    expect(mismatch).toBe(false);
    expect(problems.map((p) => [p.kind, p.level])).toEqual([['parts', 'warn']]);
    expect(problems[0].message).toContain('2 部に分けて並べました（第 1 部 1〜12 頁・第 2 部 1〜8 頁）');
    expect(displayLabel(order[12])).toBe('第 2 部 1 頁');
    expect(pageLabelRanges(order)).toEqual([]);
  });

  it('1 頁ずつのファイルは、借りた歩幅が逆順でも一覧の順を本の順と見る', () => {
    // 奇数頁は 1 頁ずつのファイル（歩幅を、裏返した偶数頁の束から借りる）。
    const files = [
      file('a1', [1]), file('a3', [3]), file('a5', [5]), file('a7', [7]), file('a9', [9]),
      file('b1', [1]), file('b3', [3]), file('b5', [5]),
      file('e2', [6, 4, 2]), // 第 2 部
      file('e1', [10, 8, 6, 4, 2]), // 第 1 部
    ];
    const { order } = arrange(files);

    expect(order.filter((e) => e.part === 0).map((e) => e.fileKey)).toEqual([
      'a1', 'e1', 'a3', 'e1', 'a5', 'e1', 'a7', 'e1', 'a9', 'e1',
    ]);
  });

  it('一覧の順が入れ替わっていても、番号のつながりで並べる', () => {
    const { order } = arrange(book().reverse());

    expect(labels(order).slice(10, 14)).toEqual(['0:11', '0:12', '1:1', '1:2']);
  });

  it('部の境目が束の境目なら、一覧で上にある束から第 1 部にする', () => {
    const files = [file('a', [1, 2, 3, 4]), file('b', [5, 6]), file('c', [1, 2, 3]), file('d', [4, 5])];
    const { order } = arrange(files);

    expect(order.map((e) => `${e.part}:${e.pageKey}`)).toEqual([
      '0:a:0', '0:a:1', '0:a:2', '0:a:3', '0:b:0', '0:b:1',
      '1:c:0', '1:c:1', '1:c:2', '1:d:0', '1:d:1',
    ]);
  });

  it('続きの候補がいくつもあれば、柱の文字が続いているほうを選ぶ', () => {
    const one = ['第一部 総論'];
    const two = ['第二部 各論'];
    const files = [
      file('a', [1, 2, 3, 4], { heads: [one, one, one, one] }),
      file('d', [5, 6], { heads: [two, two] }), // 一覧では d のほうが a に近い
      file('b', [5, 6], { heads: [one, one] }),
      file('c', [1, 2, 3, 4], { heads: [two, two, two, two] }),
    ];
    const { order } = arrange(files);

    expect(order.filter((e) => e.part === 0).map((e) => e.fileKey)).toEqual(['a', 'a', 'a', 'a', 'b', 'b']);
  });

  it('続きの候補との間に部の最初へ戻る束があれば、候補はその次の部の続き', () => {
    // 第 1 部 1〜40 頁、第 2 部 1〜80 頁。奇数頁の 1 束目が第 1 部ちょうどで終わる。
    const files = [
      file('o1', [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37, 39]),
      file('o2', [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37, 39]),
      file('o3', [41, 43, 45, 47, 49]),
      file('e1', [50, 48, 46, 44, 42, 40, 38, 36, 34, 32, 30, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10, 8, 6, 4, 2]),
      file('e2', [40, 38, 36, 34, 32, 30, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10, 8, 6, 4, 2]),
    ];
    const { order, mismatch } = arrange(files);

    expect(mismatch).toBe(false);
    expect(order.filter((e) => e.fileKey === 'o3').map((e) => e.part)).toEqual([1, 1, 1, 1, 1]);
    expect(checkSequence(order, { sheets: true }).map((p) => p.kind)).toEqual(['parts']);
  });

  it('柱の文字が無ければ、一覧で近いほうを選ぶ', () => {
    const files = [file('a', [1, 2, 3, 4]), file('d', [5, 6]), file('b', [5, 6]), file('c', [1, 2, 3, 4])];
    const { order } = arrange(files);

    expect(order.filter((e) => e.part === 0).map((e) => e.fileKey)).toEqual(['a', 'a', 'a', 'a', 'd', 'd']);
  });

  it('途中まで戻った束は撮り直し（重なる部の重なりとして指摘する）', () => {
    const files = [file('a', [1, 2, 3, 4, 5, 6]), file('again', [3, 4]), file('c', [1, 2, 3])];
    const { order, problems } = arrange(files);

    expect(order.filter((e) => e.fileKey === 'again').map((e) => e.part)).toEqual([0, 0]);
    expect(problems.filter((p) => p.kind === 'duplicate').map((p) => p.message)).toEqual([
      '第 1 部の 3 頁が 2 回あります（同じ束を 2 度スキャンした・番号の読み違い）。',
      '第 1 部の 4 頁が 2 回あります（同じ束を 2 度スキャンした・番号の読み違い）。',
    ]);
  });

  it('2 枚目から撮り直した束を、部の始まりと取り違えない（文字情報が無くても）', () => {
    const files = [
      file('o1', [1, 3, 5, 7, 9, 11]),
      file('o2', [3, 5]), // 撮り直し
      file('e1', [12, 10, 8, 6, 4, 2]),
      file('e2', [6, 4]), // 撮り直し
    ];
    const { order, problems, mismatch } = arrange(files);

    expect(mismatch).toBe(false);
    expect(order.every((e) => e.part === null)).toBe(true);
    expect(problems.filter((p) => p.kind === 'duplicate')).toHaveLength(4);
  });

  it('偶数頁の束の部の始まりは 2 頁（前付けがあればその番号）', () => {
    const files = [
      file('o1', [-3, -1, 1, 3, 5, 7, 1, 3, 5]),
      file('e1', [-2, 0, 2, 4, 6, 8, 2, 4, 6]),
    ];
    const { order, mismatch } = arrange(files);

    expect(mismatch).toBe(false);
    expect(labels(order)).toEqual([
      ...[-3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => `0:${n}`),
      ...[1, 2, 3, 4, 5, 6].map((n) => `1:${n}`),
    ]);
  });

  it('両面の束（前付けだけ、など）は、奇数頁・偶数頁の束と部の数を比べない', () => {
    const files = [file('fm', [-3, -2, -1, 0]), file('o1', [1, 3, 5, 7, 1, 3, 5]), file('e1', [2, 4, 6, 8, 2, 4, 6])];
    const { order, mismatch } = arrange(files);

    expect(mismatch).toBe(false);
    expect(labels(order)).toEqual([
      ...[-3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => `0:${n}`),
      ...[1, 2, 3, 4, 5, 6].map((n) => `1:${n}`),
    ]);
  });

  it('最初から撮り直した束を奇数頁・偶数頁とも入れると、部に分けたことを注意として知らせる（抜けにも表れる）', () => {
    const files = [
      file('o1', [1, 3, 5]),
      file('o1-again', [1, 3, 5]),
      file('o2', [7, 9, 11]),
      file('e1', [6, 4, 2]),
      file('e1-again', [6, 4, 2]),
      file('e2', [12, 10, 8]),
    ];
    const { problems } = arrange(files);

    // 番号だけでは 2 部の本と見分けられない（文字情報があれば 2 度入れたと分かる）が、
    // 一覧の順に従うと続きの束が後の部に入るので、抜けとしても表れる。
    expect(problems.filter((p) => p.kind === 'missing').map((p) => p.level)).toEqual(['error', 'error']);
    const parts = problems.find((p) => p.kind === 'parts');
    expect(parts.level).toBe('warn');
    expect(parts.message).toContain('同じ束を最初から 2 度入れていないか');
  });

  it('部の境目が束の境目でも、裏返した偶数頁の束は一覧の下から本の順に並べる', () => {
    // 偶数頁は束を裏返して最後の束からスキャンするので、一覧の上ほど本の後ろ。
    const files = [
      file('o1', [1, 3, 5]),
      file('o2', [7, 9]),
      file('o3', [1, 3]),
      file('o4', [5]),
      file('e1', [6, 4]), // 第 2 部
      file('e2', [2]), // 第 2 部
      file('e3', [10, 8]), // 第 1 部
      file('e4', [6, 4, 2]), // 第 1 部
    ];
    const { order, mismatch } = arrange(files);

    expect(mismatch).toBe(false);
    expect(labels(order)).toEqual([
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `0:${n}`),
      ...[1, 2, 3, 4, 5, 6].map((n) => `1:${n}`),
    ]);
  });

  it('両面でスキャンした本の一部を片面ずつ撮り直しても、両面の束の部で分ける', () => {
    // 第 1 部 1〜6 頁、第 2 部 1〜4 頁を両面で。第 1 部の 3〜6 頁の紙だけ、片面ずつ撮り直した。
    const files = [file('d1', [1, 2, 3, 4, 5, 6, 1, 2, 3, 4]), file('o', [3, 5]), file('e', [6, 4])];
    const { mismatch, order } = arrange(files);

    expect(mismatch).toBe(false);
    expect(order.filter((e) => e.part === 1).map((e) => e.number)).toEqual([1, 2, 3, 4]);
  });

  it('枝番の頁から始まる偶数頁の束も、偶数頁の束として部を数える', () => {
    // 第 2 部の偶数頁の束が、枝番の頁 1-2 から始まる（奇数頁の束と見ると、部の数が揃わない）。
    const e2 = file('e2', [null, 2, 4]);
    e2.pages[0].candidates = [{ value: 1, branch: 2, score: 3.5, source: 'text', zone: 'bottom' }];
    const files = [file('o1', [1, 3, 1, 3]), file('e1', [2, 4]), e2];
    const { mismatch, order } = arrange(files);

    expect(mismatch).toBe(false);
    expect(new Set(order.map((e) => e.part))).toEqual(new Set([0, 1]));
  });

  it('枝番の頁だけの束は、枝番の偶奇で奇数頁・偶数頁の束を見分ける', () => {
    // 5・6 頁の紙を差し替えた 5-1〜5-4。その裏（5-2, 5-4）だけの束。
    const branched = (key, pairs) => {
      const f = file(key, pairs.map(() => null));
      pairs.forEach(([value, branch], i) => {
        f.pages[i].candidates = [{ value, branch, score: 3.5, source: 'text', zone: 'bottom' }];
      });
      return f;
    };
    const files = [
      file('o1', [1, 3, 7, 1, 3]),
      file('e1', [2, 4]),
      branched('e2', [[5, 2], [5, 4]]),
      file('e3', [8, 10]),
      file('e4', [2, 4]), // 第 2 部
    ];
    const { order, mismatch } = arrange(files);

    expect(mismatch).toBe(false);
    expect(order.filter((e) => e.fileKey === 'e2').map((e) => e.part)).toEqual([0, 0]);
  });

  it('部の最初の紙が枝番の頁に差し替えられていても、部の始まりと分かる', () => {
    const files = [file('o1', [1, 3, 5, 7]), file('o2', [null, null, 3, 5]), file('e1', [2, 4, 6, 8]), file('e2', [null, null, 4, 6])];
    const put = (f, i, value, branch) => (f.pages[i].candidates = [{ value, branch, score: 3.5, source: 'text', zone: 'bottom' }]);
    // 第 2 部の 1・2 頁の紙が 1-1〜1-4 に差し替えられた。
    put(files[1], 0, 1, 1);
    put(files[1], 1, 1, 3);
    put(files[3], 0, 1, 2);
    put(files[3], 1, 1, 4);
    const { order, mismatch } = arrange(files);

    expect(mismatch).toBe(false);
    expect(order.filter((e) => e.fileKey === 'o2').map((e) => e.part)).toEqual([1, 1, 1, 1]);
  });

  it('枝番の無い頁がある束は、その頁の番号で奇数頁・偶数頁の束を見分ける（枝番の読み違いに引きずられない）', () => {
    const e1 = file('e1', [null, 2, 4, 6, 8]);
    e1.pages[0].candidates = [{ value: 2, branch: 1, score: 3.5, source: 'text', zone: 'bottom' }]; // 余白の「2-1」
    const files = [file('o1', [1, 3, 5, 7, 1, 3]), e1, file('e2', [2, 4])];
    const { mismatch } = arrange(files);

    expect(mismatch).toBe(false);
  });

  it('枝番の頁で終わる束も、同じ側の続きの束につなぐ（一覧の順が入れ替わっていても）', () => {
    // 第 1 部 1〜10 頁（5・6 頁の紙を 5-1〜5-4 に差し替え）、第 2 部 1〜4 頁。
    const withBranches = (key, values) => {
      const f = file(key, values.map((v) => (Array.isArray(v) ? null : v)));
      values.forEach((v, i) => {
        if (Array.isArray(v)) f.pages[i].candidates = [{ value: v[0], branch: v[1], score: 3.5, source: 'text', zone: 'bottom' }];
      });
      return f;
    };
    const files = [
      withBranches('o1', [1, 3, [5, 1], [5, 3], 7, 9, 1, 3]),
      file('e2', [8, 10]),
      withBranches('e1', [2, 4, [5, 2], [5, 4]]),
      file('e3', [2, 4]),
    ];
    const { order, problems } = arrange(files);

    expect(order.filter((e) => e.fileKey === 'e2').map((e) => e.part)).toEqual([0, 0]);
    expect(problems.filter((p) => p.kind === 'missing')).toEqual([]);
  });

  it('両面の束の枝番の頁（1-1〜1-4）では、部を切らない', () => {
    const f = file('a', [null, null, null, null, 2, 3, 4, 5]);
    [1, 2, 3, 4].forEach((b, i) => (f.pages[i].candidates = [{ value: 1, branch: b, score: 3.5, source: 'text', zone: 'bottom' }]));
    const { order } = arrange([f]);

    expect(order.every((e) => e.part === null)).toBe(true);
  });

  it('枝番の並びの途中で束が切れても、続きの束につなぐ', () => {
    // 第 1 部の奇数頁 1, 3 | 5, 7-1, 7-3 | 7-5, 7-7, 9, 11 | 13, 15。第 2 部の奇数頁 1, 3 | 5, 7。
    const withBranches = (key, values) => {
      const f = file(key, values.map((v) => (Array.isArray(v) ? null : v)));
      values.forEach((v, i) => {
        if (Array.isArray(v)) f.pages[i].candidates = [{ value: v[0], branch: v[1], score: 3.5, source: 'text', zone: 'bottom' }];
      });
      return f;
    };
    const files = [
      file('o0', [1, 3]),
      withBranches('o1', [5, [7, 1], [7, 3]]),
      withBranches('o3', [[7, 5], [7, 7], 9, 11]),
      file('o5', [13, 15]),
      file('o2', [1, 3]),
      file('o4', [5, 7]),
    ];
    const parts = assignParts(files, numberFiles(files));

    expect(['o0', 'o1', 'o3', 'o5', 'o2', 'o4'].map((key) => parts.partOf.get(`${key}:0`))).toEqual([0, 0, 0, 0, 1, 1]);
  });

  it('元の頁のあとに足した枝番の頁から始まる束も、前の束の続きにつなぐ', () => {
    // 第 1 部の偶数頁 2, 4, 6 | 6-2, 6-4, 8（6 のあとに足した紙）。第 2 部の偶数頁 2, 4, 6, 8。
    const e2 = file('e2', [null, null, 8]);
    [2, 4].forEach((b, i) => (e2.pages[i].candidates = [{ value: 6, branch: b, score: 3.5, source: 'text', zone: 'bottom' }]));
    const files = [file('o1', [1, 3, 5, 7, 1, 3, 5, 7]), file('e1', [2, 4, 6]), e2, file('e3', [2, 4, 6, 8])];
    const parts = assignParts(files, numberFiles(files));

    expect(['e1:0', 'e2:0', 'e2:2', 'e3:0'].map((key) => parts.partOf.get(key))).toEqual([0, 0, 0, 1]);
  });

  it('偶数の頁の奇数側の枝番の頁（6-1）で終わる束も、次の束（7 から）につなぐ', () => {
    // 第 1 部の奇数頁 1, 3, 5, 6-1（6 のあとに足した紙の表。位置は 7）| 7, 9, 11。第 2 部 1, 3, 5。
    const a = file('a', [1, 3, 5, null]);
    a.pages[3].candidates = [{ value: 6, branch: 1, score: 3.5, source: 'text', zone: 'bottom' }];
    const files = [a, file('b', [7, 9, 11]), file('c', [1, 3, 5])];
    const parts = assignParts(files, numberFiles(files));

    expect(['a:0', 'b:0', 'c:0'].map((key) => parts.partOf.get(key))).toEqual([0, 0, 1]);
  });

  it('撮り直しの重なりは、枝番まで同じ頁で数える', () => {
    const withBranches = (key, values) => {
      const f = file(key, values.map((v) => (Array.isArray(v) ? null : v)));
      values.forEach((v, i) => {
        if (Array.isArray(v)) f.pages[i].candidates = [{ value: v[0], branch: v[1], score: 3.5, source: 'text', zone: 'bottom' }];
      });
      return f;
    };
    // 両面の束。第 1 部に 3-1, 3-2、第 2 部は 3 のまま。第 1 部の枝番の頁を撮り直した。
    const files = [
      withBranches('a', [1, 2, [3, 1], [3, 2], 4]),
      file('c', [1, 2, 3, 4]),
      withBranches('again', [[3, 1], [3, 2]]),
    ];
    const { order } = arrange(files);

    expect(order.filter((e) => e.fileKey === 'again').map((e) => e.part)).toEqual([0, 0]);
  });

  it('ファイルの中で途中まで戻ったところも、撮り直し', () => {
    const { order, problems } = arrange([file('a', [1, 2, 3, 4, 3, 4, 5])]);

    expect(order.every((e) => e.part === null)).toBe(true);
    expect(problems.filter((p) => p.kind === 'duplicate')).toHaveLength(2);
  });

  it('部の途中の束を入れ忘れても、その先の束を次の部と取り違えない', () => {
    // 第 1 部 1〜12 頁、第 2 部 1〜8 頁。第 1 部の 5〜8 頁の束が無い。
    const files = [
      file('o1', [1, 3]),
      file('o3', [9, 11]),
      file('o4', [1, 3, 5, 7]),
      // 偶数頁は裏返して、本の後ろの束からスキャンする。
      file('e1', [8, 6, 4, 2]), // 第 2 部
      file('e2', [12, 10, 8, 6]), // 第 1 部
      file('e3', [4, 2]), // 第 1 部
    ];
    const { order, problems } = arrange(files);

    expect(order.filter((e) => e.fileKey === 'o3').map((e) => e.part)).toEqual([0, 0]);
    expect(problems.find((p) => p.kind === 'missing').message).toContain('第 1 部の 5・7 頁');
  });

  it('束が抜けていても、同じ部の抜けとして指摘する', () => {
    const { order, problems } = arrange([file('a', [1, 2, 3]), file('c', [7, 8, 9])]);

    expect(order.every((e) => e.part === null)).toBe(true);
    expect(problems.find((p) => p.kind === 'missing').numbers).toEqual([4, 5, 6]);
  });

  it('奇数頁と偶数頁で戻る回数が揃わなければ、部に分けない', () => {
    const files = [file('o1', [1, 3, 5]), file('e1', [6, 4, 2]), file('o1-again', [1, 3, 5])];
    const { order, problems, mismatch } = arrange(files);

    expect(mismatch).toBe(true);
    expect(order.every((e) => e.part === null)).toBe(true);
    expect(problems.map((p) => p.kind)).toEqual(['duplicate', 'duplicate', 'duplicate', 'parts-mismatch']);
  });

  it('文字情報まで同じ束は 2 度入れたもの（部の始まりと取り違えない）', () => {
    const texts = ['p1', 'p2', 'p3'];
    const files = [
      file('a', [1, 2, 3], { texts }),
      file('a-again', [1, 2, 3], { texts }),
      file('c', [1, 2], { texts: ['q1', 'q2'] }),
    ];
    const { order } = arrange(files);

    expect(order.map((e) => `${e.part}:${e.pageKey}`)).toEqual([
      '0:a:0', '0:a-again:0', '0:a:1', '0:a-again:1', '0:a:2', '0:a-again:2',
      '1:c:0', '1:c:1',
    ]);
  });

  it('番号だけの白紙のような短い文字の頁は、同じでも 2 度入れたものとは見ない', () => {
    const files = [file('a', [1, 2, 3]), file('c', [1, 2])];
    for (const f of files) f.pages.forEach((p, i) => (p.signature = { length: 2, hash: `blank${i}` }));
    const { order } = arrange(files);

    expect(order.filter((e) => e.fileKey === 'c').map((e) => e.part)).toEqual([1, 1]);
  });

  it('1 頁だけ文字が同じ（定型の文の頁など）でも、2 度入れたものとは見ない', () => {
    const files = [file('a', [1, 2, 3], { texts: ['p1', 'notice', 'p3'] }), file('c', [1, 2], { texts: ['q1', 'notice'] })];
    // c の 2 頁目は a の 2 頁目と同じ文字でも、c は第 2 部（1 頁目は違う文字）。
    const { order } = arrange(files);
    expect(order.filter((e) => e.fileKey === 'c').map((e) => e.part)).toEqual([1, 1]);
    // 1 頁のファイルは、同じ文字でも 2 度入れたとは見ない。
    const single = [file('a', [1, 2, 3], { texts: ['p1', 'p2', 'p3'] }), file('b', [1], { texts: ['p1'] })];
    expect(arrange(single).order.filter((e) => e.fileKey === 'b').map((e) => e.part)).toEqual([1]);
  });

  it('文字情報が一部だけ同じ束は、2 度入れたものとは見ない', () => {
    const files = [
      file('a', [1, 2, 3], { texts: ['p1', 'p2', 'p3'] }),
      file('b', [3, 4], { texts: ['p3', 'q4'] }), // 3 頁だけ撮り直して続けた
      file('c', [3, 4], { texts: ['p3', 'q4'] }), // b を 2 度入れた
    ];
    const { order } = arrange(files);

    expect(order.map((e) => `${e.part}:${e.pageKey}`)).toEqual(['null:a:0', 'null:a:1', 'null:a:2', 'null:b:0', 'null:c:0', 'null:b:1', 'null:c:1']);
  });

  it('続きの候補が一覧で同じ近さなら、上にあるほう', () => {
    const files = [file('c', [5, 6]), file('a', [1, 2, 3, 4]), file('b', [5, 6]), file('d', [1, 2, 3, 4])];
    const { order } = arrange(files);

    expect(order.filter((e) => e.part === 0).map((e) => e.fileKey)).toEqual(['a', 'a', 'a', 'a', 'c', 'c']);
  });

  it('撮り直しの束は、重なりが同じなら一覧で近い部に入れる', () => {
    const files = [file('a', [1, 2, 3, 4, 5, 6]), file('c', [1, 2, 3, 4, 5, 6]), file('again', [3, 4])];
    const { order } = arrange(files);

    expect(order.filter((e) => e.fileKey === 'again').map((e) => e.part)).toEqual([1, 1]);
  });

  it('頁ごとに手で直した番号も、番号のつながりで部を決める', () => {
    // 番号の無い頁に 3 を入れると、第 2 部の 2 頁の続きになる。
    const files = [file('a', [1, 2, 3, 1, 2]), file('x', [null]), file('b', [4, 5])];
    const overrides = new Map([['x:0', { number: 3 }]]);
    const { order } = arrangeBook(files, numberFiles(files, overrides), overrides);

    expect(labels(order)).toEqual(['0:1', '0:2', '0:3', '1:1', '1:2', '1:3', '1:4', '1:5']);
    expect(order[5].pageKey).toBe('x:0');
    // 読み違えた 1 頁（4 を 1 と読んだ）で部を切らない。直せば 1 部に戻る。
    const misread = [file('c', [1, 2, 3]), file('d', [1]), file('e', [5, 6])];
    expect(arrangeBook(misread, numberFiles(misread)).order.some((e) => e.part === 1)).toBe(true);
    const fixed = arrangeBook(misread, numberFiles(misread, new Map([['d:0', { number: 4 }]])), new Map([['d:0', { number: 4 }]])).order;
    expect(fixed.every((e) => e.part === null)).toBe(true);
  });

  it('番号が 1 つしか読めないファイルだけなら、部は 1 つ', () => {
    const files = [file('a', [null, 5, null])];
    const parts = assignParts(files, numberFiles(files));

    expect(parts).toMatchObject({ count: 1, mismatch: false });
    expect([...parts.partOf.values()]).toEqual([0, 0, 0]);
  });
});
