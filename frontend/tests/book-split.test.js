// PDF 結合ツール: 分ける位置の候補と提案、分けたファイルの名前と頁ラベル（split.js）。

import { describe, expect, it } from 'vitest';
import {
  breakCandidates,
  chapterHeading as headingOfLines,
  MEGABYTE,
  partFileName,
  sliceLabelRanges,
  splitRanges,
  suggestSplits,
} from '../src/pdf-book-merger/split.js';
import { pageLabelRanges, pageLabelTexts } from '../src/pdf-book-merger/ordering.js';
import { groupLines } from '../src/pdf-book-merger/page-numbers.js';

/** 頁の文字の断片から見出しを探す（行にまとめてから）。 */
const chapterHeading = (items) => headingOfLines(groupLines(items));

/** 頁の中の 1 行（y は上からの割合、h は字の高さ）。 */
const line = (text, y, h = 0.012) => ({ text, x0: 0.1, x1: 0.1 + text.length * h, y, h });

describe('chapterHeading', () => {
  it('上半分にある、ほかの行より大きな字の「第 N 章」「Chapter N」を見出しとする', () => {
    const body = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65].map((y) => line('本文の行です。', y));
    expect(chapterHeading([line('第３章　構造計算', 0.2, 0.03), ...body])).toBe('第3章 構造計算');
    expect(chapterHeading([line('Chapter 4 Loads', 0.25, 0.03), ...body])).toBe('Chapter 4 Loads');
    expect(chapterHeading([line('第二部 応用', 0.3, 0.02), ...body])).toBe('第二部 応用');
    expect(chapterHeading([line('第Ⅱ部 応用', 0.3, 0.02), ...body])).toBe('第Ⅱ部 応用');
    expect(chapterHeading([line('第1章「猫」', 0.3, 0.02), ...body])).toBe('第1章「猫」');
    expect(chapterHeading([line('PART Ⅲ', 0.3, 0.02), ...body])).toBe('PART Ⅲ');
    // 上の余白の帯にある大きな見出しや、真ん中より少し下の部の扉の見出しも拾う。
    expect(chapterHeading([line('第3章 構造計算', 0.1, 0.03), ...body])).toBe('第3章 構造計算');
    expect(chapterHeading([line('第二部', 0.575, 0.03), ...body])).toBe('第二部');
    // 字を空けて組んだ見出し（行にまとめると字の間に空白が入る）と、区切りの無い見出し。
    expect(chapterHeading([line('第 十 二 章', 0.2, 0.03), ...body])).toBe('第 十 二 章');
    expect(chapterHeading([line('第1章はじめに', 0.2, 0.03), ...body])).toBe('第1章はじめに');
  });

  it('大きな字の行がいくつもある章の扉でも、見出しを拾う', () => {
    const lines = [line('第3章', 0.2, 0.03), line('はじめに', 0.3, 0.03), line('本文の行です。', 0.45, 0.015), line('41', 0.95)];
    expect(chapterHeading(lines)).toBe('第3章');
    // 目次のように、見出しの形の行ばかりの頁は拾わない。
    const toc = ['第1章 基礎', '第2章 壁', '第3章 床', '第4章 屋根'].map((text, i) => line(text, 0.2 + i * 0.05));
    expect(chapterHeading(toc)).toBeNull();
  });

  it('本文と同じ大きさの行・柱・下半分・長い行は見出しにしない', () => {
    const body = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65].map((y) => line('本文の行です。', y));
    // 本文の行の頭の「第 3 章で…」。
    expect(chapterHeading([line('第3章で述べたとおり', 0.3), ...body])).toBeNull();
    // 柱（余白の帯の中の、本文と同じくらいの字）。章の途中の頁にも載る。
    expect(chapterHeading([line('第3章 構造計算', 0.05), ...body])).toBeNull();
    // 柱と頁番号だけの白紙の頁。
    expect(chapterHeading([line('第3章 構造計算', 0.05), line('12', 0.95)])).toBeNull();
    // 下の方。
    expect(chapterHeading([line('第3章 構造計算', 0.7, 0.03), ...body])).toBeNull();
    // 長い行。
    expect(chapterHeading([line(`第3章 ${'あ'.repeat(40)}`, 0.2, 0.03), ...body])).toBeNull();
    // 見出しの形でも、本文と同じ大きさの字（目次の行など）。
    expect(chapterHeading([line('第3章 構造計算', 0.3), ...body])).toBeNull();
    // 見出しの形でない大きな字。
    expect(chapterHeading([line('はじめに', 0.2, 0.03), ...body])).toBeNull();
    expect(chapterHeading([])).toBeNull();
  });

  it('行が 3 つまでの頁（章の扉）は、字の大きさを比べずに見出しとする', () => {
    expect(chapterHeading([line('第5章', 0.3), line('木造の壁', 0.35), line('12', 0.95)])).toBe('第5章');
    // 図の多い頁の説明（「第 2 章で…」）は、行が少なくても見出しにしない。
    expect(chapterHeading([line('第2章で示した構成', 0.3), line('13', 0.95)])).toBeNull();
    expect(chapterHeading([line('Chapter 3: Loads', 0.3)])).toBe('Chapter 3: Loads');
  });
});

