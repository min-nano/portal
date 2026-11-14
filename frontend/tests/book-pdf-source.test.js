// PDF 結合ツール: pdf.js を呼ぶ側の、ブラウザごとの手当て。
//
// Safari（と iPhone・iPad のすべてのブラウザ）では、pdf.js が worker の中で
// 画像を ImageDecoder・OffscreenCanvas で展開すると失敗することがあるので、
// その 2 つを切る。どのブラウザを WebKit とみなすかと、使い終えた canvas の
// 画素を手放すことを縛る。

import { describe, expect, it } from 'vitest';
import { isIOS, isWebKit } from '../src/pdf-book-merger/device.js';
import { cropTransform, readOutline, releaseCanvas } from '../src/pdf-book-merger/pdf-source.js';

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
};

describe('isWebKit', () => {
  it.each([
    ['iPhone の Safari', { userAgent: UA.iphoneSafari }, true],
    ['iPhone の Chrome（中身は WebKit）', { userAgent: UA.iphoneChrome }, true],
    ['iPad（Mac を名乗る）', { userAgent: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 5 }, true],
    ['Mac の Safari', { userAgent: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 0 }, true],
    ['Mac の Chrome', { userAgent: UA.macChrome, platform: 'MacIntel', maxTouchPoints: 0 }, false],
    ['Windows の Edge', { userAgent: UA.windowsEdge, platform: 'Win32' }, false],
    ['Firefox', { userAgent: UA.firefox, platform: 'Win32' }, false],
    ['分からない', undefined, false],
  ])('%s', (_, nav, expected) => {
    expect(isWebKit(nav)).toBe(expected);
  });
});

describe('isIOS', () => {
  it.each([
    ['iPhone の Safari', { userAgent: UA.iphoneSafari }, true],
    ['iPhone の Chrome', { userAgent: UA.iphoneChrome }, true],
    ['iPad（Mac を名乗る）', { userAgent: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 5 }, true],
    ['Mac の Safari', { userAgent: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 0 }, false],
    ['分からない', undefined, false],
  ])('%s', (_, nav, expected) => {
    expect(isIOS(nav)).toBe(expected);
  });
});

describe('releaseCanvas', () => {
  it('大きさを 0 にして画素を手放す', () => {
    const canvas = { width: 1000, height: 1400 };

    releaseCanvas(canvas);
    releaseCanvas(null);

    expect(canvas).toEqual({ width: 0, height: 0 });
  });
});

describe('cropTransform', () => {
  // 364×515pt の頁を、OCR の細かさ（scale 4）で 1 回だけ描いたもの。
  const full = { transform: [4, 0, 0, -4, 0, 2060] };
  const apply = (t, x, y) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]].map((v) => Math.round(v * 1000) / 1000 + 0);

  it('粗い viewport（測る画像）へは、縮めて写す', () => {
    const analysis = { transform: [2, 0, 0, -2, 0, 1030] };
    const t = cropTransform(analysis, full);
    expect(apply(t, 0, 0)).toEqual([0, 0]);
    expect(apply(t, 1456, 2060)).toEqual([728, 1030]);
  });

  it('下にずらした viewport（下の余白の帯）へは、その帯の分だけ切り出す', () => {
    // 頁の下 14% の帯（offsetY で上へずらしたもの）。
    const bottom = { transform: [4, 0, 0, -4, 0, 2060 - 0.86 * 2060] };
    const t = cropTransform(bottom, full);
    expect(apply(t, 0, 0.86 * 2060)).toEqual([0, 0]);
    expect(apply(t, 1456, 2060)).toEqual([1456, 288.4]);
  });
});

describe('readOutline', () => {
  /** pdf.js の文書の、しおりに関わるところだけの偽物。 */
  const doc = (outline, named = {}) => ({
    getOutline: async () => outline,
    getDestination: async (name) => named[name] ?? null,
    getPageIndex: async (ref) => {
      if (ref?.num === undefined) throw new Error('Invalid pageIndex request.');
      return ref.num - 100;
    },
  });

  it('いちばん上の段の項目が指す頁を、頁の位置ごとに返す（名前付きの行き先・頁の参照・頁の番号）', async () => {
    const titles = await readOutline(
      doc(
        [
          { title: ' はじめに　序 ', dest: [{ num: 100, gen: 0 }, { name: 'XYZ' }], items: [{ title: '1.1', dest: [5] }] },
          { title: '第1章', dest: 'chapter1' },
          { title: '第2章\r構造', dest: [12, { name: 'Fit' }] },
          { title: '同じ頁の 2 つ目', dest: [12] },
          { title: '', dest: [20] },
          { title: '行き先の無い項目', dest: null },
          { title: '名前の分からない行き先', dest: 'missing' },
          { title: '壊れた参照', dest: [{}] },
        ],
        { chapter1: [{ num: 104, gen: 0 }] }
      )
    );
    expect([...titles]).toEqual([
      [0, 'はじめに　序'],
      [4, '第1章'],
      [12, '第2章 構造'],
    ]);
  });

  it('書名 1 つの下に章が並ぶしおりは、その下の段を使う', async () => {
    const titles = await readOutline(
      doc([{ title: '吾輩は猫である', dest: [0], items: [{ title: '一', dest: [0] }, { title: '二', dest: [9] }] }])
    );
    expect([...titles]).toEqual([
      [0, '一'],
      [9, '二'],
    ]);
  });

  it('しおりが無い・読めない PDF は、空にする', async () => {
    expect((await readOutline(doc(null))).size).toBe(0);
    expect((await readOutline(doc([{ title: '書名だけ', dest: [0] }]))).size).toBe(1);
    const broken = { getOutline: () => Promise.reject(new Error('broken')) };
    expect((await readOutline(broken)).size).toBe(0);
  });
});
