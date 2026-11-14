// PDF 結合ツール: 分ける位置の候補と提案、分けたファイルの名前と頁ラベル（split.js）。

import { describe, expect, it } from 'vitest';
import {
  breakCandidates,
  breakReason,
  chapterHeading as headingOfLines,
  MEGABYTE,
  partFileName,
  partLabel,
  partLabels,
  splitAtBreaks,
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

  it('「Section 2」の扉（その章の項目を並べた頁）を拾い、目次の頁は拾わない', () => {
    // プレセッターマニュアルの章の扉: 「Section ２」と題の下に、その章の項目が並ぶ。
    const divider = [
      line('011', 0.04),
      line('Section ２', 0.2, 0.04),
      line('プレセッターの解説', 0.26, 0.03),
      line('２−１　プレセッター金物一覧', 0.35),
      line('▼２−１−１　製品一覧表　・・012', 0.4),
      line('▼２−１−２　金物の仕様　・・014', 0.45),
    ];
    // 番号だけの見出しには、すぐ下の大きな字の題を続ける。
    expect(chapterHeading(divider)).toBe('Section 2 プレセッターの解説');
    // 題が離れているか、本文と同じ大きさなら続けない。
    expect(chapterHeading([line('Section 3', 0.2, 0.04), ...divider.slice(3), line('x', 0.5), line('y', 0.55)])).toBe('Section 3');
    expect(chapterHeading([line('第4章', 0.2, 0.04), line('木造の壁', 0.25), ...divider.slice(3)])).toBe('第4章');
    // 目次: 見出しの形の行が何行も並ぶ。
    const toc = [
      line('もくじ', 0.1, 0.03),
      line('Section 1　 プレセッターの概要　P.001', 0.2),
      line('▼１−１−１　適用範囲　・・002', 0.25),
      line('Section ２　 プレセッターの解説　P.011', 0.3),
    ];
    expect(chapterHeading(toc)).toBeNull();
  });

  it('柱に章の名前がある章の扉や、部と章が並ぶ扉でも、見出しを拾う', () => {
    const body = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65].map((y) => line('本文の行です。', y));
    expect(chapterHeading([line('第3章 床', 0.03), line('第3章 床', 0.2, 0.03), ...body])).toBe('第3章 床');
    expect(chapterHeading([line('第1部 基礎編', 0.15, 0.04), line('第1章 はじめに', 0.3, 0.03), ...body])).toBe('第1部 基礎編');
  });

  it('「Section 2.1」のような小見出しや、頁番号で終わる目次の行は拾わない', () => {
    const body = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65].map((y) => line('本文の行です。', y));
    expect(chapterHeading([line('Section 2.1 Scope', 0.2, 0.03), ...body])).toBeNull();
    expect(chapterHeading([line('Section 2', 0.2, 0.03), ...body])).toBe('Section 2');
    expect(chapterHeading([line('Section 1　 プレセッターの概要　P.001', 0.2, 0.03), ...body])).toBeNull();
    expect(chapterHeading([line('第2章 壁 ………… 28', 0.2, 0.03), ...body])).toBeNull();
    // 語の終わりの「p＋数」は頁番号ではない。
    expect(chapterHeading([line('Chapter 3 Step 2', 0.2, 0.03), ...body])).toBe('Chapter 3 Step 2');
    expect(chapterHeading([line('第7章 MP3', 0.2, 0.03), ...body])).toBe('第7章 MP3');
  });

  it('その部の章を並べた部の扉は、部の見出しを拾う', () => {
    const chapters = ['第5章 設計', '第6章 施工', '第7章 保守'].map((text, i) => line(text, 0.3 + i * 0.05));
    const body = [0.5, 0.55, 0.6, 0.65].map((y) => line('本文の行です。', y));
    expect(chapterHeading([line('第2部 応用', 0.15, 0.04), ...chapters, ...body])).toBe('第2部 応用');
  });

  it('行の少ない頁の「Section 2 で示した…」という説明は、見出しにしない', () => {
    expect(chapterHeading([line('Section 2 で示した手順', 0.3), line('13', 0.95)])).toBeNull();
    // ひらがなで始まる題（助詞のあとにひらがなが続く）は見出し。
    expect(chapterHeading([line('第1章 はじめに', 0.3), line('12', 0.95)])).toBe('第1章 はじめに');
    expect(chapterHeading([line('第2章 のりしろ', 0.3), line('12', 0.95)])).toBe('第2章 のりしろ');
    // 「では」「について」のような助詞で続く説明は見出しにしない。
    expect(chapterHeading([line('第 3 章 では、次のように', 0.3)])).toBeNull();
    expect(chapterHeading([line('Section 2 について説明する', 0.3)])).toBeNull();
    // 番号だけの見出しのあとに、助詞で始まる説明の行・目次の項目・余白の行は続けない。
    expect(chapterHeading([line('Section 2', 0.3), line('で示したように', 0.31)])).toBe('Section 2');
    expect(chapterHeading([line('Section 2', 0.3), line('プレセッターの解説 …… 12', 0.31)])).toBe('Section 2');
    expect(chapterHeading([line('Section 2', 0.55, 0.2), line('解説', 0.9)])).toBe('Section 2');
  });

  it('ローマ数字の部・章は拾い、ローマ数字の字だけでできた英単語は拾わない', () => {
    const body = [0.4, 0.45, 0.5, 0.55].map((y) => line('本文の行です。', y));
    expect(chapterHeading([line('Part II 応用', 0.2, 0.04), ...body])).toBe('Part II 応用');
    expect(chapterHeading([line('Section Civil Works', 0.2, 0.04), ...body])).toBeNull();
    expect(chapterHeading([line('Parti', 0.2, 0.04), ...body])).toBeNull();
  });

  it('題として続けるのは、すぐ下の短い大きな行だけ（見出しや段落は続けない）', () => {
    const body = [0.4, 0.45, 0.5, 0.55].map((y) => line('本文の行です。', y));
    expect(chapterHeading([line('Chapter 3', 0.2, 0.04), line('Chapter 4', 0.25, 0.04), ...body])).toBe('Chapter 3');
    const lead = `本文の段落は${'あ'.repeat(40)}`;
    expect(chapterHeading([line('第3章', 0.2, 0.04), line(lead, 0.25, 0.04), ...body])).toBe('第3章');
  });

  it('2 行だけの扉でも、番号だけの見出しには題を続ける', () => {
    expect(chapterHeading([line('Section 2', 0.3, 0.04), line('プレセッターの解説', 0.36, 0.04)])).toBe(
      'Section 2 プレセッターの解説'
    );
    expect(chapterHeading([line('Part XL', 0.3, 0.04)])).toBe('Part XL');
    // 1 字の英字は I・V・X だけを数とみなす（「Section C」は記号の節）。
    expect(chapterHeading([line('Part V', 0.3, 0.04)])).toBe('Part V');
    expect(chapterHeading([line('Section C', 0.3, 0.04)])).toBeNull();
  });

  it('行の少ない扉でも、番号だけの見出しには題を続ける', () => {
    expect(chapterHeading([line('Section 2', 0.3, 0.04), line('プレセッターの解説', 0.36, 0.03), line('011', 0.95)])).toBe(
      'Section 2 プレセッターの解説'
    );
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

  it('先頭に置く頁が 4 頁より多ければ（表紙と目次など）、本文との境目も候補にする', () => {
    const front = Array.from({ length: 5 }, () => page('toc', { role: 'front' }));
    const items = [...front, page('body'), page('body')];
    expect(breakCandidates(items)[5]).toEqual({ kind: 'file', title: 'body.pdf' });
    // 1 頁の表紙のすぐ後ろ（表紙だけのファイルになる）では分けない。
    const covered = [page('cover', { role: 'front' }), ...front, page('body')];
    expect(breakCandidates(covered)[1]).toBeNull();
    expect(breakCandidates(covered)[6]).toEqual({ kind: 'file', title: 'body.pdf' });
    // 裏表紙も同じ（末尾の 4 頁より多いまとまりは、本文と分けてよい。最後の 1 頁の前では分けない）。
    const appendix = Array.from({ length: 5 }, () => page('appendix', { role: 'back' }));
    const tail = [page('body'), ...appendix, page('back', { role: 'back' })];
    expect(breakCandidates(tail)[1]).toEqual({ kind: 'file', title: 'appendix.pdf' });
    expect(breakCandidates(tail)[6]).toBeNull();
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
      // ファイルの境目は、しおりより先に見る（しおりの名前は chapter に残す）。
      { kind: 'file', title: 'b.pdf', chapter: '第2章' },
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
    expect(partFileName('猫.pdf', 1, 3, '第2章 壁')).toBe('猫_2_第2章 壁.pdf');
    expect(partFileName('猫.pdf', 0, 1, '第1章')).toBe('猫.pdf');
    // 名前が長すぎる（UTF-8 で 240 バイトを超える）ときは、区切りの名前を短くする。
    const long = partFileName(`${'あ'.repeat(70)}.pdf`, 1, 3, 'い'.repeat(40));
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(240);
    expect(long).toMatch(/^あ{70}_2_い+\.pdf$/);
    expect(partFileName(`${'あ'.repeat(80)}.pdf`, 1, 3, 'い'.repeat(5))).toBe(`${'あ'.repeat(80)}_2.pdf`);
    // 切ったところに残った終わりの点・空白は除く。
    expect(partFileName(`${'a'.repeat(223)}.pdf`, 1, 3, 'Chapter 3. Intro')).toBe(`${'a'.repeat(223)}_2_Chapter 3.pdf`);
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

describe('splitAtBreaks', () => {
  const MB = MEGABYTE;
  const pages = (n, size = 1) => Array.from({ length: n }, () => ({ role: 'body', bytes: size * MB }));

  it('区切りのすべてで分け、上限を超えるまとまりはさらに分ける', () => {
    const items = pages(20);
    const candidates = items.map(() => null);
    candidates[3] = { kind: 'file', title: 'b.pdf' };
    candidates[4] = { kind: 'file', title: 'c.pdf' };
    candidates[8] = { kind: 'heading', title: '第2章' };
    // 8〜19 は 12 MB なので、10 MB の上限でさらに分ける。
    expect(splitAtBreaks(items, candidates, { megabytes: 10, pages: null })).toEqual([3, 4, 8, 14]);
    expect(splitAtBreaks(items, candidates, { megabytes: null, pages: null })).toEqual([3, 4, 8]);
    expect(splitAtBreaks(items, items.map(() => null), { megabytes: 100, pages: null })).toEqual([]);
  });
});

describe('partLabel', () => {
  it('しおり・見出しはそのまま、ファイルの名前は終わりの括弧の中を使い、名前に使えない字を除く', () => {
    expect(partLabel({ kind: 'file', title: '2025_接合補強金物施工ガイドブック14(告示1460号第2号い).pdf' })).toBe('告示1460号第2号い');
    expect(partLabel({ kind: 'file', title: '2025_接合補強金物施工ガイドブック14（表紙・目次）.pdf' })).toBe('表紙・目次');
    expect(partLabel({ kind: 'file', title: '下巻.pdf' })).toBe('下巻');
    expect(partLabel({ kind: 'heading', title: 'Section 2' })).toBe('Section 2');
    expect(partLabel({ kind: 'outline', title: ' 第1章:  基礎/概要? ' })).toBe('第1章 基礎概要');
    expect(partLabel({ kind: 'outline', title: 'あ'.repeat(50) })).toHaveLength(40);
    expect(partLabel(null)).toBe('');
  });
});

describe('splitAtBreaks（本文が無いとき）', () => {
  it('ファイルの並びのままつなぐときは、ファイルの境目では分けない（しおり・見出しでは分ける）', () => {
    const items = Array.from({ length: 6 }, () => ({ role: 'front', bytes: MEGABYTE }));
    const candidates = items.map(() => null);
    candidates[2] = { kind: 'file', title: 'b.pdf' };
    candidates[4] = { kind: 'outline', title: '第2章' };
    expect(splitAtBreaks(items, candidates, { megabytes: null, pages: null })).toEqual([4]);
  });

  it('しおり・見出しで 1 頁だけのファイルはできないようにする（ファイルの境目は 1 頁でも分ける）', () => {
    const items = Array.from({ length: 8 }, () => ({ role: 'body', bytes: MEGABYTE }));
    const candidates = items.map(() => null);
    candidates[1] = { kind: 'outline', title: '目次' };
    candidates[2] = { kind: 'outline', title: '第一部' };
    candidates[3] = { kind: 'outline', title: '第1章' };
    candidates[5] = { kind: 'outline', title: '第2章' };
    candidates[6] = { kind: 'file', title: 'b.pdf' };
    // 表紙（0）と目次（1）、部の扉（2）と第 1 章（3〜4）はそれぞれ 1 つに。第 2 章（5）は
    // 1 頁で、そのあとがファイルの境目なので、前と一緒にする。
    expect(splitAtBreaks(items, candidates, { megabytes: null, pages: null })).toEqual([2, 6]);
    // 本の最後の頁にある章の扉も、前と一緒にする。ファイルの境目で始まる 1 頁はそのまま。
    candidates[7] = { kind: 'heading', title: '付録' };
    expect(splitAtBreaks(items, candidates, { megabytes: null, pages: null })).toEqual([2, 6]);
    const tail = items.map(() => null);
    tail[7] = { kind: 'file', title: 'c.pdf' };
    expect(splitAtBreaks(items, tail, { megabytes: null, pages: null })).toEqual([7]);
  });

  it('上限を超えるところは、使わなかったファイルの境目で分ける', () => {
    const items = Array.from({ length: 180 }, () => ({ role: 'front', bytes: MEGABYTE }));
    const candidates = items.map(() => null);
    candidates[60] = { kind: 'file', title: 'b.pdf' };
    candidates[120] = { kind: 'file', title: 'c.pdf' };
    expect(splitAtBreaks(items, candidates, { megabytes: 100, pages: null })).toEqual([60, 120]);
  });

  it('まとまりをさらに分けるときも、表紙だけのファイルは作らない', () => {
    // 1 頁の表紙と 5 頁の目次（先頭に置く 6 頁）は本文と分けるが、その中では表紙の後ろで分けない。
    const items = [
      ...Array.from({ length: 6 }, () => ({ role: 'front', bytes: 10 * MEGABYTE })),
      ...Array.from({ length: 3 }, () => ({ role: 'body', bytes: MEGABYTE })),
    ];
    const candidates = items.map(() => null);
    candidates[6] = { kind: 'file', title: 'body.pdf' };
    // 先頭の 4 頁までの後ろでは分けず、5 頁目の後ろで分ける。
    expect(splitAtBreaks(items, candidates, { megabytes: 50, pages: null })).toEqual([5, 6]);
  });
});

describe('partLabel（名前の手直し）', () => {
  it('ダウンロードし直したときの「 (1)」は名前に含めず、改行は空白にする', () => {
    expect(partLabel({ kind: 'file', title: '報告書 (1).pdf' })).toBe('報告書');
    expect(partLabel({ kind: 'file', title: 'ガイド（柱脚金物） (2).pdf' })).toBe('柱脚金物');
    // 年や巻の数だけの括弧は中身を表さないので、名前全体を使う。
    expect(partLabel({ kind: 'file', title: 'ガイド（2024）.pdf' })).toBe('ガイド（2024）');
    // 終わりの点は除く。
    expect(partLabel({ kind: 'heading', title: '第1章 ...' })).toBe('第1章');
    // 括弧が無ければ、取り込んだファイルに共通する頭を除く。
    expect(partLabel({ kind: 'file', title: '本_051-100.pdf' }, '本_')).toBe('051-100');
    expect(partLabel({ kind: 'file', title: '本_.pdf' }, '本_')).toBe('本_');
    expect(partLabel({ kind: 'heading', title: '第1章\n基礎' })).toBe('第1章 基礎');
    // 長さは字で数える（𠮷 を半分にしない）。
    expect(partLabel({ kind: 'outline', title: `${'あ'.repeat(39)}𠮷𠮷` })).toBe(`${'あ'.repeat(39)}𠮷`);
  });
});

describe('partLabels', () => {
  const item = (fileName, extra = {}) => ({ role: 'body', fileName, ...extra });

  it('2 つ目からは区切りの名前、最初は表紙を除いた最初の頁のしおり・見出し・ファイルの名前', () => {
    const candidates = [null, null, { kind: 'file', title: '第2章.pdf' }, null];
    const items = [item('猫_表紙.pdf', { role: 'front' }), item('第1章.pdf'), item('第2章.pdf'), item('第2章.pdf')];
    expect(partLabels(items, candidates, [2])).toEqual(['第1章', '第2章']);
    expect(partLabels(items, candidates, [2, 3])).toEqual(['第1章', '第2章', '']);
    items[1].heading = '第1章 はじめに';
    expect(partLabels(items, candidates, [2])[0]).toBe('第1章 はじめに');
    items[1].outline = '序';
    expect(partLabels(items, candidates, [2])[0]).toBe('序');
    // ファイルの境目で分けていなければ、ファイルの名前は添えない。
    const plain = [item('a.pdf'), item('a.pdf'), item('a.pdf')];
    expect(partLabels(plain, [null, null, null], [2])).toEqual(['', '']);
    // 括弧の無い名前は、共通する頭（区切りの字まで）を除く。
    const batches = [item('本_001-050.pdf'), item('本_051-100.pdf')];
    expect(partLabels(batches, [null, { kind: 'file', title: '本_051-100.pdf' }], [1])).toEqual(['001-050', '051-100']);
    const noSeparator = [item('abc.pdf'), item('abd.pdf')];
    expect(partLabels(noSeparator, [null, { kind: 'file', title: 'abd.pdf' }], [1])).toEqual(['abc', 'abd']);
    // 表紙しかなければ、表紙の頁から。
    expect(partLabels([item('表紙.pdf', { role: 'front', heading: '第1部' })], [null], [])).toEqual(['第1部']);
    expect(partLabels([], [], [])).toEqual(['']);
  });
});

describe('区切りの細かさと、ファイルの境目の章', () => {
  const MB = MEGABYTE;
  const body = (n) => Array.from({ length: n }, () => ({ role: 'body', bytes: MB }));

  it('頁ごとの細かいしおりは、区切りごとに分けるときに使わない（上限を超えるときだけ分けるときは使う）', () => {
    // 項目が 20 以上あって、頁の半分より多いしおり。
    const items = body(39);
    const candidates = items.map((_, i) => (i > 0 && i <= 20 ? { kind: 'outline', title: `${i}` } : null));
    expect(splitAtBreaks(items, candidates, { megabytes: null, pages: null })).toEqual([]);
    expect(splitAtBreaks(body(40), [...candidates, null], { megabytes: null, pages: null })).toHaveLength(10);
    const [cut] = suggestSplits(items, candidates, { megabytes: 30, pages: null });
    expect(candidates[cut]).toMatchObject({ kind: 'outline' });
  });

  it('本文が無くても、しおり・見出しのあるファイルの境目では分け、上限を超えるときは章の区切りとして選ぶ', () => {
    const items = Array.from({ length: 9 }, () => ({ role: 'front', bytes: MB }));
    const candidates = items.map(() => null);
    candidates[3] = { kind: 'file', title: 'b.pdf' };
    candidates[6] = { kind: 'file', title: 'c.pdf', chapter: '第3章' };
    expect(splitAtBreaks(items, candidates, { megabytes: null, pages: null })).toEqual([6]);
    // 上限を超えるときだけ分けるときも、章のあるファイルの境目を選ぶ（ただの境目より手間が少ない）。
    const plain = items.map(() => null);
    plain[2] = { kind: 'file', title: 'b.pdf' };
    plain[7] = { kind: 'file', title: 'c.pdf', chapter: '第3章' };
    expect(suggestSplits(body(9), plain, { megabytes: 7, pages: null })).toEqual([7]);
  });

  it('名前: 括弧が無ければ章の名前、どれも無ければ共通する頭を除いた名前。1 頁を次と一緒にしたら、次の章の名前', () => {
    expect(partLabel({ kind: 'file', title: 'b.pdf', chapter: '第2章 壁' })).toBe('第2章 壁');
    expect(partLabel({ kind: 'file', title: 'ガイド（柱脚金物）.pdf', chapter: '第2章' })).toBe('柱脚金物');
    const item = (fileName, extra = {}) => ({ role: 'body', fileName, ...extra });
    // 表紙のファイル名が違っても、分けたファイルの始まりのファイルだけで頭を求める。
    const items = [item('表紙.pdf', { role: 'front' }), item('本_001-050.pdf'), item('本_051-100.pdf')];
    expect(partLabels(items, [null, null, { kind: 'file', title: '本_051-100.pdf' }], [2])).toEqual(['001-050', '051-100']);
    // 最初のファイルも、ファイルの境目で分けているなら、ほかと同じ形（括弧の中）。
    const guide = [item('ガイド（概要）.pdf', { outline: '1. 概要' }), item('ガイド（基礎）.pdf', { outline: '2. 基礎' })];
    expect(partLabels(guide, [null, { kind: 'file', title: 'ガイド（基礎）.pdf', chapter: '2. 基礎' }], [1])).toEqual(['概要', '基礎']);
    // 目次（1 頁）を第 1 章と一緒にしたファイルは、第 1 章の名前。
    const book = [item('a.pdf'), item('a.pdf'), item('a.pdf'), item('a.pdf')];
    const toc = [null, { kind: 'outline', title: '目次' }, { kind: 'outline', title: '第1章' }, null];
    expect(partLabels(book, toc, [1], { joinNext: true })).toEqual(['', '目次 第1章']);
    // 最初のファイルでも同じ。
    const head = [item('a.pdf', { outline: '目次' }), item('a.pdf'), item('a.pdf')];
    expect(partLabels(head, [null, { kind: 'outline', title: '第1章' }, null], [], { joinNext: true })).toEqual(['目次 第1章']);
    // 区切りごとに分けたとき（1 頁を次と一緒にしうるとき）でなければ、並べない。
    expect(partLabels(book, toc, [1])).toEqual(['', '目次']);
  });
});

describe('細かすぎるファイルの境目と、理由の出し方', () => {
  it('何百もの 1 頁のファイルの境目では、区切りごとに分けない（章のある境目では分ける）', () => {
    const items = Array.from({ length: 30 }, () => ({ role: 'body', bytes: MEGABYTE }));
    const candidates = items.map((_, i) => (i > 0 ? { kind: 'file', title: `${i}.pdf` } : null));
    expect(splitAtBreaks(items, candidates, { megabytes: null, pages: null })).toEqual([]);
    candidates[15] = { kind: 'file', title: '15.pdf', chapter: '第2章' };
    expect(splitAtBreaks(items, candidates, { megabytes: null, pages: null })).toEqual([15]);
    // 1 頁ずつのファイルのそれぞれにしおりがあっても（章のある境目まで細かすぎる）、分けない。
    const all = items.map((_, i) => (i > 0 ? { kind: 'file', title: `${i}.pdf`, chapter: `${i}` } : null));
    expect(splitAtBreaks(items, all, { megabytes: null, pages: null })).toEqual([]);
  });

  it('前の頁と同じ名前のしおり・見出しは区切りにせず、頁ごとに違う見出しは細かすぎるので使わない', () => {
    const slide = (heading) => ({ fileKey: 'a', fileName: 'a.pdf', role: 'body', heading });
    const items = [slide('Section 1'), slide('Section 1'), slide('Section 1'), slide('Section 2'), slide('Section 2')];
    expect(breakCandidates(items)).toEqual([null, null, null, { kind: 'heading', title: 'Section 2' }, null]);
    // ファイルの境目でも、前の頁と同じ名前なら章の始まりではない。
    const files = [{ ...slide('Section 1'), fileKey: 'a' }, { ...slide('Section 1'), fileKey: 'b', fileName: 'b.pdf' }];
    expect(breakCandidates(files)[1]).toEqual({ kind: 'file', title: 'b.pdf' });
    const many = Array.from({ length: 30 }, () => ({ role: 'body', bytes: MEGABYTE }));
    const headings = many.map((_, i) => (i > 0 ? { kind: 'heading', title: `${i}` } : null));
    expect(splitAtBreaks(many, headings, { megabytes: null, pages: null })).toEqual([]);
  });

  it('ファイルの境目の頁にしおり・見出しもあれば、その名前も添える', () => {
    expect(breakReason({ kind: 'file', title: 'b.pdf', chapter: '第2章' })).toBe('ファイルの境目「b.pdf」（第2章）');
    expect(breakReason({ kind: 'heading', title: '第2章' })).toBe('見出し「第2章」');
  });
});
