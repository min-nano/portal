// 書籍スキャン PDF 結合ツール: pdf.js に渡す、PDF の外のデータ（pdf-data.js）。
//
// Illustrator・InDesign で作ったカタログの PDF は、日本語のフォント（Adobe-Japan1、
// Identity-H）に ToUnicode を持たず、文字の番号を CMap で Unicode に引く前提に
// なっている。CMap を渡さないと、pdf.js はフォントを読めず、文字が描かれず、
// 文字情報（頁番号の読み取りと検証に使う）も空になる。ここでは、そういう
// フォントで書いた PDF を作り、画面と同じ pdf.js（Node 向けの legacy ビルド）で
// 文字情報を読めることを縛る。

import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BundledDataFactory, bundledUrl } from '../src/pdf-book-merger/pdf-data.js';

/**
 * Adobe-Japan1 の文字の番号（CID）で書いた 1 頁の PDF。フォントは埋め込まず、
 * ToUnicode も持たない（文字の意味は CMap だけが知っている）。
 */
async function makeJapan1Pdf(cids) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 100]);
  const { context } = doc;
  const descendant = context.obj({
    Type: 'Font',
    Subtype: 'CIDFontType0',
    BaseFont: 'KozGoPr6N-Regular',
    CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Japan1'), Supplement: 6 },
    FontDescriptor: context.register(
      context.obj({
        Type: 'FontDescriptor',
        FontName: 'KozGoPr6N-Regular',
        Flags: 4,
        FontBBox: [0, -120, 1000, 880],
        ItalicAngle: 0,
        Ascent: 880,
        Descent: -120,
        CapHeight: 760,
        StemV: 80,
      })
    ),
  });
  const font = context.register(
    context.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: 'KozGoPr6N-Regular-Identity-H',
      Encoding: 'Identity-H',
      DescendantFonts: [context.register(descendant)],
    })
  );
  page.node.setFontDictionary(PDFName.of('F1'), font);
  const hex = cids.map((cid) => cid.toString(16).padStart(4, '0')).join('');
  page.node.set(PDFName.of('Contents'), context.register(context.flateStream(`BT /F1 12 Tf 20 40 Td <${hex}> Tj ET`)));
  return doc.save();
}

async function readText(bytes, options = {}) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, ...options }).promise;
  try {
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    return content.items.map((item) => item.str).join('');
  } finally {
    await doc.loadingTask.destroy();
  }
}

// Adobe-Japan1 の CID: 18・19 が「1」「2」（頁番号）、843 が「あ」。
const CIDS = [18, 19, 843];

beforeEach(() => {
  // 同梱したファイルの URL（Vite が付けたもの）を、手元のファイルとして読む。
  vi.stubGlobal('fetch', async (url) => {
    const path = new URL(`..${url.split('?')[0]}`, import.meta.url);
    const body = await readFile(path);
    return new Response(body);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BundledDataFactory', () => {
  it('ToUnicode の無い Adobe-Japan1 のフォントの文字を、CMap で読める', async () => {
    const bytes = await makeJapan1Pdf(CIDS);

    // 渡さなければ読めない（このツールが以前そうだった）。
    expect(await readText(bytes)).not.toBe('12あ');
    expect(await readText(bytes, { BinaryDataFactory: BundledDataFactory })).toBe('12あ');
  });

  it('pdf.js が求めるファイルを同梱している', () => {
    expect(bundledUrl('cMapUrl', 'Adobe-Japan1-UCS2.bcmap')).toBeTruthy();
    expect(bundledUrl('cMapUrl', '90ms-RKSJ-H.bcmap')).toBeTruthy();
    expect(bundledUrl('standardFontDataUrl', 'FoxitSerif.pfb')).toBeTruthy();
    expect(bundledUrl('standardFontDataUrl', 'LiberationSans-Regular.ttf')).toBeTruthy();
    expect(bundledUrl('wasmUrl', 'openjpeg.wasm')).toBeTruthy();
    expect(bundledUrl('wasmUrl', 'jbig2.wasm')).toBeTruthy();
  });

  it('同梱していないファイルは、分かる言葉で失敗する', async () => {
    expect(bundledUrl('cMapUrl', 'LICENSE')).toBeNull();
    expect(bundledUrl('cMapUrl', 'constructor')).toBeNull();
    expect(bundledUrl('iccUrl', 'CGATS001Compat-v2-micro.icc')).toBeNull();
    await expect(new BundledDataFactory().fetch({ kind: 'cMapUrl', filename: 'Nope.bcmap' })).rejects.toThrow(
      '同梱していません'
    );
  });

  it('読めなければ、HTTP の状態を添えて失敗する', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));

    await expect(new BundledDataFactory().fetch({ kind: 'wasmUrl', filename: 'jbig2.wasm' })).rejects.toThrow('HTTP 404');
  });
});
