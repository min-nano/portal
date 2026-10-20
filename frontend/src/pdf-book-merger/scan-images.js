// スキャンの頁の画像を、ブラウザ自身の JPEG の展開で描く。
//
// スキャナが作る PDF の頁は、たいてい「頁いっぱいの JPEG 画像 1 枚（と、
// サーチャブル PDF なら透明な文字情報）」でできている。pdf.js で描くと、
// WebKit（Safari と iPhone・iPad のブラウザ）では JPEG を JavaScript で展開する
// ことになり（pdf-source.js の openPdf）、数百万画素の頁ごとに時間がかかる。
//
// そこで、頁がその形をしているときは、JPEG のバイト列をそのまま取り出して
// ブラウザに展開させ（createImageBitmap。画面とは別のところで、ネイティブに
// 展開する）、頁の中の置き場所どおりに canvas へ描く。形が違う頁（図形や
// 文字を描いている・画像が 2 枚以上・JPEG でない など）は、これまでどおり
// pdf.js で描く。どちらで描いても、頁の向き・位置は pdf.js の viewport に揃える。
//
// 頁の中身は pdf-lib で読む（結合にも使っているもの）。

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { multiply } from './text-layer.js';

// --- 頁の中身の命令を読む ------------------------------------------------------

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/**
 * 頁の中身の命令を、[オペランド…, 命令] の並びに切り分ける。
 *
 * 要るのは数と名前だけなので、文字列・配列・辞書は「何かがあった」ことだけを
 * 残す（null）。インライン画像（BI … ID … EI）が出てきたら、そこで止める。
 *
 * @param {Uint8Array} bytes
 * @returns {Generator<{op:string, operands:(number|string|null)[]}>}
 */
export function* operations(bytes) {
  let operands = [];
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const c = bytes[i];
    if (WHITESPACE.has(c)) {
      i++;
    } else if (c === 0x25) {
      // % から行の終わりまでは注釈。
      while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
    } else if (c === 0x28) {
      // ( 文字列 )。入れ子の括弧と \ の逃がしを数える。
      let depth = 0;
      for (; i < n; i++) {
        if (bytes[i] === 0x5c) i++;
        else if (bytes[i] === 0x28) depth++;
        else if (bytes[i] === 0x29 && --depth === 0) break;
      }
      i++;
      operands.push(null);
    } else if (c === 0x3c && bytes[i + 1] === 0x3c) {
      // << 辞書 >>（印の付いた内容の属性）。入れ子を数えて読み飛ばす。
      let depth = 0;
      for (; i < n; i++) {
        if (bytes[i] === 0x3c && bytes[i + 1] === 0x3c) {
          depth++;
          i++;
        } else if (bytes[i] === 0x3e && bytes[i + 1] === 0x3e) {
          i++;
          if (--depth === 0) break;
        } else if (bytes[i] === 0x28) {
          // 辞書の中の文字列に > が入っていることがある。
          let inner = 0;
          for (; i < n; i++) {
            if (bytes[i] === 0x5c) i++;
            else if (bytes[i] === 0x28) inner++;
            else if (bytes[i] === 0x29 && --inner === 0) break;
          }
        }
      }
      i++;
      operands.push(null);
    } else if (c === 0x3c) {
      // < 16 進の文字列 >
      while (i < n && bytes[i] !== 0x3e) i++;
      i++;
      operands.push(null);
    } else if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x3e) {
      // 配列の括弧は、中の要素ごとオペランドとして積むだけでよい（数は使わない）。
      i++;
      operands.push(null);
    } else if (c === 0x2f) {
      let j = i + 1;
      while (j < n && !WHITESPACE.has(bytes[j]) && !DELIMITERS.has(bytes[j])) j++;
      operands.push(`/${latin1(bytes, i + 1, j)}`);
      i = j;
    } else {
      let j = i;
      while (j < n && !WHITESPACE.has(bytes[j]) && !DELIMITERS.has(bytes[j])) j++;
      if (j === i) j++; // 対応の無い ) など。1 文字読み飛ばす。
      const word = latin1(bytes, i, j);
      i = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
        operands.push(Number(word));
      } else if (word === 'true' || word === 'false' || word === 'null') {
        operands.push(null);
      } else {
        yield { op: word, operands };
        if (word === 'BI') return;
        operands = [];
      }
    }
  }
}

function latin1(bytes, start, end) {
  let text = '';
  for (let k = start; k < end; k++) text += String.fromCharCode(bytes[k]);
  return text;
}

