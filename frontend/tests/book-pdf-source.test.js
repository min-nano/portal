// PDF 結合ツール: pdf.js を呼ぶ側の、ブラウザごとの手当て。
//
// Safari（と iPhone・iPad のすべてのブラウザ）では、pdf.js が worker の中で
// 画像を ImageDecoder・OffscreenCanvas で展開すると失敗することがあるので、
// その 2 つを切る。どのブラウザを WebKit とみなすかと、使い終えた canvas の
// 画素を手放すことを縛る。

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { isIOS, isWebKit } from '../src/pdf-book-merger/device.js';
import { cropTransform, readPageText, releaseCanvas } from '../src/pdf-book-merger/pdf-source.js';
import { textSignature } from '../src/pdf-book-merger/text-layer.js';

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

describe('readPageText', () => {
  it('頁の大きさ・文字の位置・指紋と、文字情報をつなげたもの（行の終わりで改行）を返す', async () => {
    const source = await PDFDocument.create();
    const font = await source.embedFont(StandardFonts.Helvetica);
    const page = source.addPage([364, 515]);
    page.drawText('Body text', { x: 40, y: 300, size: 11, font });
    page.drawText('7', { x: 175, y: 20, size: 9, font });
    const bytes = await source.save();

    // pdf-source.js は、ビルドした worker の URL を渡している。Node では、
    // pdf.js の worker をこの場で動かす（fake worker）。
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
      resolve('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')
    ).href;
    const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
    try {
      const text = await readPageText(doc, 0);
      expect(text.size).toEqual({ width: 364, height: 515 });
      expect(text.items.map((item) => item.text)).toEqual(['Body text', '7']);
      expect(text.signature).toEqual(textSignature([{ str: 'Bodytext7' }]));
      expect(text.text.split('\n').map((line) => line.trim())).toEqual(['Body text', '7']);
    } finally {
      await doc.loadingTask.destroy();
    }
  });
});
