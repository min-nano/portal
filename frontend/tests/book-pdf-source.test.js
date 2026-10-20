// 書籍スキャン PDF 結合ツール: pdf.js を呼ぶ側の、ブラウザごとの手当て。
//
// Safari（と iPhone・iPad のすべてのブラウザ）では、pdf.js が worker の中で
// 画像を ImageDecoder・OffscreenCanvas で展開すると失敗することがあるので、
// その 2 つを切る。どのブラウザを WebKit とみなすかと、使い終えた canvas の
// 画素を手放すことを縛る。

import { describe, expect, it } from 'vitest';
import { cropTransform, isIOS, isWebKit, releaseCanvas } from '../src/pdf-book-merger/pdf-source.js';

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
