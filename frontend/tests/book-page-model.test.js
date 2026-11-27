import { describe, expect, it } from 'vitest';
import {
  argmax,
  featureVectors,
  FEATURE_NAMES,
  measurePages,
  numberingDepth,
  predictSoftmax,
  trainSoftmax,
} from '../src/pdf-book-merger/page-model.js';

describe('numberingDepth（番号らしい形の段の数。言葉は見ない）', () => {
  it('行の頭から 8 字までの数と、点・ハイフンで続く数を数える', () => {
    expect(numberingDepth('6.2.1 耐震計算ルート')).toBe(3);
    expect(numberingDepth('第6 章 保有水平耐力計算')).toBe(1);
    expect(numberingDepth('▼1−1−1 適用範囲')).toBe(3);
    expect(numberingDepth('６．２ 全角の番号')).toBe(2);
    expect(numberingDepth('Section 2 Walls')).toBe(1);
    expect(numberingDepth('1.2.3.4.5 深すぎる')).toBe(4);
    expect(numberingDepth('番号の無い本文の行です。')).toBe(0);
    expect(numberingDepth('とても長い言葉のあとの数 12')).toBe(0);
    // 本文の脇の行番号（5 の倍数）は除く。
    expect(numberingDepth('10 3. 1 基礎(令第38条)')).toBe(2);
    expect(numberingDepth('5 6.9.2 高さ方向')).toBe(3);
  });
});