// 描かない命令（状態・色・文字・印・切り抜きの道筋）。これら以外——図形を塗る・
// 線を引く・インライン画像など——が 1 つでもあれば、画像 1 枚だけの頁ではない。
// 文字を描く命令は通す（スキャンの文字情報は透明で、描かれない）。
const HARMLESS = new Set(
  (
    'q Q cm w J j M d ri i gs ' +
    'CS cs SC SCN sc scn G g RG rg K k ' +
    'BT ET Tc Tw Tz TL Tf Tr Ts Td TD Tm T* Tj TJ \' " d0 d1 ' +
    'MP DP BMC BDC EMC BX EX ' +
    'm l c v y h re W W* n'
  ).split(' ')
);

/**
 * 頁の中身が「画像を 1 枚描くだけ」なら、その画像の名前と、画像を置く変換
 * （画像の単位正方形 → 頁の座標）を返す。違えば null。
 *
 * @param {Uint8Array} content 展開した頁の中身
 * @returns {{name:string, matrix:number[]} | null}
 */
export function singleImageDraw(content) {
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let found = null;
  for (const { op, operands } of operations(content)) {
    if (op === 'Do') {
      if (found) return null;
      const name = operands.at(-1);
      if (typeof name !== 'string') return null;
      found = { name: name.slice(1), matrix: ctm };
    } else if (!HARMLESS.has(op)) {
      return null;
    } else if (op === 'q') {
      stack.push(ctm);
    } else if (op === 'Q') {
      ctm = stack.pop() ?? ctm;
    } else if (op === 'cm') {
      const m = operands.slice(-6);
      if (m.length !== 6 || m.some((v) => typeof v !== 'number')) return null;
      ctm = multiply(ctm, m);
    }
  }
  return found;
}

// --- 画像が JPEG のままブラウザに渡せるか ----------------------------------------

const PLAIN_SPACES = new Set(['DeviceGray', 'DeviceRGB', 'CalGray', 'CalRGB']);

function nameOf(value) {
  return value instanceof PDFName ? value.decodeText() : null;
}

function plainColorSpace(context, value) {
  const space = context.lookup(value);
  if (space instanceof PDFName) return PLAIN_SPACES.has(nameOf(space));
  if (!(space instanceof PDFArray) || space.size() < 1) return false;
  const family = nameOf(space.lookup(0));
  if (family === 'CalGray' || family === 'CalRGB') return true;
  if (family !== 'ICCBased') return false;
  // ICC は成分の数だけ見る（灰色か RGB なら、ブラウザの展開と同じ色になる）。
  const profile = space.lookup(1);
  const components = profile?.dict?.lookup(PDFName.of('N'));
  return components instanceof PDFNumber && [1, 3].includes(components.asNumber());
}

/**
 * XObject が、手を加えずにブラウザで展開できる JPEG の画像か。
 *
 * 色の変換（CMYK・索引色）・透明・反転の指定があるものは、ブラウザの展開と
 * pdf.js の描き方で色が変わるので、pdf.js に任せる。
 */
export function isPlainJpeg(context, stream) {
  if (!(stream instanceof PDFRawStream)) return false;
  const dict = stream.dict;
  const get = (key) => dict.lookup(PDFName.of(key));
  if (nameOf(get('Subtype')) !== 'Image') return false;
  const filter = get('Filter');
  const filters = filter instanceof PDFArray ? filter.asArray().map((f) => nameOf(context.lookup(f))) : [nameOf(filter)];
  if (filters.length !== 1 || filters[0] !== 'DCTDecode') return false;
  if (get('DecodeParms') || get('SMask') || get('Mask') || get('ImageMask')) return false;
  const bits = get('BitsPerComponent');
  if (!(bits instanceof PDFNumber) || bits.asNumber() !== 8) return false;
  const decode = get('Decode');
  if (decode instanceof PDFArray) {
    const values = decode.asArray().map((v) => context.lookup(v)?.asNumber?.());
    if (values.some((v, k) => v !== k % 2)) return false;
  } else if (decode) {
    return false;
  }
  return plainColorSpace(context, dict.get(PDFName.of('ColorSpace')));
}

function contentBytes(node) {
  const contents = node.Contents();
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((ref) => node.context.lookup(ref))
      : contents
        ? [contents]
        : [];
  const parts = [];
  for (const stream of streams) {
    if (!(stream instanceof PDFRawStream)) return null;
    parts.push(decodePDFRawStream(stream).decode(), new Uint8Array([0x0a]));
  }
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  return all;
}

/**
 * 1 頁が「JPEG 画像 1 枚」の形なら、その画像を返す。違えば null。
 *
 * @param {import('pdf-lib').PDFPage} page
 * @returns {{jpeg:Uint8Array, width:number, height:number, matrix:number[]} | null}
 */
