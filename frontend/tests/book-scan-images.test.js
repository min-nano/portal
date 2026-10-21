// @vitest-environment jsdom
//
// 書籍スキャン PDF 結合ツール: スキャンの頁の JPEG を、ブラウザに展開させて
// 描く（scan-images.js）。
//
//   - 頁の中身が JPEG 画像（と下地・透明な文字）だけのとき、その JPEG を取り出す
//     （フォームに入れた画像・帯に分けた何枚かの画像も）。画像の上に図形を描く・
//     JPEG でない・色の変換が要る、は pdf.js に任せ、その理由と頁の作りを返す
//   - 頁の中身の命令の切り分け（文字列・辞書・注釈・インライン画像）
//   - 画像を置く変換を、pdf.js の viewport と合わせて canvas の変換にする
//   - 展開は 1 回で、要る大きさに縮めて頼む

import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, StandardFonts } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeSize,
  drawScan,
  findScanImages,
  imageTransform,
  inflate,
  inspectPage,
  operations,
} from '../src/pdf-book-merger/scan-images.js';

// 8×6 の白い JPEG（灰色と CMYK）。
const GRAY_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/wAALCAAGAAgBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APQK/9k=';
const CMYK_JPEG = '/9j/7gAOQWRvYmUAZAAAAAAA/9sAQwAQCwwODAoQDg0OEhEQExgoGhgWFhgxIyUdKDozPTw5Mzg3QEhcTkBEV0U3OFBtUVdfYmdoZz5NcXlwZHhcZWdj/8AAFAgABgAIBEMRAE0RAFkRAEsRAP/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAA4EQwBNAFkASwAAPwD0CvQK9Ar0Cv/Z';

const bytesOf = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const encode = (text) => new TextEncoder().encode(text);

/** 1 頁の PDF を作り、pdf-lib で読み直した頁を返す。 */
async function onePage(draw) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 600]);
  await draw(doc, page);
  const loaded = await PDFDocument.load(await doc.save());
  return loaded.getPage(0);
}

describe('頁の中身の命令を切り分ける', () => {
  it('数と名前をオペランドにし、文字列・配列・辞書は「何か」として残す', () => {
    const ops = [
      ...operations(
        encode('% 注釈 1 0 0 1 0 0 cm\n q 2 0 0 -3.5 .5 +1 cm /Im0 Do Q BT (a\\) (b) c) Tj [<00ff> -12 (x)] TJ ET /Span <</ActualText (>>) /K [1]>> BDC EMC')
      ),
    ];
    expect(ops.map((o) => o.op)).toEqual(['q', 'cm', 'Do', 'Q', 'BT', 'Tj', 'TJ', 'ET', 'BDC', 'EMC']);
    expect(ops[1].operands).toEqual([2, 0, 0, -3.5, 0.5, 1]);
    expect(ops[2].operands).toEqual(['/Im0']);
    expect(ops[5].operands).toEqual([null]);
    expect(ops[8].operands).toEqual(['/Span', null]);
  });

  it('インライン画像が出てきたら、そこで止める（中身は読まない）', () => {
    const ops = [...operations(encode('q BI /W 1 /H 1 ID \x00\xff EI Q'))].map((o) => o.op);
    expect(ops).toEqual(['q', 'BI']);
  });
});