describe('featureVectors（頁ごとの特徴）', () => {
  // 字のかたまり: [文字, x0, x1, y, h]
  const line = (text, y, h = 0.01, x0 = 0.1, x1 = 0.9) => [text, x0, x1, y, h];
  const body = Array.from({ length: 20 }, (_, k) => line('本文の行です。本文の行です。', 0.2 + k * 0.03));
  const pages = [
    { label: '前付(0) 頁', bytes: 100, items: [] },
    { label: '1 頁', bytes: 50, items: [line('保有水平耐力計算', 0.3, 0.03, 0.3, 0.7)] },
    { label: '2 頁', bytes: 200, items: [line('第6 章 構造計算 6.1 許容応力度', 0.04), line('6.1 許容応力度計算', 0.1, 0.014), ...body] },
    { label: '3 頁', bytes: 200, items: [line('第6 章 構造計算 6.1 許容応力度', 0.04), ...body] },
    { label: '1 頁', bytes: 200, items: [line('第6 章 構造計算 6.2 耐震計算', 0.04), line('6.2.1 耐震計算ルート', 0.1, 0.012), ...body] },
  ];

  it('特徴の名前の数だけの数を返し、白紙・扉・番号・柱の変わり目・頁番号の戻りを測る', () => {
    const rows = featureVectors(pages);
    expect(rows).toHaveLength(5);
    rows.forEach((row) => expect(row).toHaveLength(FEATURE_NAMES.length));
    const at = (row, name) => row[FEATURE_NAMES.indexOf(name)];
    expect(at(rows[0], 'blank')).toBe(1);
    expect(at(rows[0], 'front')).toBe(1);
    expect(at(rows[0], 'headEmpty')).toBe(1);
    expect(at(rows[0], 'prevBlank')).toBe(1);
    expect(at(rows[1], 'centered')).toBe(1);
    expect(at(rows[1], 'largest')).toBeGreaterThan(2);
    expect(at(rows[2], 'firstDepth2')).toBe(1);
    expect(at(rows[2], 'shallowest2')).toBe(1);
    expect(at(rows[2], 'headNumberNew')).toBe(1);
    expect(at(rows[3], 'headNumberNew')).toBe(0);
    expect(at(rows[3], 'headChange')).toBe(0);
    expect(at(rows[4], 'firstDepth3')).toBe(1);
    expect(at(rows[4], 'headNumberNew')).toBe(1);
    expect(at(rows[3], 'nextHeadNumberNew')).toBe(1);
    expect(at(rows[4], 'numberRestart')).toBe(1);
    expect(at(rows[4], 'nextFirstDepth')).toBe(0);
    expect(at(rows[2], 'firstDepth1')).toBe(0);
    expect(at(rows[2], 'shallowest1')).toBe(0);
    expect(at(rows[4], 'shallowest3')).toBe(1);
  });

  it('柱の文字が前の頁と違えば、柱の変わり目らしさが上がる（柱の無い頁は比べない）', () => {
    const head = (text) => ({ label: '1 頁', bytes: 1, items: [line(text, 0.04), ...body] });
    const rows = featureVectors([head('木造住宅 屋根'), { label: '2 頁', bytes: 1, items: body }, head('鉄骨造 外壁')]);
    expect(rows[2][FEATURE_NAMES.indexOf('headChange')]).toBe(1);
    expect(rows[0][FEATURE_NAMES.indexOf('headChange')]).toBe(0);
  });

  it('番号らしい行が何行かあれば、いちばん浅い段の行を見る', () => {
    const page = { label: '5 頁', bytes: 1, items: [line('6.2.1 耐震計算ルート', 0.1), line('6.3 鉄骨造', 0.5, 0.014), line('6.3.1 考え方', 0.6)] };
    expect(measurePages([page])[0]).toMatchObject({ shallowestDepth: 2, shallowestY: 0.5 });
  });

  it('頁番号の構造（版 5）があれば、頁番号・前付け・部と前の段の変わり目をそこから求める', () => {
    const numbered = (number, extra = {}) => ({
      label: 'ラベルは見ない',
      bytes: 1,
      items: body,
      numbering: { role: 'body', number, prefix: null, part: null, ...extra },
    });
    const rows = featureVectors([
      { ...numbered(null), numbering: { role: 'front', number: null, prefix: null, part: null } },
      numbered(1, { part: 0, prefix: [1] }),
      numbered(2),
      numbered(1, { part: 1, prefix: [2] }),
      numbered(2, { part: 1, prefix: [2] }),
    ]);
    const at = (row, name) => row[FEATURE_NAMES.indexOf(name)];
    expect(rows.map((row) => at(row, 'front'))).toEqual([1, 0, 0, 0, 0]);
    // 部・前の段の分からない頁（2 頁目）は飛ばして比べる。
    expect(rows.map((row) => at(row, 'partChange'))).toEqual([0, 0, 0, 1, 0]);
    expect(rows.map((row) => at(row, 'prefixChange'))).toEqual([0, 0, 0, 1, 0]);
    expect(rows.map((row) => at(row, 'numberRestart'))).toEqual([0, 0, 0, 1, 0]);
  });

  it('本の中の見出しの形の繰り返しから、見出しの段（字の大きい順、同じなら番号の段の浅い順）を推定する', () => {
    const at = (y, text, h = 0.01) => line(text, y, h);
    const bodyLines = (from) => Array.from({ length: 8 }, (_, k) => at(from + k * 0.03, '本文の行です。本文の行です。'));
    const pages = [
      { label: '1 頁', bytes: 1, items: [at(0.1, '第1章 総論', 0.03), at(0.2, '1.1 概要', 0.015), at(0.25, '(1) 手順'), at(0.28, '1.1.1 細目'), ...bodyLines(0.4)] },
      { label: '2 頁', bytes: 1, items: [at(0.1, '1.2 材料', 0.015), at(0.2, '(2) 手順'), at(0.25, '1.1.2 細目'), ...bodyLines(0.4)] },
      { label: '3 頁', bytes: 1, items: [at(0.1, '第2章 施工', 0.03), at(0.2, '2.1 下地', 0.015), ...bodyLines(0.4)] },
      { label: '4 頁', bytes: 1, items: [...bodyLines(0.1), at(0.5, '2.2 仕上げ', 0.015), at(0.6, '2.5 飛んだ番号', 0.015)] },
      // 目次の項目の形（頁番号で終わる行）は数えない。
      { label: '5 頁', bytes: 1, items: [at(0.1, '第9章 付録 …… 99', 0.03), ...bodyLines(0.4)] },
    ];
    const m = measurePages(pages);
    // 章（いちばん大きな字）が段 0、節が段 1。番号の続く「(1)」と「1.1.1」は字の大きさが同じなので、段の浅い「(1)」が上。
    expect(m.map((x) => x.bestLevel)).toEqual([0, 1, 0, 1, 5]);
    expect(m[0]).toMatchObject({ bestIsFirst: 1, bestInSequence: 1, firstLevel: 0, firstInSequence: 1, firstStyleSequential: 1 });
    expect(m[1]).toMatchObject({ firstLevel: 1, firstInSequence: 1, bestY: 0.1 });
    // 頁の頭が本文の行なら、最初の行の形は無い。飛んだ番号は順に進んでいない。
    expect(m[3]).toMatchObject({ firstLevel: 5, firstStyleCount: 0, firstStyleSequential: 0, bestIsFirst: 0, bestY: 0.5 });
    expect(m[3].bestInSequence).toBe(1);
    expect(m[4]).toMatchObject({ bestLevel: 5, bestY: 1, bestInSequence: 0 });
  });

  it('大きさの分からない頁・行の無い頁があっても測れる', () => {
    // 日本語だけの行も、最初の行として見る。
    const title = measurePages([{ label: '1 頁', bytes: 1, items: [line('保有水平耐力計算等の構造計算', 0.3, 0.03), line('6.1 許容', 0.5)] }]);
    expect(title[0]).toMatchObject({ firstY: 0.3, firstDepth: 0 });
    const measures = measurePages([{ label: '表紙', bytes: 0, items: [] }]);
    expect(measures[0]).toMatchObject({ blank: 1, largest: 0, firstDepth: 0, shallowestDepth: 0, front: 1, bytes: 0 });
  });
});

describe('trainSoftmax・predictSoftmax（多クラスのロジスティック回帰）', () => {
  it('分けられる例を学び、確からしさのいちばん高いクラスを当てる（無いクラスがあっても学べる）', () => {
    const rows = [
      [0, 0],
      [0, 1],
      [5, 0],
      [5, 1],
      [10, 0],
      [10, 1],
    ];
    const labels = [0, 0, 1, 1, 3, 3];
    const model = trainSoftmax(rows, labels, 4, { epochs: 300, rate: 1 });
    const probs = predictSoftmax(model, [[0, 0.5], [5, 0.5], [10, 0.5]]);
    expect(probs.map(argmax)).toEqual([0, 1, 3]);
    probs.forEach((p) => expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1));
    // ばらつきの無い特徴でも割らない。
    expect(model.scale[0]).toBeGreaterThan(0);
    expect(trainSoftmax([[1], [1]], [0, 1], 2, { epochs: 1 }).scale).toEqual([1]);
  });
});