describe('breakCandidates', () => {
  const page = (fileKey, extra = {}) => ({ fileKey, fileName: `${fileKey}.pdf`, role: 'body', ...extra });

  it('しおり・見出し・続けてつないだファイルの境目を候補にする（先頭の頁は候補にしない）', () => {
    const items = [
      page('a', { outline: 'はじめに' }),
      page('a'),
      page('b'),
      page('b', { heading: '第2章' }),
      page('b', { outline: '第3章', heading: '第3章 本文' }),
    ];
    expect(breakCandidates(items)).toEqual([
      null,
      null,
      { kind: 'file', title: 'b.pdf' },
      { kind: 'heading', title: '第2章' },
      { kind: 'outline', title: '第3章' },
    ]);
  });

  it('表紙の後ろと裏表紙の前は、候補にしない（表紙と本文を別のファイルにしない）', () => {
    const items = [
      page('cover', { role: 'front' }),
      page('cover', { role: 'front', heading: '第1部' }),
      page('body', { outline: '第1章' }),
      page('body'),
      page('back', { role: 'back', outline: '奥付' }),
    ];
    expect(breakCandidates(items)).toEqual([null, null, null, null, null]);
  });

  it('本文が無ければ（ファイルの並びのままつなぐとき）、先頭に置くファイルの間も候補にする', () => {
    const items = [
      page('a', { role: 'front' }),
      page('a', { role: 'front' }),
      page('b', { role: 'front', outline: '第2章' }),
      page('c', { role: 'front' }),
    ];
    expect(breakCandidates(items)).toEqual([
      null,
      null,
      { kind: 'outline', title: '第2章' },
      { kind: 'file', title: 'c.pdf' },
    ]);
  });

  it('奇数頁・偶数頁の束のように入り混じるファイルの境目は、候補にしない', () => {
    const items = [page('odd'), page('even'), page('odd'), page('even')];
    expect(breakCandidates(items)).toEqual([null, null, null, null]);
  });
});

