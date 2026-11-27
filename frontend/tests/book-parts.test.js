// PDF 結合ツール: 部（頁番号の振り直し）の推定。
//
// 部が変わるところで頁番号が 1 から振り直されている本を、奇数頁・偶数頁の束に
// 分けてスキャンした形（束が部をまたぐ・裏返して逆順）を組み立て、1 冊の順に
// 並ぶこと、撮り直しや 2 度入れを部の始まりと取り違えないことを縛る。

import { describe, expect, it } from 'vitest';
import { inferFileNumbers, pathText } from '../src/pdf-book-merger/page-numbers.js';
import {
  arrangeBook,
  checkSequence,
  numberFiles,
  pageLabelRanges,
  pageLabelTexts,
  withoutSection,
} from '../src/pdf-book-merger/ordering.js';
import { assignParts } from '../src/pdf-book-merger/parts.js';
import { displayLabel, gridItems, missingLabel } from '../src/pdf-book-merger/review.js';

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
      candidates: value === null ? [] : [{ path: [value], score: 3.5, source: 'text', zone: 'bottom' }],
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
    // 2 つ目の部は、番号が戻ったところで分けたまとまり「2/」として書く。
    // まとまりを分けたので、1 つ目のまとまりにも番号「1-」を付ける（部の番号の無い本の最初は 1）。
    expect(problems[0].message).toContain('（1-1〜1-12 頁・2-1〜2-8 頁）');
    expect(displayLabel(order[11])).toBe('1-12 頁');
    expect(displayLabel(order[12])).toBe('2-1 頁');
    // まとまりの番号を頭に付けるので、頁ラベルも重ならずに付けられる。
    expect(pageLabelTexts(pageLabelRanges(order), order.length).slice(10, 14)).toEqual(['1-11', '1-12', '2-1', '2-2']);
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
      '1-3 頁が 2 回あります（同じ束を 2 度スキャンした・番号の読み違い）。',
      '1-4 頁が 2 回あります（同じ束を 2 度スキャンした・番号の読み違い）。',
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
    e2.pages[0].candidates = [{ path: [1, 2], score: 3.5, source: 'text', zone: 'bottom' }];
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
        f.pages[i].candidates = [{ path: [value, branch], score: 3.5, source: 'text', zone: 'bottom' }];
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
    const put = (f, i, value, branch) => (f.pages[i].candidates = [{ path: [value, branch], score: 3.5, source: 'text', zone: 'bottom' }]);
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
    e1.pages[0].candidates = [{ path: [2, 1], score: 3.5, source: 'text', zone: 'bottom' }]; // 余白の「2-1」
    const files = [file('o1', [1, 3, 5, 7, 1, 3]), e1, file('e2', [2, 4])];
    const { mismatch } = arrange(files);

    expect(mismatch).toBe(false);
  });

  it('枝番の頁で終わる束も、同じ側の続きの束につなぐ（一覧の順が入れ替わっていても）', () => {
    // 第 1 部 1〜10 頁（5・6 頁の紙を 5-1〜5-4 に差し替え）、第 2 部 1〜4 頁。
    const withBranches = (key, values) => {
      const f = file(key, values.map((v) => (Array.isArray(v) ? null : v)));
      values.forEach((v, i) => {
        if (Array.isArray(v)) f.pages[i].candidates = [{ path: [v[0], v[1]], score: 3.5, source: 'text', zone: 'bottom' }];
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
    [1, 2, 3, 4].forEach((b, i) => (f.pages[i].candidates = [{ path: [1, b], score: 3.5, source: 'text', zone: 'bottom' }]));
    const { order } = arrange([f]);

    expect(order.every((e) => e.part === null)).toBe(true);
  });

  it('枝番の並びの途中で束が切れても、続きの束につなぐ', () => {
    // 第 1 部の奇数頁 1, 3 | 5, 7-1, 7-3 | 7-5, 7-7, 9, 11 | 13, 15。第 2 部の奇数頁 1, 3 | 5, 7。
    const withBranches = (key, values) => {
      const f = file(key, values.map((v) => (Array.isArray(v) ? null : v)));
      values.forEach((v, i) => {
        if (Array.isArray(v)) f.pages[i].candidates = [{ path: [v[0], v[1]], score: 3.5, source: 'text', zone: 'bottom' }];
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
    [2, 4].forEach((b, i) => (e2.pages[i].candidates = [{ path: [6, b], score: 3.5, source: 'text', zone: 'bottom' }]));
    const files = [file('o1', [1, 3, 5, 7, 1, 3, 5, 7]), file('e1', [2, 4, 6]), e2, file('e3', [2, 4, 6, 8])];
    const parts = assignParts(files, numberFiles(files));

    expect(['e1:0', 'e2:0', 'e2:2', 'e3:0'].map((key) => parts.partOf.get(key))).toEqual([0, 0, 0, 1]);
  });

  it('偶数の頁の奇数側の枝番の頁（6-1）で終わる束も、次の束（7 から）につなぐ', () => {
    // 第 1 部の奇数頁 1, 3, 5, 6-1（6 のあとに足した紙の表。位置は 7）| 7, 9, 11。第 2 部 1, 3, 5。
    const a = file('a', [1, 3, 5, null]);
    a.pages[3].candidates = [{ path: [6, 1], score: 3.5, source: 'text', zone: 'bottom' }];
    const files = [a, file('b', [7, 9, 11]), file('c', [1, 3, 5])];
    const parts = assignParts(files, numberFiles(files));

    expect(['a:0', 'b:0', 'c:0'].map((key) => parts.partOf.get(key))).toEqual([0, 0, 1]);
  });

  it('撮り直しの重なりは、枝番まで同じ頁で数える', () => {
    const withBranches = (key, values) => {
      const f = file(key, values.map((v) => (Array.isArray(v) ? null : v)));
      values.forEach((v, i) => {
        if (Array.isArray(v)) f.pages[i].candidates = [{ path: [v[0], v[1]], score: 3.5, source: 'text', zone: 'bottom' }];
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
    expect(problems.find((p) => p.kind === 'missing').message).toMatch(/^1-5・1-7 頁/);
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
    const overrides = new Map([['x:0', { path: [3] }]]);
    const { order } = arrangeBook(files, numberFiles(files, overrides), overrides);

    expect(labels(order)).toEqual(['0:1', '0:2', '0:3', '1:1', '1:2', '1:3', '1:4', '1:5']);
    expect(order[5].pageKey).toBe('x:0');
    // 読み違えた 1 頁（4 を 1 と読んだ）で部を切らない。直せば 1 部に戻る。
    const misread = [file('c', [1, 2, 3]), file('d', [1]), file('e', [5, 6])];
    expect(arrangeBook(misread, numberFiles(misread)).order.some((e) => e.part === 1)).toBe(true);
    const fixed = arrangeBook(misread, numberFiles(misread, new Map([['d:0', { path: [4] }]])), new Map([['d:0', { path: [4] }]])).order;
    expect(fixed.every((e) => e.part === null)).toBe(true);
  });

  it('番号が 1 つしか読めないファイルだけなら、部は 1 つ', () => {
    const files = [file('a', [null, 5, null])];
    const parts = assignParts(files, numberFiles(files));

    expect(parts).toMatchObject({ count: 1, mismatch: false });
    expect([...parts.partOf.values()]).toEqual([0, 0, 0]);
  });
});

describe('頁番号の前に刷られた部・編などの番号（2-21）', () => {
  /** ハイフンで区切った番号（'2-21'。null は読めなかった頁）で読めたファイル。 */
  const printed = (key, labels, options = {}) => {
    const f = file(key, labels.map(() => null), options);
    labels.forEach((label, i) => {
      if (label !== null) {
        f.pages[i].candidates = [{ path: String(label).split('-').map(Number), score: 3.5, source: 'text', zone: 'bottom' }];
      }
    });
    return f;
  };
  /** 並べて、確かめる。 */
  const arrangePrinted = (files, overrides = new Map()) => {
    const { order, mismatch } = arrangeBook(files, numberFiles(files, overrides), overrides);
    return { order, problems: checkSequence(order, { sheets: true, mismatch }) };
  };
  const text = (e) => (e.number === null ? '?' : [...(e.prefix ?? []), e.number, ...(e.branch ?? [])].join('-'));

  // 第 1 部 1-1〜1-6、第 2 部 2-1〜2-8、第 3 部 3-1〜3-4。束は部をまたぎ、偶数頁は裏返して逆順。
  const book = () => [
    printed('o1', ['1-1', '1-3', '1-5', '2-1', '2-3']),
    printed('o2', ['2-5', '2-7', '3-1', '3-3']),
    printed('e1', ['3-4', '3-2', '2-8', '2-6']),
    printed('e2', ['2-4', '2-2', '1-6', '1-4', '1-2']),
  ];

  it('前の段を部・編などの番号と読み、刷られた順に並べる（部の振り直しの注意は出さない）', () => {
    const { order, problems } = arrangePrinted(book());

    expect(order.map(text)).toEqual([
      '1-1', '1-2', '1-3', '1-4', '1-5', '1-6',
      '2-1', '2-2', '2-3', '2-4', '2-5', '2-6', '2-7', '2-8',
      '3-1', '3-2', '3-3', '3-4',
    ]);
    expect(order.map((e) => e.part)).toEqual([...Array(6).fill(0), ...Array(8).fill(1), ...Array(4).fill(2)]);
    expect(order.some((e) => 'partLabel' in e)).toBe(false);
    expect(problems.map((p) => [p.kind, p.level])).toEqual([['depth', 'info']]);
    expect(problems[0].message).toContain('（1-1 など）');
    expect(problems[0].message).toContain('（1-1〜1-6 頁・2-1〜2-8 頁・3-1〜3-4 頁）');
    expect(displayLabel(order[6])).toBe('2-1 頁');
    // 部が刷られているので、頁ラベルは部の番号を付けて付ける。
    expect(pageLabelTexts(pageLabelRanges(order), order.length).slice(5, 8)).toEqual(['1-6', '2-1', '2-2']);
  });

  it('部の中の抜けは、部の番号を付けて指摘する', () => {
    const files = book();
    files[2] = printed('e1', ['3-4', '3-2', '2-8']); // 2-6 が無い
    const { problems, order } = arrangePrinted(files);

    expect(problems.find((p) => p.kind === 'missing')).toMatchObject({
      message: '2-6 頁が見つかりません（計 1 頁）。束の入れ忘れ・重送の可能性があります。',
      number: '1',
      numbers: [6],
    });
    const card = gridItems(order).find((item) => item.type === 'missing');
    expect(missingLabel(card)).toBe('2-6 頁');
  });

  it('同じ部の番号が最初に戻れば、そこで分けて本の順ですぐ前の頁の後に置き、まとまりの番号を付ける', () => {
    // 「2-」の頁が 2 度 1 から始まる（両面の束）。「3-」の頁はそのまま。
    const files = [printed('a', ['2-1', '2-2', '2-3', '2-1', '2-2']), printed('b', ['3-1', '3-2'])];
    const { order, problems } = arrangePrinted(files);

    // まとまりの番号は、刷られた部の番号（3）と重ならないよう 4。
    expect(order.map(displayLabel)).toEqual(['2-1 頁', '2-2 頁', '2-3 頁', '4-2-1 頁', '4-2-2 頁', '3-1 頁', '3-2 頁']);
    expect(order.map((e) => e.section ?? null)).toEqual([null, null, null, [4], [4], null, null]);
    const parts = problems.find((p) => p.kind === 'parts');
    expect(parts.message).toContain('（2-1〜2-3 頁・4-2-1〜4-2-2 頁・3-1〜3-2 頁）');
    expect(problems.find((p) => p.kind === 'depth').message).not.toContain('〜');
    // まとまりの番号を頭に付けた頁ラベルを付ける。
    expect(pageLabelTexts(pageLabelRanges(order), order.length)).toEqual(['2-1', '2-2', '2-3', '4-2-1', '4-2-2', '3-1', '3-2']);
  });
  it('部の扉の頁は、手で 1-0 と入れられ、その部の頭に並ぶ', () => {
    // 両面の束。第 3 部の扉を「1-7」と読み違えた（目次の行の番号を拾った、など）。
    const files = [printed('a', ['2-5', '2-6', '2-7', '2-8', '1-7', '3-1', '3-2', '3-3'])];
    const { order } = arrangePrinted(files, new Map([['a:4', { path: [3, 0] }]]));

    expect(order.map(displayLabel)).toEqual(['2-5 頁', '2-6 頁', '2-7 頁', '2-8 頁', '3-0 頁', '3-1 頁', '3-2 頁', '3-3 頁']);
  });

  it('部の番号の付いた本で、部の番号を読めなかった束は一覧の前後の部から置いて知らせ、1 頁直せば部に入る', () => {
    const files = [...book(), printed('again', [5, 7])]; // 2-5・2-7 を撮り直した束（部の番号を読めなかった）
    const { order, problems } = arrangePrinted(files);

    // 本の順ですぐ前の奇数頁の束（2-5〜3-3）の後に、まとまり「4/」として置く（裏返した偶数頁の
    // 束は一覧で下にあるほど本の前なので、奇数頁の束どうしで比べる）。
    const again = order.filter((e) => e.fileKey === 'again');
    expect(again.map(displayLabel)).toEqual(['4-5 頁', '4-7 頁']);
    expect(order.slice(-2)).toEqual(again);
    expect(problems.find((p) => p.kind === 'parts').message).toContain('4-5〜4-7 頁');
    const overrides = new Map([['again:0', { path: [2, 5] }]]);
    const fixed = arrangePrinted(files, overrides);
    expect(fixed.order.filter((e) => e.fileKey === 'again').map(text)).toEqual(['2-5', '2-7']);
    expect(fixed.problems.some((p) => p.kind === 'parts')).toBe(false);
  });

  it('前付けの部の番号の無い頁は、例に挙げない', () => {
    const files = [printed('a', [null, '2-1', '2-3', '2-5']), printed('b', ['2-6', '2-4', '2-2'])];
    const { order, problems } = arrangePrinted(files);

    expect(order[0]).toMatchObject({ prefix: [2], number: -1 });
    expect(problems.find((p) => p.kind === 'depth').message).toContain('（2-1 など）');
  });

  it('前の段の無い頁（前付けなど）は、部の番号の付いた頁より前に置く', () => {
    const files = [
      printed('a', [1, 2, 3]),
      printed('b', ['1-1', '1-2', '1-3', '1-4', '1-5']),
      printed('c', ['2-1', '2-2', '2-3', '2-4', '2-5']),
    ];
    const { order } = arrangePrinted(files);

    expect(order.map(text)).toEqual(['1', '2', '3', '1-1', '1-2', '1-3', '1-4', '1-5', '2-1', '2-2', '2-3', '2-4', '2-5']);
    expect(order.map((e) => e.part)).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
    // 一覧で部の束より下にあれば、本の順ですぐ前の頁（1-5）の後に、まとまり「2/」として置く。
    const reversed = arrangePrinted([...files].reverse());
    expect(reversed.order.map(displayLabel)).toEqual([
      // まとまりの番号は、刷られた部の番号（2）と重ならないよう 3。
      ...['1-1', '1-2', '1-3', '1-4', '1-5', '3-1', '3-2', '3-3', '2-1', '2-2', '2-3', '2-4', '2-5'].map((l) => `${l} 頁`),
    ]);
  });

  it('加除式の本の枝番の頁は、これまでどおり枝番として並べる', () => {
    const files = [printed('o', [51, 53, 55, '57-1', '57-3', 59]), printed('e', [60, '57-4', '57-2', 56, 54, 52])];
    const { order, problems } = arrangePrinted(files);

    expect(order.map(text)).toEqual(['51', '52', '53', '54', '55', '56', '57-1', '57-2', '57-3', '57-4', '59', '60']);
    expect(problems.map((p) => p.kind)).toEqual(['replaced']);
  });

  it('部・編の番号の付いた本の枝番の頁と、その抜け・差し替え・紙の表裏', () => {
    const files = [
      printed('o', ['2-51', '2-53', '2-55', '2-57-1', '2-57-5', '2-59']),
      printed('e', ['2-57-2', '2-56', '2-54', '2-52']),
    ];
    const { order, problems } = arrangePrinted(files);

    expect(order.map(text)).toEqual(['2-51', '2-52', '2-53', '2-54', '2-55', '2-56', '2-57-1', '2-57-2', '2-57-5', '2-59']);
    expect(problems.map((p) => [p.kind, p.message])).toEqual([
      ['missing', '2-57-3〜2-57-4 頁が見つかりません（枝番の付いた頁）。束の入れ忘れ・重送の可能性があります。'],
      ['replaced', '2-57〜2-58 頁は無く、枝番の付いた頁（2-57-1〜2-57-5）があります。差し替えられた頁とみなしました。'],
      ['sheet-end', '最後の頁が奇数（2-59 頁）です。その裏（2-60 頁）が欠けていないか確かめてください（裏が白紙でスキャンしていない場合は問題ありません）。'],
      ['depth', expect.stringContaining('（2-51 など）')],
    ]);
  });

  it('入れ子の枝番の頁で始まり・終わる束の、紙の表裏', () => {
    // 枝番と読む（ほかのファイルで枝番と読んだとき）。
    const files = [printed('a', ['57-1-2', '57-1-3'])];
    const read = inferFileNumbers(files[0].pages.map((page) => page.candidates), { maxDepth: 0 });
    const { order } = arrangeBook(files, new Map([['a', read]]));
    const problems = checkSequence(order, { sheets: true });

    expect(problems.map((p) => p.message)).toEqual([
      '57-1-1 頁が見つかりません（枝番の付いた頁）。束の入れ忘れ・重送の可能性があります。',
      '57 頁は無く、枝番の付いた頁（57-1）があります。差し替えられた頁とみなしました。',
      '最初の頁が偶数（57-1-2 頁）です。その表（57-1-1 頁）が欠けていないか確かめてください。',
      '最後の頁が奇数（57-1-3 頁）です。その裏（57-1-4 頁）が欠けていないか確かめてください（裏が白紙でスキャンしていない場合は問題ありません）。',
    ]);
  });

  it('ファイルごとに入れた番号の前の段（入れなければ読み取った前の段）と、頁ごとの番号', () => {
    const files = [
      printed('a', ['2-1', '2-3', '2-5'], { manual: { start: 7, step: 2 } }),
      printed('b', [null, null], { manual: { start: 1, step: 2, prefix: [3] } }),
      printed('c', ['2-2', '2-4', '2-6']),
    ];
    const overrides = new Map([
      ['a:2', { path: [11] }],
      ['b:1', { path: [4, 9] }],
    ]);
    const { order } = arrangePrinted(files, overrides);

    expect(order.map((e) => `${e.fileKey}:${text(e)}:${e.status}`)).toEqual([
      'c:2-2:detected', 'c:2-4:detected', 'c:2-6:detected',
      'a:2-7:manual', 'a:2-9:manual', 'a:2-11:manual',
      'b:3-1:manual',
      'b:4-9:manual',
    ]);
    // 入れた前の段は、ほかのファイルが無くても使う。
    expect(numberFiles([files[1]], new Map()).get('b').pages.map(text)).toEqual(['3-1', '3-3']);
    // 前の段を入れず、読み取った前の段も無ければ、付けない。
    const unread = [printed('u', [null, null], { manual: { start: 3, step: 2 } })];
    expect(numberFiles(unread, new Map()).get('u').pages.map(text)).toEqual(['3', '5']);
    // 前の段の分からない本（階層 0）では、ファイルごとの番号に前の段を付けない。
    const plain = [printed('p', [null, null], { manual: { start: 5, step: 1 } })];
    const numbered = numberFiles(plain, new Map([['p:1', { path: [6, 1] }]]));
    expect(numbered.get('p').pages.map((page) => [page.number, page.prefix, page.branch])).toEqual([
      [5, undefined, undefined],
      [6, undefined, [1]],
    ]);
  });
});

describe('部の番号の無い頁のまとまり（部の番号を刷っていない巻・目次など）', () => {
  /** 名前つきのファイル。labels はハイフンで区切った番号（null は読めなかった頁）。 */
  const volume = (key, labels, options = {}) => ({
    ...file(key, labels.map(() => null), options),
    pages: labels.map((label, index) => ({
      key: `${key}:${index}`,
      candidates: label === null ? [] : [{ path: String(label).split('-').map(Number), score: 3.5, source: 'text', zone: 'bottom' }],
      heads: [],
      signature: { length: 0, hash: '' },
    })),
  });
  const run = (prefix, count, from = 1) => Array.from({ length: count }, (_, i) => (prefix === null ? from + i : `${prefix}-${from + i}`));
  const text = (page) => (page.number === null ? '?' : [...(page.prefix ?? []), page.number, ...(page.branch ?? [])].join('-'));
  const arrangeBookOf = (files, overrides = new Map()) => {
    const numberings = numberFiles(files, overrides);
    const { order, mismatch } = arrangeBook(files, numberings, overrides);
    return { numberings, order, problems: checkSequence(order, { mismatch }) };
  };
  // 第 1〜2 部（両面。目次は 1〜3 と刷ってあり、目次の 1 頁目と部の扉には番号が無い）と、
  // 番号だけが刷られた第 3 部・第 4 部の巻（一覧でその後ろ）。
  const book = () => [
    volume('a', [null, 1, 2, 3, null, ...run(1, 10), null, ...run(2, 8)]),
    volume('b', run(null, 12)),
    volume('c', run(null, 9)),
  ];

  it('部の番号の無い巻は、本の順ですぐ前の頁の後に、番号を付けたまとまりとして並べる', () => {
    const { order, problems } = arrangeBookOf(book());

    // 番号だけの巻が多くても、部の番号の付いた束から読み方を選ぶ。
    expect(order.map(text)).toEqual([
      '0-0', '0-1', '0-2', '0-3', '0-4',
      ...run(1, 10),
      '2-0', ...run(2, 8),
      ...run(null, 12).map(String),
      ...run(null, 9).map(String),
    ]);
    // 第 3 部（一覧で第 2 部の後）は「3/」、第 4 部（その後）は「4/」。
    expect(order.filter((e) => e.fileKey === 'b').every((e) => pathText(e.section) === '3')).toBe(true);
    expect(order.filter((e) => e.fileKey === 'c').every((e) => pathText(e.section) === '4')).toBe(true);
    expect(order.filter((e) => e.fileKey === 'a').every((e) => !e.section)).toBe(true);
    expect(displayLabel(order.find((e) => e.fileKey === 'c'))).toBe('4-1 頁');
    expect(problems.map((p) => p.kind)).toEqual(['parts', 'depth', 'uncertain']);
    expect(problems[0].message).toContain('3-1〜3-12 頁・4-1〜4-9 頁');
    expect(problems.find((p) => p.kind === 'depth').message).toContain('（1-1 など）');
  });

  it('章の番号だけを刷った巻（4-30）を、同じ番号の部（第 4 部の 4-30）と取り違えない', () => {
    // 第 1〜5 部（部の番号つき）のあとに、章-頁で刷った第 6 部（1-1 … 4-30 …）。
    const files = [
      volume('p1', [null, ...run(1, 10)]),
      volume('p4', [...run(4, 40)]),
      volume('p5', [...run(5, 20)]),
      volume('p6', [null, ...run(1, 10), null, ...run(4, 35)]),
    ];
    const { order } = arrangeBookOf(files);
    const labels = order.map(displayLabel);

    expect(labels.filter((l) => l.endsWith('4-30 頁'))).toEqual(['4-30 頁', '6-4-30 頁']);
    // 第 6 部の章はつながっているので、同じまとまり「6/」のまま。
    expect(order.filter((e) => e.fileKey === 'p6').every((e) => pathText(e.section) === '6')).toBe(true);
    expect(labels.indexOf('6-1-1 頁')).toBeGreaterThan(labels.indexOf('5-20 頁'));
    // 前付けにするのは、本の最初の部の前の頁だけ（第 6 部の扉は、第 6 部の 1 章の頭のまま）。
    expect(labels[0]).toBe('0-1 頁');
    expect(labels).toContain('6-1-0 頁');
    // 裏返した束しか無い前の段は、一覧の下の束を本の前として前付けを決める。
    const even = [volume('e2', ['1-4', '1-2']), volume('e1', ['1-4', '1-2', null])];
    expect(arrangeBookOf(even).order.map(displayLabel)[0]).toBe('0-2 頁');
  });

  it('部の番号の無い頁が部の束の前にあれば、本の先頭（前付け）に置く', () => {
    const { order, problems } = arrangeBookOf([volume('p', run(null, 4)), volume('q', run(1, 6)), volume('r', run(2, 6))]);

    // 本の先頭のまとまりは 0。
    expect(order.slice(0, 5).map(displayLabel)).toEqual(['0-1 頁', '0-2 頁', '0-3 頁', '0-4 頁', '1-1 頁']);
    expect(order[0].section).toEqual([0]);
    // 分けたまとまりとして、番号の範囲を知らせる。
    expect(problems.find((p) => p.kind === 'parts').message).toContain('（0-1〜0-4 頁・1-1〜1-6 頁・2-1〜2-6 頁）');
  });

  it('目次を 0- の部にした本で、その前に部の番号の無い頁があれば、後ろの部の前書き（0-0-1）にする', () => {
    // 番号だけの前付け（1, 2）の束のあとに、目次（1〜3）と第 1 部の束。
    const files = [volume('pre', [1, 2]), volume('toc', [1, 2, 3, ...run(1, 6)]), volume('p2', run(2, 6))];
    const labels = arrangeBookOf(files).order.map(displayLabel);

    expect(labels.slice(0, 6)).toEqual(['0-0-1 頁', '0-0-2 頁', '0-1 頁', '0-2 頁', '0-3 頁', '1-1 頁']);
  });

  it('前付けのまとまりで番号が戻れば、そこから先は後ろの部の前書き（その部の 0）にする', () => {
    const files = [volume('p', [1, 2, 3, 1, 2]), volume('q', run(1, 6))];
    const labels = arrangeBookOf(files).order.filter((e) => e.fileKey === 'p').map(displayLabel);

    expect(labels).toEqual(['0-1 頁', '0-2 頁', '0-3 頁', '1-0-1 頁', '1-0-2 頁']);
  });

  it('同じ束の中で、後ろの部のすぐ前にあれば、その部の前書き（その部の 0）にする', () => {
    // 1-6 と 3-1 の間に、番号だけの頁が 3 頁ある。
    const { order } = arrangeBookOf([volume('s', [...run(1, 6), 21, 22, 23, ...run(3, 6)])]);

    expect(order.map(displayLabel).slice(5, 10)).toEqual(['1-6 頁', '3-0-21 頁', '3-0-22 頁', '3-0-23 頁', '3-1 頁']);
  });

  it('一覧で部の並びが前後しても、本の順ですぐ前の頁の後に置く', () => {
    // 一覧で、前に「3-」、後ろに「2-」の束がある。
    const files = [volume('x', run(3, 6)), volume('y', run(null, 4)), volume('z', run(2, 6))];
    const labels = arrangeBookOf(files).order.map(displayLabel);

    expect(labels.slice(-5)).toEqual(['3-6 頁', '4-1 頁', '4-2 頁', '4-3 頁', '4-4 頁']);
  });

  it('分けたまとまりの中で番号が戻れば、さらに分ける', () => {
    const files = [volume('x', run(3, 6)), volume('y', [1, 2, 3, 1, 2])];
    const labels = arrangeBookOf(files).order.filter((e) => e.fileKey === 'y').map(displayLabel);

    expect(labels).toEqual(['4-1 頁', '4-2 頁', '4-3 頁', '5-1 頁', '5-2 頁']);
  });

  it('裏返した偶数頁の束は、一覧で下にあるほど本の前として、すぐ前の頁を探す', () => {
    // 奇数頁の束（第 5 部・番号だけの第 6 部）のあとに、裏返した偶数頁の束を最後の束から
    // （番号だけの第 6 部、第 5 部の順に）入れた。
    const files = [
      volume('o5', ['5-1', '5-3', '5-5', '5-7']),
      volume('o6', [1, 3, 5, 7]),
      volume('e6', [8, 6, 4, 2]),
      volume('e5', ['5-8', '5-6', '5-4', '5-2']),
    ];
    const { order } = arrangeBookOf(files);

    expect(order.map(displayLabel)).toEqual([
      ...run(5, 8).map((l) => `${l} 頁`),
      ...run(null, 8).map((n) => `6-${n} 頁`),
    ]);
  });

  it('同じ頁のすぐ後に置くまとまりがいくつもあれば、本の順に番号を付ける', () => {
    // 「2-」の束の途中から 1- に戻った束（B の終わり）と、2-5〜 の束（D）の後の 1- の束（E）。
    const files = [
      volume('A', run(1, 4)),
      volume('B', [...run(2, 4), '1-1', '1-2']),
      volume('D', run(2, 4, 5)),
      volume('E', ['1-1', '1-2']),
    ];
    const labels = arrangeBookOf(files).order.map(displayLabel);

    expect(labels.slice(-4)).toEqual(['3-1-1 頁', '3-1-2 頁', '4-1-1 頁', '4-1-2 頁']);
  });

  it('分けたまとまりの番号は重ならない（後の部の後に置いたまとまりは、さらに後の番号）', () => {
    // 「2-」の後に 1- に戻る束が 2 つ続き（3/ と 4/）、「3-」の後にも 1- に戻る束がある。
    const files = [
      volume('A', run(1, 4)),
      volume('B', [...run(2, 4), '1-1', '1-2']),
      volume('B2', [7, 8, 9]),
      volume('C', run(3, 4)),
      volume('D', ['1-1', '1-2']),
    ];
    const sections = [...new Set(arrangeBookOf(files).order.filter((e) => e.section).map((e) => pathText(e.section)))];

    // 刷られた部の番号（1〜3）とも、ほかのまとまりの番号とも重ならない。
    expect(sections).toEqual(['4', '5', '6']);
  });

  it('同じ前の段の、本の順でいちばん前のまとまりを刷られた番号のまま並べる（裏返した束どうしで比べる）', () => {
    // 裏返した偶数頁の束: 一覧で下の束（e2）ほど本の前。両面の束（f0）は一覧の最初。
    const files = [
      volume('f0', ['5-1', '5-2', '5-3', '5-4']),
      volume('e1', ['5-4', '5-2']),
      volume('e2', ['5-4', '5-2']),
    ];
    const { order } = arrangeBook(files, numberFiles(files, new Map()));
    expect(order.filter((e) => e.fileKey === 'e2').every((e) => !e.section)).toBe(true);
    expect(order.filter((e) => e.fileKey === 'e1').every((e) => pathText(e.section) === '6')).toBe(true);
  });

  it('手で入れた番号の頭のまとまりの番号は除く（頁の見出しのとおり 6-4-33 と入れても 4-33）', () => {
    const page = { section: [6], prefix: [4], number: 32 };
    expect(withoutSection({ path: [6, 4, 33] }, page)).toEqual({ path: [4, 33] });
    // 刷られたとおりの番号・段の数の違う番号・頭の違う番号は、そのまま。
    expect(withoutSection({ path: [4, 33] }, page)).toEqual({ path: [4, 33] });
    expect(withoutSection({ path: [6, 4, 33, 1] }, page)).toEqual({ path: [6, 4, 33, 1] });
    expect(withoutSection({ path: [5, 4, 33] }, page)).toEqual({ path: [5, 4, 33] });
    // まとまりの無い頁・番号の決まらない頁も、そのまま。
    expect(withoutSection({ path: [6, 4, 33] }, { prefix: [4], number: 32 })).toEqual({ path: [6, 4, 33] });
    expect(withoutSection({ path: [6, 33] }, { section: [6], number: null })).toEqual({ path: [6, 33] });
    // 枝番の頁は、枝番の段も数える。
    expect(withoutSection({ path: [7, 57, 1] }, { section: [7], number: 57, branch: [2] })).toEqual({ path: [57, 1] });
  });

  it('部の頁と読む本で、前の段の違う枝番を手で入れても番号を決められる', () => {
    const files = [volume('p', run(4, 6, 25)), volume('q', ['4-31', '4-32', null, '4-34'])];
    const overrides = new Map([['q:2', { path: [6, 4, 33] }]]);
    const entry = arrangeBook(files, numberFiles(files, overrides), overrides).order.find((e) => e.pageKey === 'q:2');
    expect(entry).toMatchObject({ prefix: [6], number: 4, branch: [33], status: 'manual' });
  });

  it('1 頁だけ読めたファイルは、ほかのファイルでハイフンで区切って読めた頁のいちばん多い読み方で読む', () => {
    // 番号だけの頁の間の枝番の頁（57-1）と、部の頁（3-1 …）。多いほうの読み方にする（同じなら枝番）。
    const kajo = volume('k', [55, 56, '57-1', '57-2', 58]);
    const single = volume('s', [null, '2-7']);
    const read = (files) => numberFiles(files).get('s').pages[1];
    expect(read([kajo, volume('p', ['3-1', '3-2', '3-3']), single])).toMatchObject({ prefix: [2], number: 7 });
    expect(read([kajo, volume('p', ['3-1', '3-2']), single])).toMatchObject({ number: 2, branch: [7] });
  });

  it('前付けの頁を前の部にするのは、刷られた番号があるときか、本の最初の「1-」の部の前だけ', () => {
    // 刷られた番号が無く、最初の部が「1-」なら、部の前の頁は「0-1」から数える。
    expect(arrangeBookOf([volume('a', [null, null, ...run(1, 6)])]).order.slice(0, 3).map(text)).toEqual(['0-1', '0-2', '1-1']);
    // 2 部目からの部の扉は、その部の頭のまま。
    expect(arrangeBookOf([volume('a', run(1, 4)), volume('b', [null, ...run(2, 4)])]).order.map(text)).toContain('2-0');
    // 第 2 部から始まる本の、2-1 の前の番号の無い頁は、第 2 部の扉かもしれないので変えない。
    expect(arrangeBookOf([volume('a', [null, ...run(2, 4)])]).order[0]).toMatchObject({ prefix: [2], number: 0 });
    // 刷られた番号があれば、どの部の前でも前の部の頁にする。
    expect(arrangeBookOf([volume('a', [1, 2, ...run(3, 8)])]).order.slice(0, 3).map(text)).toEqual(['2-1', '2-2', '3-1']);
  });

  it('1 つ前の部が本の中にあれば、前書きを前の部の頁にしない（重ねない）', () => {
    // 第 6 部の束の前書き（1〜2 と刷ってある）を、第 5 部の 5-1・5-2 と重ねない。
    const files = [volume('e', run(5, 8)), volume('f', [1, 2, ...run(6, 8)])];
    const labels = arrangeBookOf(files).order.filter((e) => e.fileKey === 'f').map(displayLabel);
    // 第 6 部の前書きは、第 6 部の 0 のまとまり（6-0-1）として 6-1 の前に置く。
    expect(labels.slice(0, 3)).toEqual(['6-0-1 頁', '6-0-2 頁', '6-1 頁']);
  });
  it('逆順の束・片面ずつの束の前付け', () => {
    // 裏返した偶数頁の束: 本の順（最後の頁から）に前付けを数える。
    const even = numberFiles([volume('e', ['1-6', '1-4', '1-2', null])], new Map()).get('e');
    expect(even.pages.map(text)).toEqual(['1-6', '1-4', '1-2', '0-2']);
    // 奇数頁の束で刷られた番号が無ければ、1 から 2 つずつ。
    const odd = numberFiles([volume('o', [null, null, '1-1', '1-3'])], new Map()).get('o');
    expect(odd.pages.map(text)).toEqual(['0-1', '0-3', '1-1', '1-3']);
  });
});
