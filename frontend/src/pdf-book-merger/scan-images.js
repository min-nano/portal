// スキャンの頁の画像を、ブラウザ自身の JPEG の展開で描く。
//
// スキャナが作る PDF の頁は、たいてい「頁いっぱいの JPEG 画像 1 枚（と、
// サーチャブル PDF なら透明な文字情報）」でできている。pdf.js で描くと、
// WebKit（Safari と iPhone・iPad のブラウザ）では JPEG を JavaScript で展開する
// ことになり（pdf-source.js の openPdf）、数百万画素の頁ごとに時間がかかる。
//
// そこで、頁が JPEG 画像（と下地・透明な文字）だけでできているときは、JPEG の
// バイト列をそのまま取り出してブラウザに展開させ（createImageBitmap。画面とは
// 別のところで、ネイティブに展開する）、頁の中の置き場所どおりに canvas へ描く。
// フォームに入れた画像や、帯に分けて置いた何枚かの画像も、この形として扱う。
// そうでない頁（画像の上に図形を描いている・JPEG でない・CMYK など）は、
// これまでどおり pdf.js で描き、その理由と頁の作りを記録に残す（スキャナの
// 作る PDF の形を知って、ここで扱える形を広げるため）。どちらで描いても、
// 頁の向き・位置は pdf.js の viewport に揃える。
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

// 描かない命令（状態・色・文字・印・切り抜きの道筋）。文字を描く命令は通す
// （スキャンの文字情報は透明で、描かれない）。
const HARMLESS = new Set(
  (
    'q Q cm w J j M d ri i gs ' +
    'CS cs SC SCN sc scn G g RG rg K k ' +
    'BT ET Tc Tw Tz TL Tf Tr Ts Td TD Tm T* Tj TJ \' " d0 d1 ' +
    'MP DP BMC BDC EMC BX EX ' +
    'm l c v y h re W W* n'
  ).split(' ')
);
// 図形を塗る・線を引く命令。画像より前なら下地（白い紙など）なので通すが、
// 画像の上に描くものがあれば、ブラウザの展開だけでは同じ見た目にならない。
const PAINT = new Set('f F f* B B* b b* S s sh'.split(' '));

/** フォーム（XObject の Form）を入れ子でたどる深さの上限。 */
const MAX_FORM_DEPTH = 4;
/** 1 頁に置く画像の数の上限（帯に分けて置くスキャナがある）。 */
const MAX_IMAGES = 32;

// --- 画像が JPEG のままブラウザに渡せるか ----------------------------------------

const PLAIN_SPACES = new Set(['DeviceGray', 'DeviceRGB', 'CalGray', 'CalRGB']);

function nameOf(value) {
  return value instanceof PDFName ? value.decodeText() : null;
}

function colorSpaceOf(context, value) {
  const space = context.lookup(value);
  if (space instanceof PDFName) return { name: nameOf(space), plain: PLAIN_SPACES.has(nameOf(space)) };
  if (!(space instanceof PDFArray) || space.size() < 1) return { name: '不明', plain: false };
  const family = nameOf(space.lookup(0));
  if (family === 'CalGray' || family === 'CalRGB') return { name: family, plain: true };
  if (family !== 'ICCBased') return { name: family || '不明', plain: false };
  // ICC は成分の数だけ見る（灰色か RGB なら、ブラウザの展開と同じ色になる）。
  const components = space.lookup(1)?.dict?.lookup(PDFName.of('N'))?.asNumber?.();
  return { name: `ICCBased(${components})`, plain: components === 1 || components === 3 };
}

/**
 * 画像の XObject を調べる。手を加えずにブラウザで展開できる JPEG なら
 * reason は null。色の変換（CMYK・索引色）・透明・反転の指定があるものは、
 * ブラウザの展開と pdf.js の描き方で見た目が変わるので、pdf.js に任せる。
 *
 * @returns {{reason:string|null, info:string, width:number, height:number}}
 *   info は記録に出す短い説明（圧縮の方式・大きさ・色）。
 */
export function inspectImage(context, stream) {
  const dict = stream.dict;
  const get = (key) => dict.lookup(PDFName.of(key));
  const filter = get('Filter');
  const filters = filter instanceof PDFArray ? filter.asArray().map((f) => nameOf(context.lookup(f))) : filter ? [nameOf(filter)] : [];
  const width = get('Width')?.asNumber?.() ?? 0;
  const height = get('Height')?.asNumber?.() ?? 0;
  const bits = get('BitsPerComponent')?.asNumber?.();
  const mask = Boolean(get('ImageMask')?.asBoolean?.());
  const space = mask ? { name: 'マスク', plain: false } : colorSpaceOf(context, dict.get(PDFName.of('ColorSpace')));
  const info = `${filters.join('+') || '無圧縮'} ${width}×${height} ${space.name}${bits ? ` ${bits}bit` : ''}`;
  const result = (reason) => ({ reason, info, width, height });

  if (!(stream instanceof PDFRawStream)) return result('画像を読めない');
  if (filters.length !== 1 || filters[0] !== 'DCTDecode') return result(`JPEG でない画像（${filters.join('+') || '無圧縮'}）`);
  if (mask) return result('マスクの画像');
  if (get('SMask') || get('Mask')) return result('透明・マスクの付いた画像');
  if (get('DecodeParms')) return result('展開の指定が付いた JPEG');
  if (bits !== 8) return result(`${bits ?? '?'}bit の画像`);
  const decode = get('Decode');
  if (decode instanceof PDFArray) {
    const values = decode.asArray().map((v) => context.lookup(v)?.asNumber?.());
    if (values.some((v, k) => v !== k % 2)) return result('色を反転して描く画像');
  } else if (decode) {
    return result('色を反転して描く画像');
  }
  if (!space.plain) return result(`色の変換が要る画像（${space.name}）`);
  if (!(width > 0 && height > 0)) return result('大きさの分からない画像');
  return result(null);
}