describe('頁から JPEG を取り出す', () => {
  const FULL = { x: 0, y: 0, width: 400, height: 600 };

  it('JPEG 1 枚を置いた頁（文字情報つき）なら、元の JPEG のバイト列と置き場所を返す', async () => {
    const jpeg = bytesOf(GRAY_JPEG);
    const page = await onePage(async (doc, page) => {
      page.drawImage(await doc.embedJpg(jpeg), FULL);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText('searchable text', { x: 20, y: 20, size: 9, font });
    });

    const { scan, reason, outline } = inspectPage(page);
    expect(reason).toBeNull();
    expect(scan.images).toHaveLength(1);
    const [image] = scan.images;
    expect(image.jpeg).toEqual(jpeg);
    expect([image.width, image.height]).toEqual([8, 6]);
    expect(image.matrix).toEqual([400, 0, 0, 600, 0, 0]);
    expect(outline).toBe('画像 1 枚（DCTDecode 8×6 DeviceGray 8bit）');
  });

  it('Flate で包んだ JPEG（スキャナがよく作る形）も、包んだまま取り出す', async () => {
    const jpeg = bytesOf(GRAY_JPEG);
    const page = await onePage(async (doc, page) => {
      page.drawImage(await doc.embedJpg(jpeg), FULL);
    });
    const { context } = page.node;
    const [, ref] = page.node.Resources().lookup(PDFName.of('XObject')).entries()[0];
    const dict = context.lookup(ref).dict.clone(context);
    const wrapped = deflateSync(jpeg);
    dict.set(PDFName.of('Filter'), context.obj(['FlateDecode', 'DCTDecode']));
    dict.set(PDFName.of('Length'), PDFNumber.of(wrapped.length));
    context.assign(ref, PDFRawStream.of(dict, wrapped));

    const { scan, reason, outline } = inspectPage(page);
    expect(reason).toBeNull();
    expect(outline).toBe('画像 1 枚（FlateDecode+DCTDecode 8×6 DeviceGray 8bit）');
    expect(scan.images[0]).toMatchObject({ flate: true, width: 8, height: 6 });
    expect(await inflate(scan.images[0].jpeg)).toEqual(jpeg);

    // 段ごとの「指定なし」は通す。Flate の先読み（Predictor）などの指定は pdf.js に任せる。
    dict.set(PDFName.of('DecodeParms'), context.obj([null, null]));
    expect(inspectPage(page).reason).toBeNull();
    dict.set(PDFName.of('DecodeParms'), context.obj([{ Predictor: 12 }, null]));
    expect(inspectPage(page).reason).toBe('展開の指定が付いた JPEG');
    dict.delete(PDFName.of('DecodeParms'));
    dict.set(PDFName.of('Filter'), context.obj(['ASCIIHexDecode', 'DCTDecode']));
    expect(inspectPage(page).reason).toBe('JPEG でない画像（ASCIIHexDecode+DCTDecode）');
    dict.set(PDFName.of('Filter'), context.obj(['DCTDecode', 'FlateDecode']));
    expect(inspectPage(page).reason).toBe('JPEG でない画像（DCTDecode+FlateDecode）');
  });

  it('画像より前に塗る下地は通す。画像の上に図形を描く頁は、pdf.js に任せる', async () => {
    const under = await onePage(async (doc, page) => {
      page.drawRectangle({ ...FULL, color: { type: 'RGB', red: 1, green: 1, blue: 1 } });
      page.drawImage(await doc.embedJpg(bytesOf(GRAY_JPEG)), FULL);
    });
    expect(inspectPage(under).reason).toBeNull();
    expect(inspectPage(under).outline).toContain('下地の塗り 1');

    const over = await onePage(async (doc, page) => {
      page.drawImage(await doc.embedJpg(bytesOf(GRAY_JPEG)), FULL);
      page.drawRectangle({ x: 10, y: 10, width: 20, height: 20 });
    });
    expect(inspectPage(over)).toMatchObject({ scan: null, reason: '画像の上に図形を描いている' });
  });

  it('帯に分けて置いた何枚かの画像は、それぞれの置き場所で描く', async () => {
    const page = await onePage(async (doc, page) => {
      const image = await doc.embedJpg(bytesOf(GRAY_JPEG));
      page.drawImage(image, { x: 0, y: 300, width: 400, height: 300 });
      page.drawImage(image, { x: 0, y: 0, width: 400, height: 300 });
    });
    const { scan } = inspectPage(page);
    expect(scan.images.map((image) => image.matrix)).toEqual([
      [400, 0, 0, 300, 0, 300],
      [400, 0, 0, 300, 0, 0],
    ]);
  });

  it('フォームに入れた画像も、フォームの座標を重ねて取り出す', async () => {
    const source = await PDFDocument.create();
    source.addPage([400, 600]).drawImage(await source.embedJpg(bytesOf(GRAY_JPEG)), FULL);
    const page = await onePage(async (doc, page) => {
      const [embedded] = await doc.embedPdf(await source.save());
      // 頁の半分の大きさに縮めて、右上に置く。
      page.drawPage(embedded, { x: 200, y: 300, xScale: 0.5, yScale: 0.5 });
    });

    const { scan, reason, outline } = inspectPage(page);
    expect(reason).toBeNull();
    expect(scan.images[0].matrix).toEqual([200, 0, 0, 300, 200, 300]);
    expect(outline).toContain('フォーム 1');
  });

  it('CMYK の JPEG（色の変換と反転が要る）は、pdf.js に任せる', async () => {
    const page = await onePage(async (doc, page) => {
      page.drawImage(await doc.embedJpg(bytesOf(CMYK_JPEG)), FULL);
    });
    const { scan, reason, outline } = inspectPage(page);
    expect(scan).toBeNull();
    expect(reason).toBe('色を反転して描く画像');
    expect(outline).toContain('DeviceCMYK');
  });

  it('JPEG でない画像・反転や透明の指定がある画像は、理由を添えて pdf.js に任せる', async () => {
    const png = await onePage(async (doc, page) => {
      // 1×1 の PNG（Flate で圧縮した画像になる）。
      const bytes = bytesOf('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAWB5hKAAAAABJRU5ErkJggg==');
      page.drawImage(await doc.embedPng(bytes), FULL);
    });
    expect(inspectPage(png)).toMatchObject({ scan: null, reason: 'JPEG でない画像（FlateDecode）' });
    expect(inspectPage(png).outline).toContain('FlateDecode 1×1');

    const page = await onePage(async (doc, page) => {
      page.drawImage(await doc.embedJpg(bytesOf(GRAY_JPEG)), FULL);
    });
    const xobjects = page.node.Resources().lookup(PDFName.of('XObject'));
    const [, ref] = xobjects.entries()[0];
    const dict = page.node.context.lookup(ref).dict;
    const reasonWith = (key, value) => {
      dict.set(PDFName.of(key), value);
      const { reason } = inspectPage(page);
      dict.delete(PDFName.of(key));
      return reason;
    };
    expect(reasonWith('Decode', page.node.context.obj([1, 0]))).toBe('色を反転して描く画像');
    expect(reasonWith('Decode', page.node.context.obj([0, 1]))).toBeNull();
    expect(reasonWith('SMask', page.node.context.obj([]))).toBe('透明・マスクの付いた画像');
    expect(reasonWith('DecodeParms', page.node.context.obj({}))).toBe('展開の指定が付いた JPEG');
    dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(1));
    expect(inspectPage(page).reason).toBe('1bit の画像');
  });

  it('PDF の全頁を調べ、描けない頁の理由ごとの数と、最初の頁の作りを返す', async () => {
    const doc = await PDFDocument.create();
    const image = await doc.embedJpg(bytesOf(GRAY_JPEG));
    doc.addPage([100, 100]).drawImage(image, { x: 0, y: 0, width: 100, height: 100 });
    doc.addPage([100, 100]).drawRectangle({ x: 0, y: 0, width: 5, height: 5 });
    doc.addPage([100, 100]);

    const { scans, reasons, example } = await findScanImages(await doc.save());
    expect(scans.map((scan) => (scan ? 'jpeg' : null))).toEqual(['jpeg', null, null]);
    expect([...reasons]).toEqual([['画像が無い', 2]]);
    expect(example).toBe('2 頁目: 画像 0 枚・下地の塗り 1');

    const broken = await findScanImages(encode('not a pdf'));
    expect(broken.scans).toEqual([]);
    expect([...broken.reasons.keys()][0]).toMatch(/^PDF を読めない/);
  });
});

