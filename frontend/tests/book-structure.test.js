import { describe, expect, it } from 'vitest';
import { MAX_DEPTH, pageTargets, structureCuts } from '../src/pdf-book-merger/structure.js';

const MB = 2 ** 20;

describe('pageTargets（正解から、頁ごとに始まる単位の深さ）', () => {
  it('頁の頭と途中で分け、いちばん浅い深さにする（部品は数えない。深すぎれば MAX_DEPTH）', () => {
    const units = [
      { page: 0, depth: 1, kind: 'body', at: 'top' },
      { page: 0, depth: 2, kind: 'title', at: 'top' },
      { page: 2, depth: 3, kind: 'body', at: 'top' },
      { page: 2, depth: 2, kind: 'body', at: 'top' },
      { page: 2, depth: 4, kind: 'body', at: 'middle' },
      { page: 3, depth: 3, kind: 'body', at: 'middle' },
      { page: 3, depth: 2, kind: 'body', at: 'middle' },
      { page: 3, depth: 2, kind: 'outro', at: 'top' },
    ];
    expect(pageTargets(units, 4)).toEqual({ top: [1, 0, 2, 0], mid: [0, 0, MAX_DEPTH, 2] });
  });
});

describe('structureCuts（構造から分ける位置）', () => {
  const sizes = (n, mb = 1) => Array.from({ length: n }, () => mb * MB);

  it('上限に収まれば分けない', () => {
    expect(structureCuts([1, 0, 1, 0], [0, 0, 0, 0], sizes(4), 10 * MB)).toEqual([]);
  });

  it('上の階層の単位の境目で分け、まだ超える区間だけを次の階層で分ける（本の前付けは独立させる）', () => {
    // 0〜1: 前付け、2: 第1章、3〜5: 第1章の節、6: 第2章、7〜9: 第2章の節
    const top = [0, 0, 1, 2, 0, 2, 1, 2, 2, 2];
    const mid = new Array(10).fill(0);
    expect(structureCuts(top, mid, sizes(10), 5 * MB)).toEqual([2, 6]);
    // 章が上限を超えれば、節で分ける（章の頭から最初の節までに単位が始まっていなければ、扉は最初の節に付ける）。
    expect(structureCuts(top, mid, sizes(10), 2 * MB)).toEqual([2, 5, 6, 8, 9]);
  });

  it('章の頭のあと、最初の節の前に別の単位（頁の途中の節など）が始まっていれば、最初の節の前でも切る', () => {
    const top = [1, 0, 0, 2, 0, 2];
    expect(structureCuts(top, [0, 0, 0, 0, 0, 0], sizes(6), 2.5 * MB)).toEqual([5]);
    expect(structureCuts(top, [2, 0, 0, 0, 0, 0], sizes(6), 2.5 * MB)).toEqual([3, 5]);
    expect(structureCuts(top, [0, 2, 0, 0, 0, 0], sizes(6), 2.5 * MB)).toEqual([3, 5]);
    expect(structureCuts([1, 2, 2, 0, 2, 0], [0, 0, 0, 0, 0, 0], sizes(6), 2.5 * MB)).toEqual([2, 4]);
  });

  it('その階層に頭から始まる単位が無ければ次の階層で、どの階層でも分けられなければ分けない（呼ぶ側が大きさで分ける）', () => {
    expect(structureCuts([0, 0, 2, 0], [0, 0, 0, 0], sizes(4), 2 * MB)).toEqual([2]);
    expect(structureCuts([0, 0, 0, 0], [0, 0, 0, 0], sizes(4), 2 * MB)).toEqual([]);
  });
});