describe('suggestSplits', () => {
  const MB = MEGABYTE;
  /** n 頁ぶん。sizes は頁ごとの MB（数 1 つなら、すべて同じ）。 */
  const pages = (n, size = 1, role = 'body') => Array.from({ length: n }, () => ({ role, bytes: size * MB }));
  const none = (items) => items.map(() => null);

  it('上限に収まれば分けない', () => {
    const items = pages(50);
    expect(suggestSplits(items, none(items), { megabytes: 100, pages: null })).toEqual([]);
    expect(suggestSplits(items, none(items), { megabytes: null, pages: null })).toEqual([]);
    expect(suggestSplits(items, none(items), { megabytes: null, pages: 50 })).toEqual([]);
  });

  it('章の区切りがあれば、そこで分ける（ファイルの数がいちばん少なくなるように）', () => {
    const items = pages(100);
    const candidates = none(items);
    for (const at of [20, 45, 70, 90]) candidates[at] = { kind: 'heading', title: `第${at}章` };
    // 50 MB まで: 0〜44・45〜89・90〜99 の 3 つ（0〜19・20〜69・70〜99 も 3 つだが、
    // いちばん大きなファイルが 50 MB になる）。
    expect(suggestSplits(items, candidates, { megabytes: 50, pages: null })).toEqual([45, 90]);
  });

  it('同じ数に分けられるなら、いちばん大きなファイルが小さくなる区切りを選ぶ', () => {
    const items = pages(100);
    const candidates = none(items);
    for (const at of [30, 50, 60]) candidates[at] = { kind: 'outline', title: 'x' };
    expect(suggestSplits(items, candidates, { megabytes: 70, pages: null })).toEqual([50]);
  });

  it('章の区切りでは収まらないところは、候補の無いところでも分ける（頁数の上限も守る）', () => {
    const items = pages(30, 0.1);
    expect(suggestSplits(items, none(items), { megabytes: null, pages: 10 })).toEqual([10, 20]);
  });

  it('ファイルの境目は、章の区切りが無いときに使う', () => {
    const items = pages(40);
    const candidates = none(items);
    candidates[15] = { kind: 'file', title: 'b.pdf' };
    candidates[25] = { kind: 'heading', title: '第2章' };
    expect(suggestSplits(items, candidates, { megabytes: 30, pages: null })).toEqual([25]);
    candidates[25] = null;
    expect(suggestSplits(items, candidates, { megabytes: 30, pages: null })).toEqual([15]);
  });

  it('表紙は最初のファイルに、裏表紙は最後のファイルに付ける', () => {
    const items = [...pages(2, 5, 'front'), ...pages(20), ...pages(2, 5, 'back')];
    const candidates = none(items);
    candidates[1] = { kind: 'file', title: '表紙' };
    candidates[2] = { kind: 'file', title: '本文' };
    candidates[12] = { kind: 'heading', title: '第2章' };
    candidates[22] = { kind: 'file', title: '裏表紙' };
    expect(suggestSplits(items, candidates, { megabytes: 25, pages: null })).toEqual([12]);
  });

  it('本文が無ければ、先頭に置くファイルの間でも分ける（ファイルの並びのままつなぐとき）', () => {
    const items = [...pages(4, 30, 'front'), ...pages(4, 30, 'front'), ...pages(4, 30, 'front')];
    const candidates = none(items);
    candidates[4] = { kind: 'file', title: 'b.pdf' };
    candidates[8] = { kind: 'file', title: 'c.pdf' };
    expect(suggestSplits(items, candidates, { megabytes: 250, pages: null })).toEqual([8]);
  });

  it('1 頁だけで上限を超える頁は、その頁だけのファイルにする', () => {
    const items = [...pages(3), { role: 'body', bytes: 50 * MB }, ...pages(3)];
    expect(suggestSplits(items, none(items), { megabytes: 10, pages: null })).toEqual([3, 4]);
  });
});

describe('splitRanges / partFileName', () => {
  it('分ける位置から頁の範囲を作る', () => {
    expect(splitRanges(10, [])).toEqual([{ start: 0, end: 10 }]);
    expect(splitRanges(10, [3, 7])).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 7 },
      { start: 7, end: 10 },
    ]);
  });

  it('分けたファイルには番号を付け、10 以上なら桁を揃える', () => {
    expect(partFileName('猫.pdf', 0, 1)).toBe('猫.pdf');
    expect(partFileName('猫.pdf', 1, 3)).toBe('猫_2.pdf');
    expect(partFileName('猫.PDF', 0, 12)).toBe('猫_01.pdf');
    expect(partFileName('猫.pdf', 11, 12)).toBe('猫_12.pdf');
  });
});

describe('sliceLabelRanges', () => {
  it('分けたファイルにも、本の頁番号の頁ラベルを付ける', () => {
    const order = [
      { role: 'front', number: null },
      { role: 'body', number: -1 },
      { role: 'body', number: 0 },
      ...Array.from({ length: 6 }, (_, i) => ({ role: 'body', number: i + 1 })),
      { role: 'back', number: null },
    ];
    const ranges = pageLabelRanges(order);
    const whole = pageLabelTexts(ranges, order.length);
    expect(whole).toEqual(['表紙', 'i', 'ii', '1', '2', '3', '4', '5', '6', '裏表紙']);
    for (const [start, end] of [
      [0, 2],
      [2, 5],
      [5, 10],
      [0, 10],
      [4, 6],
    ]) {
      expect(pageLabelTexts(sliceLabelRanges(ranges, start, end), end - start)).toEqual(whole.slice(start, end));
    }
  });
});
