// PDF 結合ツール: 分ける位置の候補と提案、分けたファイルの名前と頁ラベル（split.js）。

import { describe, expect, it } from 'vitest';
import {
  breakCandidates,
  breakRanks,
  breakReason,
  middleCut,
  chapterHeading as headingOfLines,
  MEGABYTE,
  partFileName,
  partLabel,
  partLabels,
  RANKS,
  runningHead,
  seamCandidates,
  splitByRank,
  sliceLabelRanges,
  splitRanges,
  suggestSplits,
  tocEntries,
  tocPage,
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

  it('目次の項目（見出しの形で始まり、頁番号で終わる行）の題と頁番号を読み、その頁は目次とする', () => {
    const items = [
      line('第3 章 木造住宅バルコニーおよび陸屋根 55', 0.2),
      line('Chapter 2 Walls …… 41', 0.25),
      line('第1部 総論 P.3', 0.3),
      // 英字で終わる題のあとの数は、題の一部（頁番号ではない）。
      line('Chapter 3 Step 2', 0.35),
      // 柱に頁番号が並んだ行と、見出しの形で始まる本文の行は、目次の項目ではない。
      line('第2 章 2.2.5(1) 棟違い 23', 0.4),
      line('第3章で述べたとおり、表 5', 0.45),
      line('本文の行です。', 0.5),
    ];
    expect(tocEntries(groupLines(items))).toEqual([
      { title: '第3 章 木造住宅バルコニーおよび陸屋根', page: 55 },
      { title: 'Chapter 2 Walls', page: 41 },
      { title: '第1部 総論', page: 3 },
    ]);
    expect(tocPage(groupLines([line('第6 章 RC 造住宅外壁 161', 0.2, 0.04), line('本文の行です。', 0.5)]))).toBe(true);
    // 章のあとに節の番号が続く行は、本文の頁の柱（見出しにしない）。
    const body = [0.5, 0.55, 0.6, 0.65].map((y) => line('本文の行です。', y));
    expect(chapterHeading([line('第2 章 2.2.5(1) 棟違い', 0.05, 0.04), ...body])).toBeNull();
  });

  it('目次の頁（「目次」の題があるか、同じ階層の見出しの形の行が違う番号で並ぶ頁）では、見出しを拾わない', () => {
    const body = [0.5, 0.55, 0.6, 0.65].map((y) => line('本文の行です。', y));
    // スキャンの OCR で頁番号が別の行に分かれた目次。部（編）が並ぶので、扉より強い区切りにしない。
    expect(chapterHeading([line('第1編 材料', 0.2, 0.04), line('第1章 防水材', 0.25), line('第2編 施工', 0.3, 0.04), ...body])).toBeNull();
    expect(chapterHeading([line('第1章 材料', 0.2, 0.04), line('第2章 施工', 0.25, 0.04), ...body])).toBeNull();
    expect(chapterHeading([line('目 次', 0.1, 0.04), line('第1章 材料', 0.2, 0.04), ...body])).toBeNull();
    expect(tocPage([line('CONTENTS', 0.1), line('本文の行です。', 0.5)])).toBe(true);
    expect(tocPage([line('本文の行です。', 0.5)])).toBe(false);
    // 本文で別の章を指す行（「第2章で述べた…」）があっても、目次ではない。
    expect(chapterHeading([line('第1章 材料', 0.2, 0.04), line('第2章で詳しく述べる。', 0.5), ...body])).toBe('第1章 材料');
    // 部の扉にその部の章が並ぶのは、目次ではない（上の階層は 1 つ）。
    expect(chapterHeading([line('第1部 総論', 0.2, 0.04), line('第1章 材料', 0.3), line('第2章 施工', 0.35), ...body])).toBe('第1部 総論');
  });

  it('題として続けるのは、すぐ下の短い大きな行だけ（見出しや段落は続けない）', () => {
    const body = [0.4, 0.45, 0.5, 0.55].map((y) => line('本文の行です。', y));
    expect(chapterHeading([line('Chapter 3', 0.2, 0.04), line('Section 1', 0.25, 0.04), ...body])).toBe('Chapter 3');
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

  it('項目の行が少ない扉でも、見出しの字の 6 割ある題は続け、本文の字は続けない', () => {
    // プレセッターマニュアルの Section 6 の扉（柱・見出し・題・項目 3 行・欄外）。
    const lines = [
      line('6 プレセッターの施工上の注意事項', 0.093, 0.0285),
      line('Section 6', 0.139, 0.0238),
      line('プレセッターの施工上の注意事項', 0.161, 0.0166),
      line('6−1 施工上の注意事項', 0.214, 0.0166),
      line('▼6−1—1 金物取付け時の注意事項 ・・207', 0.235, 0.0119),
      line('▼6−1—2 建て方時の注意事項 ・・208', 0.26, 0.0119),
      line('206 PRESETOR MANUAL 2025 年度版', 0.935, 0.0202),
    ];
    expect(chapterHeading(lines)).toBe('Section 6 プレセッターの施工上の注意事項');
    const body = [line('Section 6', 0.139, 0.0238), line('本文の行です。', 0.161, 0.0119), ...lines.slice(3)];
    expect(chapterHeading(body)).toBe('Section 6');
    // 見出しが本文の 1.4 倍ほどしかない頁でも、本文の行は題にしない。
    const plain = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45].map((y) => line('本文の行です。', y, 0.017));
    expect(chapterHeading([line('Section 3', 0.1, 0.024), line('この章では施工手順を説明する。', 0.13, 0.017), ...plain])).toBe(
      'Section 3'
    );
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

describe('breakRanks（区切りの確からしさの順位）', () => {
  const pages = (n) => Array.from({ length: n }, () => ({ role: 'body', bytes: MEGABYTE }));

  it('しおり・部や編の見出し・章の見出し・節などの見出し・ファイルの境目の順', () => {
    const items = pages(12);
    const candidates = items.map(() => null);
    candidates[1] = { kind: 'outline', title: '序' };
    candidates[3] = { kind: 'heading', title: '第1部 総論' };
    candidates[5] = { kind: 'heading', title: '第2章 材料' };
    candidates[7] = { kind: 'heading', title: 'Section 3' };
    candidates[9] = { kind: 'file', title: 'b.pdf' };
    candidates[11] = { kind: 'heading', title: 'Part II' };
    expect(breakRanks(items, candidates)).toEqual([null, 1, null, 2, null, 3, null, 4, null, 5, null, 2]);
    expect(RANKS).toEqual({ outline: 1, part: 2, chapter: 3, section: 4, file: 5 });
    // ファイルの境目の頁にしおり・見出しもあれば、その順位（しおりか、見出しの種類）。
    candidates[9] = { kind: 'file', title: 'b.pdf', chapter: 'Chapter 4' };
    expect(breakRanks(items, candidates)[9]).toBe(3);
    // しおりの題に階層の形があれば、その階層（「Chapter 4」は章）。形が無ければしおりの順位。
    items[9] = { ...items[9], outline: 'Chapter 4' };
    expect(breakRanks(items, candidates)[9]).toBe(3);
    candidates[9] = { kind: 'file', title: 'b.pdf', chapter: '付録' };
    items[9] = { ...items[9], outline: '付録' };
    expect(breakRanks(items, candidates)[9]).toBe(1);
    candidates[9] = { kind: 'heading', title: '第三編' };
    expect(breakRanks(items, candidates)[9]).toBe(2);
  });

  it('見出しの頁が続くところは、最後の頁のほかはファイルの境目と同じ順位に下げる（目次の頁など）', () => {
    const items = pages(8);
    const candidates = items.map(() => null);
    // 目次の頁（2・3）の行を見出しと読み、そのすぐ後ろ（4）に本当の章の扉がある。
    candidates[2] = { kind: 'heading', title: '第1章 材料' };
    candidates[3] = { kind: 'heading', title: '第2章 統計' };
    candidates[4] = { kind: 'heading', title: '第1章 材料' };
    expect(breakRanks(items, candidates)).toEqual([null, null, 5, 5, 3, null, null, null]);
    // 部の扉のすぐ後ろに章の扉が続くところ（上の階層から下の階層へ）は下げない。
    const part = items.map(() => null);
    part[2] = { kind: 'heading', title: '第1部 総論' };
    part[3] = { kind: 'heading', title: '第1章 材料' };
    expect(breakRanks(items, part).slice(2, 4)).toEqual([2, 3]);
    // ファイルの境目の頁の見出しも、続く見出しとして見る。
    const file = items.map(() => null);
    file[2] = { kind: 'heading', title: '第1章 材料' };
    file[3] = { kind: 'file', title: 'b.pdf', chapter: '第2章 統計' };
    expect(breakRanks(items, file).slice(2, 4)).toEqual([5, 3]);
  });

  it('細かすぎる順位の区切り（頁ごとのしおりなど）は使わず、ほかの順位は使う', () => {
    const items = pages(39);
    const candidates = items.map((_, i) => (i > 0 && i <= 20 ? { kind: 'outline', title: `${i}` } : null));
    candidates[30] = { kind: 'heading', title: '第1章' };
    const ranks = breakRanks(items, candidates);
    expect(ranks.filter((rank) => rank !== null)).toEqual([3]);
    // 見出しは部・章・節をまとめて数える（章 15・節 15 の頁ごとの見出しは細かすぎる）。
    const deck = pages(40);
    const mixed = deck.map((_, i) => (i > 0 && i <= 30 && i % 2 === 1 ? { kind: 'heading', title: `Chapter ${i}` } : null));
    deck.forEach((_, i) => {
      if (i > 0 && i <= 30 && i % 2 === 0) mixed[i] = { kind: 'heading', title: `Section ${i}` };
    });
    expect(breakRanks(deck, mixed).every((rank) => rank === null)).toBe(true);
  });
});

describe('柱・頁番号・目次の項目を手掛かりにする（breakCandidates・breakRanks）', () => {
  const page = (extra = {}) => ({ fileKey: 'a', fileName: 'a.pdf', role: 'body', bytes: MEGABYTE, ...extra });

  it('柱は、上の余白の帯の文字（頁番号は除く）', () => {
    const lines = [
      { text: '第2 章 防水の設計 23', y: 0.04 },
      { text: '24', y: 0.05 },
      { text: '本文の行です。', y: 0.5 },
    ];
    expect(runningHead(lines)).toBe('第2 章 防水の設計');
    expect(runningHead([{ text: '本文の行です。', y: 0.5 }])).toBe('');
  });

  it('柱の章・節の番号が変わるところ（手前に柱の無い扉があれば、そこから）を候補にし、章は節より確かにする', () => {
    const run = (running) => page({ running });
    // 左の頁に章、右の頁に節の柱が載る本。
    const items = [
      run('第1章 材料'),
      run('1.1 防水材'),
      run('第1章 材料'),
      run('1.1 防水材'),
      run('第1章 材料'),
      run('1.2 シート'),
      run('第1章 材料'),
      run('1.2 シート'),
      page(), // 第2章の扉（柱が無い）
      run('第2章 施工'),
      run('2.1 下地'),
      run('第2章 施工'),
      run('2.1 下地'),
    ];
    const candidates = breakCandidates(items);
    expect(candidates.flatMap((candidate, i) => (candidate ? [[i, candidate.running]] : []))).toEqual([
      [5, 'section'],
      [8, 'chapter'],
    ]);
    expect(candidates[8]).toEqual({ kind: 'running', title: '第2章 施工', running: 'chapter' });
    // 柱の章の変わり目だけなら章の見出しと同じ、節の変わり目は節の見出しと同じ。
    const ranks = breakRanks(items, candidates);
    expect([ranks[5], ranks[8]]).toEqual([RANKS.section, RANKS.chapter]);
    // 見出しと柱の章の変わり目が重なれば、しおりより確か。
    items[8] = { ...items[8], heading: '第2章 施工' };
    const both = breakCandidates(items);
    expect(both[8]).toEqual({ kind: 'heading', title: '第2章 施工', running: 'chapter' });
    expect(breakRanks(items, both)[8]).toBeLessThan(RANKS.outline);
  });

  it('OCR で点のあとに空白が入った節の番号（「6. 1」）も読む', () => {
    const run = (running) => page({ running });
    const items = [run('6. 1 許容応力度計算の方法'), run('6. 1 許容応力度計算の方法'), run('6. 2 耐震計算の方法'), run('6. 2 耐震計算の方法')];
    expect(breakCandidates(items)[2]).toMatchObject({ running: 'section' });
  });

  it('柱のある本では、区切りの手前の大きな字の題だけの頁（章の扉）とその裏へ区切りを戻す', () => {
    const layout = (chars, height) => ({ chars, height, median: 0.01 });
    const body = (running) => page({ running, layout: layout(800, 0.012) });
    const items = [
      body('6.1 許容応力度'),
      body('6.1 許容応力度'),
      body('6.1 許容応力度'),
      page({ layout: layout(20, 0.031) }), // 扉（大きな字の題）
      page({ layout: layout(30, 0.012) }), // 扉の裏（汚れを読んだ数文字）
      page({ heading: '第7章 基礎', running: '7.1 地盤', layout: layout(700, 0.019) }),
      body('7.1 地盤'),
      page({ layout: layout(0, 0) }), // 章の終わりの白紙
      page({ heading: '第8章 屋根', running: '8.1 屋根', layout: layout(700, 0.019) }),
      body('8.1 屋根'),
    ];
    const candidates = breakCandidates(items);
    expect(candidates[3]).toMatchObject({ kind: 'heading', title: '第7章 基礎' });
    expect(candidates[5]).toBeNull();
    // 題の無い白紙だけなら戻さない（前の章の終わりの白紙は前のまとまりのもの）。
    expect(candidates[8]).toMatchObject({ kind: 'heading', title: '第8章 屋根' });
    // 本の先頭まで戻れば、区切りにしない。
    const first = items.slice(3);
    expect(breakCandidates(first)[2]).toBeNull();
    expect(breakCandidates(first).some((candidate) => candidate?.title === '第7章 基礎')).toBe(false);
    // 字が本文の 1.8 倍に満たなければ、扉の題とはみなさない。
    const small = items.map((item, i) => (i === 3 ? { ...item, layout: layout(20, 0.015) } : item));
    expect(breakCandidates(small)[5]).toMatchObject({ kind: 'heading', title: '第7章 基礎' });
    // 柱の無い本では戻さない（扉と見分けられないので）。
    const plain = items.map(({ running, ...rest }) => rest);
    expect(breakCandidates(plain)[5]).toMatchObject({ kind: 'heading', title: '第7章 基礎' });
    // ファイルの境目は動かさない。
    const files = items.map((item, i) => ({ ...item, fileKey: i < 5 ? 'a' : 'b', fileName: i < 5 ? 'a.pdf' : 'b.pdf' }));
    expect(breakCandidates(files)[5]).toMatchObject({ kind: 'file' });
  });

  it('柱の番号が戻るところ・1 頁だけ違うところ（OCR の読み違い）は使わない', () => {
    const run = (running) => page({ running });
    const items = [
      run('第2 章 2.1 下地'),
      run('第2 章 2.1 下地'),
      run('第8 章 2.1 下地'), // 1 頁だけの読み違い
      run('第2 章 2.1 下地'),
      run('第2 章 2.2 仕上げ'),
      run('第2 章 2.2 仕上げ'),
      run('第1 章 2.2 仕上げ'), // 戻る
      run('第2 章 2.2 仕上げ'),
    ];
    expect(breakCandidates(items).flatMap((candidate, i) => (candidate ? [[i, candidate.running]] : []))).toEqual([[4, 'section']]);
  });

  it('柱に章の番号が無くても、節の番号の上の段が変われば章の変わり目。番号の無い柱は文字で比べる', () => {
    const run = (running) => page({ running });
    const items = [
      run('1.1 概要'),
      run('1.2 材料'),
      run('1.2 材料'),
      run('2.1 施工'),
      run('2.1 施工'),
      run('付録'),
      run('付録'),
      run('索引'),
      run('索引'),
    ];
    expect(breakCandidates(items).flatMap((candidate, i) => (candidate ? [[i, candidate.running]] : []))).toEqual([
      [1, 'section'],
      [3, 'chapter'],
      [5, 'text'],
      [7, 'text'],
    ]);
    // 全角の数字も読む。
    const wide = [run('第１章 材料'), run('第１章 材料'), run('第２章 施工'), run('第２章 施工')];
    expect(breakCandidates(wide)[2]).toMatchObject({ running: 'chapter' });
    // 漢数字の章も数で比べる（第九章 → 第十二章）。
    const kanji = [run('第九章 材料'), run('第九章 材料'), run('第十二章 施工'), run('第十二章 施工'), run('第十章 施工')];
    expect(breakCandidates(kanji).flatMap((candidate, i) => (candidate ? [i] : []))).toEqual([2]);
    // 数にできない章の番号（ローマ数字）は、前に無ければ新しい章。
    const roman = [run('Chapter iv Walls'), run('Chapter iv Walls'), run('Chapter v Roofs'), run('Chapter v Roofs')];
    expect(breakCandidates(roman)[2]).toMatchObject({ running: 'chapter' });
  });

  it('柱の部と章は別に比べ（部が変わると章の番号が戻る本）、章の変わり目は 2 つの段で重ねない', () => {
    const run = (running) => page({ running });
    // 左の頁に部、右の頁に章。第2部で章の番号が 1 に戻る。
    const parts = [run('第1部 総論'), run('第5章 材料'), run('第1部 総論'), run('第5章 材料'), run('第2部 各論'), run('第1章 施工'), run('第2部 各論'), run('第1章 施工')];
    expect(breakCandidates(parts).flatMap((candidate, i) => (candidate ? [[i, candidate.running]] : []))).toEqual([[4, 'chapter']]);
    // 右の頁の節（3.1）で章の変わり目を先に見つけたら、次の左の頁の章の番号では重ねない。
    const sides = [run('第2章 施工'), run('2.5 仕上げ'), run('第2章 施工'), run('2.5 仕上げ'), run('3.1 下地'), run('第3章 点検'), run('3.1 下地'), run('第3章 点検')];
    expect(breakCandidates(sides).flatMap((candidate, i) => (candidate ? [[i, candidate.running]] : []))).toEqual([[4, 'chapter']]);
  });

  it('節の番号は、語の始まりの番号だけ（「1.5mm」「Ver 2.0」は節の番号ではない）', () => {
    const run = (running) => page({ running });
    const items = [run('防水 Ver 2.0'), run('防水 Ver 2.0'), run('防水 Ver 3.0'), run('防水 Ver 3.0'), run('厚さ 1.5mm'), run('厚さ 1.5mm'), run('厚さ 2.5mm'), run('厚さ 2.5mm')];
    // 番号の無い柱として、文字で比べる（変わったところは柱の文字の変わり目）。
    expect(breakCandidates(items).flatMap((candidate, i) => (candidate ? [[i, candidate.running]] : []))).toEqual([
      [2, 'text'],
      [4, 'text'],
      [6, 'text'],
    ]);
  });

  it('柱の変わり目が細かすぎれば（本文の行を柱と読んだときなど）、柱の点数を足さない', () => {
    // 2 頁ごとに節の番号が増える柱（60 頁で 29 か所）。
    const items = Array.from({ length: 60 }, (_, i) => page({ running: `${1 + (i >> 4)}.${1 + ((i >> 1) % 8)} 本文`, heading: i === 30 ? '第2章 施工' : null }));
    const ranks = breakRanks(items, breakCandidates(items));
    expect(ranks[30]).toBe(RANKS.chapter);
  });

  it('階層の形の無いしおりは、手掛かりを足したほかの候補より確かにする', () => {
    const items = [page(), page({ outline: '総論' }), page(), page({ heading: '第2章 施工', toc: '第2章 施工' }), page({ running: '第2章 施工' }), page({ running: '第2章 施工' })];
    items[2] = { ...items[2], running: '第1章 材料' };
    items[1] = { ...items[1], running: '第1章 材料' };
    const ranks = breakRanks(items, breakCandidates(items));
    expect(ranks[1]).toBeLessThan(ranks[3]);
  });

  it('しおりの題が番号を振った項目（「01. マウス操作」）なら節、部・章の形ならその階層にする', () => {
    // 章の見出しはしおりに無く、節にだけしおりを付けた本（Vectorworks の本）。
    const items = [
      page(),
      page({ heading: 'Chapter 1' }),
      page({ outline: '01. マウス操作' }),
      page(),
      page({ outline: '02. インターフェイス' }),
      page({ heading: 'Chapter 2' }),
      page({ outline: '01. 敷地の入力' }),
      page({ outline: '(2) 通り芯' }),
      page({ outline: '1-3 間取り' }),
      page({ outline: '第3章 基本モデル' }),
      page({ outline: '付録' }),
    ];
    const ranks = breakRanks(items, breakCandidates(items));
    expect(ranks).toEqual([null, RANKS.chapter, RANKS.section, null, RANKS.section, RANKS.chapter, RANKS.section, RANKS.section, RANKS.section, RANKS.chapter, RANKS.outline]);
    // 本を通して番号を振ったしおり（「1. はじめに」「2. 方法」。番号が繰り返さない）は、章などの区切り。
    const whole = [page(), page({ outline: '1. はじめに' }), page({ heading: '第2章 補足' }), page({ outline: '2. 方法' })];
    const wholeRanks = breakRanks(whole, breakCandidates(whole));
    expect([wholeRanks[1], wholeRanks[3]]).toEqual([RANKS.outline, RANKS.outline]);
  });

  it('前付け（0 以下の頁番号）から本文（1 頁から）に入るところを、章と同じ確かさの候補にする', () => {
    const items = [page({ number: -2 }), page({ number: -1 }), page({ number: 0 }), page({ number: 1 }), page({ number: 2 })];
    const candidates = breakCandidates(items);
    expect(candidates[3]).toEqual({ kind: 'opening', title: '1 頁', opening: true });
    expect(breakRanks(items, candidates)[3]).toBe(RANKS.chapter);
    expect(breakReason(candidates[3])).toBe('本文の始まり「1 頁」');
    // 手前に番号の無い頁（章の扉）があれば、そこから（見出しのある頁で止める）。
    const title = [page({ number: 0 }), page(), page(), page({ number: 1 })];
    expect(breakCandidates(title)[1]).toEqual({ kind: 'opening', title: '1 頁', opening: true });
    const headed = [page({ number: 0 }), page(), page({ heading: '第1章 総論' }), page(), page({ number: 1 })];
    expect(breakCandidates(headed)[2]).toMatchObject({ kind: 'heading', opening: true });
  });

  it('汚れを OCR で読んだような字の少ない柱は、柱として扱わない', () => {
    const head = (text) => runningHead([{ text, y: 0.03 }]);
    expect(head('! ● ● . ● ●● ● ●● ● ●●')).toBe('');
    expect(head('●ー● . ● ● ● . ●ー● ● ●')).toBe('');
    expect(head('第2 章 木造住宅 屋根')).toBe('第2 章 木造住宅 屋根');
    // 番号の点・括弧の多い柱、飾りの多い章の柱、1 字の柱は残す。
    expect(head('1.1.1(1) 壁')).toBe('1.1.1(1) 壁');
    expect(head('◆◆ 第3章 ◆◆')).toBe('◆◆ 第3章 ◆◆');
    expect(head('序')).toBe('序');
  });

  it('OCR で点の落ちた節の番号（22.5 は 2.2.5）は章の番号で読み、日本語が続く番号（2.8.2陸棟）も読む', () => {
    const run = (running) => page({ running });
    const items = [
      run('第2 章 屋根 2.2 下ぶき 2.2.1 ふき方'),
      run('第2 章 屋根 22.5(2) 棟違い'), // 2.2.5
      run('第2 章 屋根 2.3 下屋 2.3.1 下ぶき'),
      run('第2 章 屋根 2.3.2 壁際'),
      run('第2 章 屋根 2.8.1 片流れ棟'),
      run('第2 章 屋根 2.8.2陸棟'),
      run('第2 章 屋根 29.1 庇の下地'), // 2.9.1
      run('第2 章 屋根 2.9.2 シーリング'),
    ];
    expect(breakCandidates(items).flatMap((candidate, i) => (candidate ? [[i, candidate.running]] : []))).toEqual([
      [2, 'section'],
      [4, 'section'],
      [6, 'section'],
    ]);
    // 単位の続く数（「1.5倍」「2.5％」）は節の番号ではない（文字で比べる）。
    const units = [run('荷重 1.5倍 の検討'), run('荷重 1.5倍 の検討'), run('荷重 2.5％'), run('荷重 2.5％')];
    expect(breakCandidates(units)[2]).toMatchObject({ running: 'text' });
  });

  it('本文の頁番号が戻るところと、目次の項目が指す頁も候補にし、点数を足す', () => {
    const items = [page({ number: 10 }), page({ number: 11 }), page({ number: 1 }), page({ number: 2 }), page({ number: 3, toc: '第3章 仕上げ' })];
    const candidates = breakCandidates(items);
    expect(candidates[2]).toEqual({ kind: 'restart', title: '1 頁', restart: true });
    expect(candidates[4]).toEqual({ kind: 'heading', title: '第3章 仕上げ', toc: true });
    // 頁番号の戻りだけなら節と同じ、目次の項目が指す章は、しおりと同じくらい確か。
    const ranks = breakRanks(items, candidates);
    expect([ranks[2], ranks[4]]).toEqual([RANKS.section, RANKS.outline]);
  });

  it('柱の行の端の頁番号は、いろいろな書き方でも除く', () => {
    const head = (text) => runningHead([{ text, y: 0.03 }]);
    expect(head('- 23 - 第2 章 防水の設計')).toBe('第2 章 防水の設計');
    expect(head('第2 章 防水の設計 p.23')).toBe('第2 章 防水の設計');
    expect(head('第2 章 防水の設計 ２３頁')).toBe('第2 章 防水の設計');
    expect(head('第2 章 防水の設計 - 23 -')).toBe('第2 章 防水の設計');
  });

  it('柱の無い頁を遡るのは、見出しのある頁（章の扉）まで', () => {
    const items = [
      page({ running: '第1章 材料' }),
      page({ running: '第1章 材料' }),
      page(), // 白紙
      page({ heading: '第2章 施工' }), // 扉
      page(),
      page({ running: '第2章 施工' }),
    ];
    const candidates = breakCandidates(items);
    expect(candidates[3]).toEqual({ kind: 'heading', title: '第2章 施工', running: 'chapter' });
    expect(candidates[2]).toBeNull();
  });

  it('柱の変わり目が細かすぎれば、見出しに柱の点数を足さない', () => {
    const items = Array.from({ length: 30 }, (_, i) => page({ running: `柱 ${i}`, heading: i === 10 ? '第2章 施工' : null }));
    const ranks = breakRanks(items, breakCandidates(items));
    expect(ranks[10]).toBe(RANKS.chapter);
  });

  it('頁番号の戻りは、頁番号の無い頁を飛ばして比べる', () => {
    const items = [page({ number: 10 }), page({ number: 11 }), page(), page({ number: 1 })];
    expect(breakCandidates(items)[3]).toEqual({ kind: 'restart', title: '1 頁', restart: true });
  });

  it('しおりより確かな点数は、しおりより上の順位にする（目次が裏付ける部と章を同じ順位にしない）', () => {
    const items = [page(), page(), page({ heading: '第1部 総論', toc: '第1部 総論' }), page(), page({ heading: '第2章 施工', toc: '第2章 施工' }), page()];
    const ranks = breakRanks(items, breakCandidates(items));
    expect(ranks[2]).toBeLessThan(ranks[4]);
    expect(ranks[4]).toBe(RANKS.outline);
    // いちばん上の順位から分ける（部で分ければ収まるので、章では分けない）。
    expect(splitByRank(items, breakCandidates(items), { megabytes: 4, pages: null })).toEqual([2]);
  });
});

describe('splitByRank', () => {
  const pages = (n, size = 1) => Array.from({ length: n }, () => ({ role: 'body', bytes: size * MEGABYTE }));
  const limit = (megabytes) => ({ megabytes, pages: null });

  it('上限に収まれば、区切りがあっても分けない', () => {
    const items = pages(10);
    const candidates = items.map(() => null);
    candidates[5] = { kind: 'outline', title: '第2章' };
    expect(splitByRank(items, candidates, limit(10))).toEqual([]);
    expect(splitByRank(items, candidates, limit(null))).toEqual([]);
  });

  it('いちばん確からしい順位の区切りのすべてで分け、まだ上限を超えるセクションだけを次の順位で分ける', () => {
    const items = pages(20);
    const candidates = items.map(() => null);
    candidates[4] = { kind: 'heading', title: '第1章' };
    candidates[7] = { kind: 'heading', title: 'Section 2' };
    candidates[10] = { kind: 'heading', title: '第2部' };
    candidates[15] = { kind: 'heading', title: '第3章' };
    candidates[17] = { kind: 'file', title: 'b.pdf' };
    // 部（10）で分ければ、どちらも収まる（章では分けない。小さいセクションもまとめない）。
    expect(splitByRank(items, candidates, limit(12))).toEqual([10]);
    // 部で分けても上限を超えるセクションは、章で分ける。
    expect(splitByRank(items, candidates, limit(6))).toEqual([4, 10, 15]);
    // 章で分けても超えるセクションは節で、節も無ければファイルの境目、それも無ければ大きさで分ける。
    expect(splitByRank(items, candidates, limit(4))).toEqual([4, 7, 10, 13, 15, 17]);
  });

  it('区切りが無ければ、大きさがほぼ同じになるように、上限に収まる最少の数で分ける', () => {
    const items = pages(9);
    expect(splitByRank(items, items.map(() => null), limit(4))).toEqual([3, 6]);
  });

  it('しおり・見出しで 1 頁だけのファイルはできないようにする（目次の頁・部の扉は続く章と一緒に）', () => {
    const items = pages(8);
    const candidates = items.map(() => null);
    candidates[1] = { kind: 'outline', title: '目次' };
    candidates[2] = { kind: 'outline', title: '第一部' };
    candidates[3] = { kind: 'outline', title: '第1章' };
    candidates[5] = { kind: 'outline', title: '第2章' };
    expect(splitByRank(items, candidates, limit(3))).toEqual([2, 5]);
  });

  it('本の最後の頁にある章の扉は前と一緒にし、ファイルの境目で始まる 1 頁はそのまま', () => {
    const items = pages(8);
    const candidates = items.map(() => null);
    candidates[3] = { kind: 'outline', title: '第1章' };
    candidates[7] = { kind: 'outline', title: '付録' };
    expect(splitByRank(items, candidates, limit(6))).toEqual([3]);
    candidates[7] = { kind: 'file', title: 'c.pdf', chapter: '付録' };
    items[7] = { ...items[7], outline: '付録' };
    expect(splitByRank(items, candidates, limit(6))).toEqual([3, 7]);
  });

  it('表紙だけのファイルは作らない（大きさで分けるときも）', () => {
    // 1 頁の表紙と 5 頁の目次（先頭に置く 6 頁）は本文と分けるが、その中では表紙の後ろで分けない。
    const items = [
      ...Array.from({ length: 6 }, () => ({ role: 'front', bytes: 10 * MEGABYTE })),
      ...Array.from({ length: 3 }, () => ({ role: 'body', bytes: MEGABYTE })),
    ];
    const candidates = items.map(() => null);
    candidates[6] = { kind: 'file', title: 'body.pdf' };
    // 表紙の後ろ（1〜2）では分けず、上限に収まる最少の数（2 つ）に分ける。
    expect(splitByRank(items, candidates, limit(50))).toEqual([5]);
  });

  it('ファイルの境目では、すべてでは分けず、上限に収まる最少の数に分ける位置として使う', () => {
    // 連続スキャンの束（40 頁ずつ 10 束・400 MB）。上限 250 MB なら 2 つ。
    const items = pages(400);
    const candidates = items.map((_, i) => (i > 0 && i % 40 === 0 ? { kind: 'file', title: `${i}.pdf` } : null));
    const starts = splitByRank(items, candidates, limit(250));
    expect(starts).toHaveLength(1);
    expect(starts[0] % 40).toBe(0);
  });

  it('何百もの 1 頁のファイルの境目のように細かすぎる区切りでは分けず、大きさで分ける', () => {
    const items = pages(30);
    const candidates = items.map((_, i) => (i > 0 ? { kind: 'file', title: `${i}.pdf` } : null));
    expect(splitByRank(items, candidates, limit(10))).toEqual([10, 20]);
  });
});

describe('seamCandidates（頁の帯の ▲）', () => {
  it('しおり・見出しと、しおり・見出しのあるファイルの境目を出し、ただのファイルの境目は出さない', () => {
    const candidates = [
      null,
      { kind: 'outline', title: '序' },
      { kind: 'file', title: 'b.pdf' },
      { kind: 'file', title: 'c.pdf', chapter: '第2章' },
      { kind: 'heading', title: 'Section 1' },
    ];
    expect(seamCandidates(candidates, [null, 1, 5, 3, null])).toEqual([null, 1, null, 3, null]);
    // ファイルの境目と同じ順位（柱の文字が変わっただけなど）も出さない。
    expect(seamCandidates(candidates, [null, 1, 5, 3, 5])).toEqual([null, 1, null, 3, null]);
  });
});

describe('middleCut（このファイルを 2 つに分ける）', () => {
  it('中の区切りのうち、いちばん確からしいもので、真ん中に近いところ。区切りが無ければ真ん中', () => {
    // 1 は節（4）で真ん中から遠く、4 と 6 は章（3）。章のうち真ん中（5）に近い方（同じなら前）。
    const ranks = [null, 4, null, null, 3, null, 3, null, null, null, 1];
    expect(middleCut(ranks, 0, 10)).toBe(4);
    // 確からしい区切りなら、真ん中から遠くても選ぶ。
    expect(middleCut([null, 4, null, null, null, null, 3, null, null, 3], 0, 10)).toBe(6);
    // 両端の頁（1 頁だけのファイルになる位置）では分けない。
    expect(middleCut([null, 4, null, null, null, null, null, 3], 0, 8)).toBe(4);
    expect(middleCut([null, null, null, null], 0, 4)).toBe(2);
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

describe('ファイルの境目の章と、分けたファイルの名前', () => {
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
    // 次の頁の区切りが弱いか、候補でなければ、並べない（同じか強ければ並べる）。
    expect(partLabels(book, toc, [1], { joinNext: true, ranks: [null, 2, null, null] })).toEqual(['', '目次']);
    expect(partLabels(book, toc, [1], { joinNext: true, ranks: [null, 2, 3, null] })).toEqual(['', '目次']);
    expect(partLabels(book, toc, [1], { joinNext: true, ranks: [null, 2, 2, null] })).toEqual(['', '目次 第1章']);
  });
});

describe('細かすぎるファイルの境目と、理由の出し方', () => {
  it('前の頁と同じ名前のしおり・見出しは区切りにせず、頁ごとに違う見出しは細かすぎるので使わない', () => {
    const slide = (heading) => ({ fileKey: 'a', fileName: 'a.pdf', role: 'body', heading });
    const items = [slide('Section 1'), slide('Section 1'), slide('Section 1'), slide('Section 2'), slide('Section 2')];
    expect(breakCandidates(items)).toEqual([null, null, null, { kind: 'heading', title: 'Section 2' }, null]);
    // ファイルの境目でも、前の頁と同じ名前なら章の始まりではない。
    const files = [{ ...slide('Section 1'), fileKey: 'a' }, { ...slide('Section 1'), fileKey: 'b', fileName: 'b.pdf' }];
    expect(breakCandidates(files)[1]).toEqual({ kind: 'file', title: 'b.pdf' });
    // スライドの頁ごとに違う見出しは、細かすぎるので使わない（大きさで分ける）。
    const many = Array.from({ length: 30 }, () => ({ role: 'body', bytes: MEGABYTE }));
    const headings = many.map((_, i) => (i > 0 ? { kind: 'heading', title: `${i}` } : null));
    expect(breakRanks(many, headings).every((rank) => rank === null)).toBe(true);
    expect(splitByRank(many, headings, { megabytes: 15, pages: null })).toEqual([15]);
  });

  it('ファイルの境目の頁にしおり・見出しもあれば、その名前も添える', () => {
    expect(breakReason({ kind: 'file', title: 'b.pdf', chapter: '第2章' })).toBe('ファイルの境目「b.pdf」（第2章）');
    expect(breakReason({ kind: 'heading', title: '第2章' })).toBe('見出し「第2章」');
  });
});