export function scanImageOf(page) {
  const { node } = page;
  const content = contentBytes(node);
  if (!content) return null;
  const draw = singleImageDraw(content);
  if (!draw) return null;
  const xobjects = node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  const stream = xobjects?.lookup(PDFName.of(draw.name));
  if (!isPlainJpeg(node.context, stream)) return null;
  const width = stream.dict.lookup(PDFName.of('Width'))?.asNumber?.();
  const height = stream.dict.lookup(PDFName.of('Height'))?.asNumber?.();
  if (!(width > 0 && height > 0)) return null;
  return { jpeg: stream.contents, width, height, matrix: draw.matrix };
}

/**
 * PDF の各頁の、JPEG のまま描ける画像を調べる。
 *
 * 読めない PDF（暗号化など）は、すべての頁を pdf.js で描く（空の配列を返す）。
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<({jpeg:Uint8Array, width:number, height:number, matrix:number[]} | null)[]>}
 */
export async function findScanImages(bytes) {
  let doc;
  try {
    // 数百頁の PDF でも画面を固めないよう、少しずつ読む。
    doc = await PDFDocument.load(bytes, { updateMetadata: false, objectsPerTick: 200 });
  } catch {
    return [];
  }
  return doc.getPages().map((page) => {
    try {
      return scanImageOf(page);
    } catch {
      return null;
    }
  });
}

// --- 描く ----------------------------------------------------------------------

/**
 * 画像の画素 → canvas の画素の変換。
 *
 * 画像は単位正方形に、左上を (0, 1) にして置かれる（PDF の決まり）。
 */
export function imageTransform(viewportTransform, scan, bitmapWidth, bitmapHeight) {
  const unit = [1 / bitmapWidth, 0, 0, -1 / bitmapHeight, 0, 1];
  return multiply(viewportTransform, multiply(scan.matrix, unit));
}

/** createImageBitmap に頼む大きさ（canvas に描くより細かい分は、展開のときに縮める）。 */
export function decodeSize(viewportTransform, scan) {
  const t = imageTransform(viewportTransform, scan, scan.width, scan.height);
  // 画像の 1 画素が、canvas の上で何画素ぶんの長さになるか（横・縦それぞれ）。
  const across = Math.hypot(t[0], t[1]);
  const down = Math.hypot(t[2], t[3]);
  return {
    width: Math.max(1, Math.min(scan.width, Math.ceil(scan.width * across))),
    height: Math.max(1, Math.min(scan.height, Math.ceil(scan.height * down))),
  };
}

async function decode(scan, size) {
  const blob = new Blob([scan.jpeg], { type: 'image/jpeg' });
  const options = {};
  if (size.width < scan.width || size.height < scan.height) {
    Object.assign(options, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'medium' });
  }
  // PDF の中の JPEG は、EXIF の向きの指定を無視して描く決まり。
  try {
    return await createImageBitmap(blob, { ...options, imageOrientation: 'none' });
  } catch (error) {
    // 'none' を知らない古いブラウザ。
    if (error?.name !== 'TypeError') throw error;
    return createImageBitmap(blob, options);
  }
}

/**
 * スキャンの画像を、viewport ごとの canvas に描く（展開は 1 回）。
 *
 * @param {{jpeg:Uint8Array, width:number, height:number, matrix:number[]}} scan
 * @param {{transform:number[], width:number, height:number}[]} viewports
 *   pdf.js の page.getViewport() の結果（帯を描くときは offsetY 付き）
 * @param {({width:number, height:number}|undefined)[]} [canvasSizes]
 *   canvas の大きさ（既定は viewport の大きさ）
 * @returns {Promise<HTMLCanvasElement[]>}
 */
export async function drawScan(scan, viewports, canvasSizes = []) {
  // いちばん細かく描く viewport に足りる大きさで展開する。
  const sizes = viewports.map((viewport) => decodeSize(viewport.transform, scan));
  const size = {
    width: Math.max(...sizes.map((s) => s.width)),
    height: Math.max(...sizes.map((s) => s.height)),
  };
  const bitmap = await decode(scan, size);
  try {
    return viewports.map((viewport, k) => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(canvasSizes[k]?.width ?? viewport.width));
      canvas.height = Math.max(1, Math.round(canvasSizes[k]?.height ?? viewport.height));
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingQuality = 'high';
      context.setTransform(...imageTransform(viewport.transform, scan, bitmap.width, bitmap.height));
      context.drawImage(bitmap, 0, 0);
      context.setTransform(1, 0, 0, 1, 0, 0);
      return canvas;
    });
  } finally {
    bitmap.close?.();
  }
}