describe('canvas に描く', () => {
  // pdf.js の viewport（scale 2・回転なし）: 頁の座標 → canvas の画素。
  const viewport = { width: 800, height: 1200, transform: [2, 0, 0, -2, 0, 1200] };
  // 頁いっぱいに置いた 4000×6000 の画像。
  const image = { jpeg: new Uint8Array([1]), width: 4000, height: 6000, matrix: [400, 0, 0, 600, 0, 0] };
  const scan = { images: [image] };

  it('画像の左上が canvas の左上に、右下が右下に来る', () => {
    const t = imageTransform(viewport.transform, image, 4000, 6000);
    const at = (x, y) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
    expect(at(0, 0)).toEqual([0, 0]);
    expect(at(4000, 6000)).toEqual([800, 1200]);
  });

  it('90° 回して置いた画像も、向きを保って描く', () => {
    // 画像の横を頁の縦に置く（スキャナが横向きで保存した頁）。
    const turned = { ...image, width: 6000, height: 4000, matrix: [0, 600, -400, 0, 400, 0] };
    const t = imageTransform(viewport.transform, turned, 6000, 4000);
    const at = (x, y) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]].map((v) => Math.round(v) + 0);
    // 画像の左上は頁の左下に、画像の横は頁の下から上へ向かう。
    expect(at(0, 0)).toEqual([0, 1200]);
    expect(at(6000, 0)).toEqual([0, 0]);
    expect(at(6000, 4000)).toEqual([800, 0]);
    expect(decodeSize(viewport.transform, turned)).toEqual({ width: 1200, height: 800 });
  });

  it('canvas より細かい分は、展開するときに縮める（縮めすぎない）', () => {
    expect(decodeSize(viewport.transform, image)).toEqual({ width: 800, height: 1200 });
    const big = { width: 8000, height: 12000, transform: [20, 0, 0, -20, 0, 12000] };
    expect(decodeSize(big.transform, image)).toEqual({ width: 4000, height: 6000 });
  });

  describe('展開と描画', () => {
    const calls = [];
    const original = HTMLCanvasElement.prototype.getContext;

    function fakeBitmaps(implementation) {
      const close = vi.fn();
      globalThis.createImageBitmap = vi.fn(async (blob, options) => {
        await implementation?.(options);
        return { width: options.resizeWidth ?? 4000, height: options.resizeHeight ?? 6000, close };
      });
      HTMLCanvasElement.prototype.getContext = function getContext() {
        const canvas = this;
        return {
          fillRect: (...args) => calls.push(['fillRect', canvas.width, canvas.height, ...args]),
          setTransform: (...args) => calls.push(['setTransform', ...args]),
          drawImage: (bitmap, x, y) => calls.push(['drawImage', bitmap.width, bitmap.height, x, y]),
        };
      };
      return close;
    }

    afterEach(() => {
      calls.length = 0;
      delete globalThis.createImageBitmap;
      HTMLCanvasElement.prototype.getContext = original;
    });

    it('1 回だけ展開し、viewport ごとの canvas に描いて、展開した画像を手放す', async () => {
      const close = fakeBitmaps();
      const strip = { width: 800, height: 1200, transform: [2, 0, 0, -2, 0, 168] };

      const canvases = await drawScan(scan, [viewport, strip], [undefined, { width: 800, height: 168 }]);

      expect(createImageBitmap).toHaveBeenCalledTimes(1);
      const [blob, options] = createImageBitmap.mock.calls[0];
      expect(blob.type).toBe('image/jpeg');
      // 要る大きさ（800×1200）の 2 倍で、粗く縮めて展開する（canvas で丁寧に縮める）。
      expect(options).toEqual({ resizeWidth: 1600, resizeHeight: 2400, resizeQuality: 'low', imageOrientation: 'none' });
      expect(canvases.map((c) => [c.width, c.height])).toEqual([
        [800, 1200],
        [800, 168],
      ]);
      expect(calls.filter(([name]) => name === 'setTransform')[0]).toEqual(['setTransform', 0.5, 0, 0, 0.5, 0, 0]);
      expect(calls.filter(([name]) => name === 'drawImage')).toEqual([
        ['drawImage', 1600, 2400, 0, 0],
        ['drawImage', 1600, 2400, 0, 0],
      ]);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('細かく描く帯があれば、それに足りる大きさで展開する（元の大きさは超えない）', async () => {
      fakeBitmaps();
      // OCR の帯は、測る画像の 2.4 倍の細かさで描く。
      const strip = { width: 1920, height: 2880, transform: [4.8, 0, 0, -4.8, 0, 403] };

      await drawScan(scan, [viewport, strip], [undefined, { width: 1920, height: 403 }]);
      expect(createImageBitmap.mock.calls[0][1]).toMatchObject({ resizeWidth: 1920, resizeHeight: 2880 });

      createImageBitmap.mockClear();
      const fine = { width: 8000, height: 12000, transform: [20, 0, 0, -20, 0, 12000] };
      await drawScan(scan, [viewport, fine]);
      // 元の画像より細かくは展開しない（縮めずに展開する）。
      expect(createImageBitmap.mock.calls[0][1]).toEqual({ imageOrientation: 'none' });
    });

    it('何枚かの画像は、それぞれ展開して順に描く', async () => {
      fakeBitmaps();
      const top = { ...image, height: 3000, matrix: [400, 0, 0, 300, 0, 300] };
      const bottom = { ...image, height: 3000, matrix: [400, 0, 0, 300, 0, 0] };

      await drawScan({ images: [top, bottom] }, [viewport]);

      expect(createImageBitmap).toHaveBeenCalledTimes(2);
      const placed = calls.filter(([name]) => name === 'setTransform').slice(0, 2);
      // 上の帯は canvas の上半分（y = 0）から、下の帯は下半分（y = 600）から。
      expect(placed.map(([, , , , , , f]) => f)).toEqual([0, 600]);
    });

    it('imageOrientation を知らないブラウザでは、付けずに頼み直す', async () => {
      fakeBitmaps((options) => {
        if (options.imageOrientation) throw new TypeError('bad enum');
      });
      await drawScan(scan, [viewport]);
      expect(createImageBitmap).toHaveBeenCalledTimes(2);
    });

    it('Flate で包んだ JPEG は、開いてから展開させる', async () => {
      fakeBitmaps();
      const jpeg = bytesOf(GRAY_JPEG);
      await drawScan({ images: [{ ...image, jpeg: deflateSync(jpeg), flate: true }] }, [viewport]);

      const [blob] = createImageBitmap.mock.calls[0];
      expect(blob.type).toBe('image/jpeg');
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(jpeg);
    });

    it('展開できなければ、失敗を返す（呼んだ側が pdf.js で描く）', async () => {
      fakeBitmaps(() => {
        throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
      });
      await expect(drawScan(scan, [viewport])).rejects.toThrow('could not be decoded');
      expect(createImageBitmap).toHaveBeenCalledTimes(1);
    });
  });
});
