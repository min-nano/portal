import { describe, expect, it } from 'vitest';
import { FEATURE_VERSION, ITEM_FIELDS, pageFeatures, pageLayout, rawItems } from '../src/pdf-book-merger/features.js';
import { breakCandidates, breakRanks } from '../src/pdf-book-merger/split.js';

const line = (text, { x0 = 0.1, x1 = 0.9, y = 0.5, h = 0.01 } = {}) => ({ text, x0, x1, y, h });

describe('pageLayout（頁のレイアウトの特徴）', () => {
  it('行の数・字の数・いちばん大きな字の行（大きさの比・高さ・真ん中にあるか・文字）', () => {
    const lines = [
      line('第2章', { x0: 0.4, x1: 0.6, y: 0.3, h: 0.04 }),
      line('本文の 行です', { y: 0.5 }),
      line('本文の行です', { y: 0.55 }),
    ];
    expect(pageLayout(lines)).toEqual({
      lines: 3,
      chars: 15,
      scale: 4,
      height: 0.04,
      median: 0.01,
      largestY: 0.3,
      centered: true,
      largest: '第2章',
    });
    // 左に寄った大きな字は、真ん中ではない。
    expect(pageLayout([line('第2章', { x0: 0.05, x1: 0.2, h: 0.04 }), line('本文')]).centered).toBe(false);
    // 大きな字の行が下の方にあっても拾う。
    expect(pageLayout([line('本文'), line('第3章', { y: 0.7, h: 0.03 })]).largest).toBe('第3章');
  });

  it('行が無ければ（白紙・画像だけの頁）、空の特徴', () => {
    expect(pageLayout([])).toEqual({ lines: 0, chars: 0, scale: 0, height: 0, median: 0, largestY: null, centered: false, largest: '' });
    // 高さの分からない行だけなら、大きさの比は 0。
    expect(pageLayout([line('・', { h: 0 })]).scale).toBe(0);
  });
});

describe('rawItems（あとから特徴を求め直すために残す頁の文字のかたまり）', () => {
  it('かたまりごとに [文字, x0, x1, y, h]（OCR なら後ろに確信度）の並びにし、頁ごとに 1 つの文字列にする', () => {
    const items = [
      { text: '第2 章 22.5(2) 棟違い', x0: 0.123456, x1: 0.9, y: 0.03, h: 0.012345 }, // 読み違いもそのまま
      { text: '本文の行です。', x0: 0.1, x1: 0.9, y: 0.5, h: 0.01 },
    ];
    expect(JSON.parse(rawItems(items))).toEqual([
      ['第2 章 22.5(2) 棟違い', 0.1235, 0.9, 0.03, 0.0123],
      ['本文の行です。', 0.1, 0.9, 0.5, 0.01],
    ]);
    expect(JSON.parse(rawItems([{ text: '5', confidence: 91, x0: 0.48, x1: 0.52, y: 0.95, h: 0.012 }]))).toEqual([
      ['5', 0.48, 0.52, 0.95, 0.012, 91],
    ]);
    expect(ITEM_FIELDS).toEqual(['text', 'x0', 'x1', 'y', 'h']);
  });
});

describe('pageFeatures（頁ごとの特徴）', () => {
  const page = (extra = {}) => ({ fileKey: 'a', fileName: 'a.pdf', role: 'body', bytes: 100, ...extra });

  it('手掛かり（見出し・目次・柱・頁番号）とレイアウト・大きさを数にする', () => {
    const blank = pageLayout([]);
    const text = pageLayout([line('本文の行です。本文の行です。')]);
    const items = [
      page({ role: 'front', layout: text }),
      page({ number: 1, layout: text, running: '第1章 材料' }),
      page({ number: 2, layout: text, running: '第1章 材料' }),
      page({ layout: blank, bytes: 10 }),
      page({ fileKey: 'b', number: 1, heading: '第2部 各論', toc: '第2部 各論', outline: '第2部', layout: text, bytes: 300 }),
      page({ fileKey: 'b', number: 2, running: '第2章 施工' }),
      page({ fileKey: 'b', number: 3, running: '第2章 施工', heading: 'Section 1' }),
      page({ fileKey: 'b', number: 4, heading: '第3章 床' }),
    ];
    const candidates = breakCandidates(items);
    const features = pageFeatures(items, candidates, breakRanks(items, candidates));
    expect(FEATURE_VERSION).toBe(5);
    expect(features[0]).toMatchObject({ position: 0, body: 0, candidate: 0, rank: 6, numbered: 0, step: 0, blank: 0, bytesBefore: 0 });
    expect(features[3]).toMatchObject({ blank: 1, bytes: 0.1 });
    expect(features[4]).toMatchObject({
      fileStart: 1,
      outline: 1,
      heading: 3,
      toc: 1,
      restart: 1,
      // 柱の章の変わり目は、柱の無い見出しの頁まで戻る。
      running: 3,
      candidate: 1,
      step: -1,
      blankBefore: 1,
      bytes: 3,
      bytesBefore: 0.1,
    });
    expect(features[5]).toMatchObject({ running: 0, step: 1, lines: 0, largestY: 1 });
    expect(features[6].heading).toBe(1);
    // 本文の始まり（前付けの 0 以下の番号のあと）。
    const opening = [page({ number: 0 }), page({ number: 1 })];
    const found = breakCandidates(opening);
    expect(pageFeatures(opening, found, breakRanks(opening, found))[1].opening).toBe(1);
    expect(features[7]).toMatchObject({ heading: 2, position: 1 });
  });

  it('1 頁だけの本でも求められる', () => {
    expect(pageFeatures([page()], [null], [null])[0]).toMatchObject({ position: 0, bytes: 1 });
    // 大きさの分からない頁だけでも割らない。
    expect(pageFeatures([page({ bytes: 0 })], [null], [null])[0].bytes).toBe(0);
  });
});