function decodedBytes(streams) {
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

function contentBytes(node) {
  const contents = node.Contents();
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((ref) => node.context.lookup(ref))
      : contents
        ? [contents]
        : [];
  return decodedBytes(streams);
}

/**
 * 頁（またはフォーム）の中身をたどり、置かれている JPEG 画像を集める。
 * ブラウザの展開だけでは同じ見た目にならないものがあれば、その理由を返す。
 *
 * 通すもの: 画像より前に塗る下地、透明な文字、フォームに入れた画像、
 * 帯に分けて置いた何枚かの画像。
 *
 * @returns {string|null} 理由（通すなら null）
 */
function collect(context, content, resources, ctm, found, depth) {
  const stack = [];
  for (const { op, operands } of operations(content)) {
    if (op === 'q') {
      stack.push(ctm);
    } else if (op === 'Q') {
      ctm = stack.pop() ?? ctm;
    } else if (op === 'cm') {
      const m = operands.slice(-6);
      if (m.length !== 6 || m.some((v) => typeof v !== 'number')) return '読めない座標の指定';
      ctm = multiply(ctm, m);
    } else if (op === 'Do') {
      const name = operands.at(-1);
      if (typeof name !== 'string') return '読めない XObject の指定';
      const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      const stream = xobjects?.lookup(PDFName.of(name.slice(1)));
      const subtype = nameOf(stream?.dict?.lookup(PDFName.of('Subtype')));
      if (subtype === 'Form') {
        found.forms++;
        if (depth >= MAX_FORM_DEPTH) return 'フォームの入れ子が深い';
        if (!(stream instanceof PDFRawStream)) return 'フォームを読めない';
        const matrix = stream.dict.lookup(PDFName.of('Matrix'));
        const m = matrix instanceof PDFArray ? matrix.asArray().map((v) => context.lookup(v)?.asNumber?.()) : [1, 0, 0, 1, 0, 0];
        if (m.length !== 6 || m.some((v) => typeof v !== 'number')) return '読めないフォームの座標';
        const inner = stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources;
        const reason = collect(context, decodedBytes([stream]), inner, multiply(ctm, m), found, depth + 1);
        if (reason) return reason;
      } else if (subtype === 'Image') {
        const image = inspectImage(context, stream);
        found.infos.push(image.info);
        if (image.reason) return image.reason;
        if (found.images.length >= MAX_IMAGES) return '画像が多すぎる';
        found.images.push({ jpeg: stream.contents, width: image.width, height: image.height, matrix: ctm });
      } else {
        return 'XObject を読めない';
      }
    } else if (PAINT.has(op)) {
      if (found.images.length) return '画像の上に図形を描いている';
      found.paints++;
    } else if (op === 'BI') {
      return 'インライン画像を使っている';
    } else if (!HARMLESS.has(op)) {
      return `知らない命令（${op}）`;
    }
  }
  return null;
}

/**
 * 1 頁が、JPEG 画像をブラウザに展開させて描ける形か調べる。
 *
 * @param {import('pdf-lib').PDFPage} page
 * @returns {{scan: {images:{jpeg:Uint8Array, width:number, height:number, matrix:number[]}[]} | null,
 *            reason: string|null, outline: string}}
 *   scan は描けるときだけ。reason は描けない理由、outline は頁の作り（記録に出す）。
 */
export function inspectPage(page) {
  const { node } = page;
  const found = { images: [], infos: [], paints: 0, forms: 0 };
  let reason;
  try {
    const content = contentBytes(node);
    reason = content
      ? collect(node.context, content, node.Resources(), [1, 0, 0, 1, 0, 0], found, 0)
      : '頁の中身を読めない';
  } catch (error) {
    reason = `頁の中身を読めない（${error?.message || error}）`;
  }
  if (!reason && found.images.length === 0) reason = '画像が無い';
  const parts = [`画像 ${found.infos.length} 枚${found.infos.length ? `（${found.infos.slice(0, 4).join('、')}${found.infos.length > 4 ? '、…' : ''}）` : ''}`];
  if (found.paints) parts.push(`下地の塗り ${found.paints}`);
  if (found.forms) parts.push(`フォーム ${found.forms}`);
  return { scan: reason ? null : { images: found.images }, reason, outline: parts.join('・') };
}

/**
 * PDF の各頁の、JPEG のまま描ける画像を調べる。
 *
 * 読めない PDF（暗号化など）は、すべての頁を pdf.js で描く。
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<{scans:(object|null)[], reasons:Map<string, number>, example:string}>}
 *   scans は頁ごと（描けない頁は null）。reasons は描けない理由ごとの頁数、
 *   example は描けなかった最初の頁の作り（どちらも記録に出す）。
 */
export async function findScanImages(bytes) {
  let doc;
  try {
    // 数百頁の PDF でも画面を固めないよう、少しずつ読む。
    doc = await PDFDocument.load(bytes, { updateMetadata: false, objectsPerTick: 50 });
  } catch (error) {
    return { scans: [], reasons: new Map([[`PDF を読めない（${error?.message || error}）`, 1]]), example: '' };
  }
  const scans = [];
  const reasons = new Map();
  let example = '';
  doc.getPages().forEach((page, index) => {
    const { scan, reason, outline } = inspectPage(page);
    scans.push(scan);
    if (!reason) return;
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
    example ||= `${index + 1} 頁目: ${outline}`;
  });
  return { scans, reasons, example };
}

// --- 描く ----------------------------------------------------------------------

/**
 * 画像の画素 → canvas の画素の変換。
 *
 * 画像は単位正方形に、左上を (0, 1) にして置かれる（PDF の決まり）。
 */
export function imageTransform(viewportTransform, image, bitmapWidth, bitmapHeight) {
  const unit = [1 / bitmapWidth, 0, 0, -1 / bitmapHeight, 0, 1];
  return multiply(viewportTransform, multiply(image.matrix, unit));
}

/** createImageBitmap に頼む大きさ（canvas に描くより細かい分は、展開のときに縮める）。 */
export function decodeSize(viewportTransform, image) {
  const t = imageTransform(viewportTransform, image, image.width, image.height);
  // 画像の 1 画素が、canvas の上で何画素ぶんの長さになるか（横・縦それぞれ）。
  const across = Math.hypot(t[0], t[1]);
  const down = Math.hypot(t[2], t[3]);
  return {
    width: Math.max(1, Math.min(image.width, Math.ceil(image.width * across))),
    height: Math.max(1, Math.min(image.height, Math.ceil(image.height * down))),
  };
}

async function decode(image, size) {
  const blob = new Blob([image.jpeg], { type: 'image/jpeg' });
  const options = {};
  if (size.width < image.width || size.height < image.height) {
    // 縮め方は粗いもの（low）にする。600dpi の頁（数千万画素）でも、全部を
    // 展開するより速く、メモリも小さい（細かい縮め方は倍近くかかる）。粗さは、
    // 要る大きさの 2 倍で展開してから canvas で丁寧に縮めて打ち消す（drawScan）。
    Object.assign(options, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'low' });
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
 * スキャンの画像を、viewport ごとの canvas に描く（画像ごとに展開は 1 回）。
 *
 * @param {{images:{jpeg:Uint8Array, width:number, height:number, matrix:number[]}[]}} scan
 * @param {{transform:number[], width:number, height:number}[]} viewports
 *   pdf.js の page.getViewport() の結果（帯を描くときは offsetY 付き）
 * @param {({width:number, height:number}|undefined)[]} [canvasSizes]
 *   canvas の大きさ（既定は viewport の大きさ）
 * @returns {Promise<HTMLCanvasElement[]>}
 */
export async function drawScan(scan, viewports, canvasSizes = []) {
  // いちばん細かく描く viewport に足り、いちばん粗く描くものの 2 倍はある
  // 大きさで展開する（展開のときの粗い縮め方を、canvas で縮めるときに均す）。
  // 元の大きさは超えない。
  const bitmaps = await Promise.all(
    scan.images.map((image) => {
      const sizes = viewports.map((viewport) => decodeSize(viewport.transform, image));
      const pick = (key) =>
        Math.min(image[key], Math.max(...sizes.map((s) => s[key]), 2 * Math.min(...sizes.map((s) => s[key]))));
      return decode(image, { width: pick('width'), height: pick('height') });
    })
  );
  try {
    return viewports.map((viewport, k) => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(canvasSizes[k]?.width ?? viewport.width));
      canvas.height = Math.max(1, Math.round(canvasSizes[k]?.height ?? viewport.height));
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingQuality = 'high';
      scan.images.forEach((image, n) => {
        const bitmap = bitmaps[n];
        context.setTransform(...imageTransform(viewport.transform, image, bitmap.width, bitmap.height));
        context.drawImage(bitmap, 0, 0);
      });
      context.setTransform(1, 0, 0, 1, 0, 0);
      return canvas;
    });
  } finally {
    bitmaps.forEach((bitmap) => bitmap.close?.());
  }
}
