// PDF の結合（pdf-lib）。ブラウザの中だけで行い、スキャンをサーバーへは送らない。
//
// 頁は「描き直す」のではなく**頁の中身をそのまま写す**（copyPages）。
// スキャンの画像も、サーチャブル PDF の透明な文字情報（OCR の結果）も、
// 頁の中身の一部なので、写せばそのまま残る。画像を再圧縮しないので、
// 画質も落ちない。
//
// 文書の情報（タイトル・作成者など）は、本文の最初のファイルから引き継ぐ。
// タイトルだけは保存するファイル名にする（1 冊にまとめたものなので）。
// 頁ラベル（ordering.js の pageLabelRanges）を付けて、ビューアーの頁番号を
// 本の頁番号と揃える。
//
// 写した頁が元の頁と同じであることは、頁の「描くもの」（中身の命令と、使って
// いる画像・図形）の指紋（pageDigest）で確かめる。結合の前に元の頁の指紋を
// 取っておき、結合した PDF の頁の指紋と比べる（verify.js）。頁を描き直して
// 見比べるより速く、1 バイトの違いも見逃さない。

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
} from 'pdf-lib';

/** 画面に名乗る、このツールの名前（文書の情報の「作成アプリ」に入れる）。 */
const CREATOR = '書籍スキャン PDF 結合ツール';

/** 元のファイルを開く。暗号化されたものは写せないので、ここで止める。 */
export async function loadSource(bytes, name) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    if (/encrypt/i.test(String(error?.message))) {
      throw new Error(`「${name}」は暗号化（パスワード保護）されているため結合できません。`);
    }
    throw new Error(`「${name}」を PDF として読み込めませんでした（${error?.message ?? error}）。`);
  }
}

function streamBytes(stream) {
  if (stream instanceof PDFRawStream) return stream.contents;
  if (typeof stream?.getContents === 'function') return stream.getContents();
  return new Uint8Array(0);
}

/** 使っている画像・図形（XObject）と、その中で使っているものを、名前の順に集める。 */
function collectXObjects(context, resources, chunks, seen) {
  const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xobjects) return;
  const entries = xobjects.entries().sort(([a], [b]) => (a.toString() < b.toString() ? -1 : 1));
  for (const [name, value] of entries) {
    const stream = context.lookup(value);
    if (!(stream instanceof PDFStream) || seen.has(stream)) continue;
    seen.add(stream);
    chunks.push(new TextEncoder().encode(name.toString()), streamBytes(stream));
    const mask = stream.dict.lookup(PDFName.of('SMask'));
    if (mask instanceof PDFStream) chunks.push(streamBytes(mask));
    if (stream.dict.get(PDFName.of('Subtype')) === PDFName.of('Form')) {
      collectXObjects(context, stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict), chunks, seen);
    }
  }
}

/**
 * 頁の「描くもの」の指紋（SHA-256 の 16 進）。
 *
 * 中身の命令（Contents）と、使っている画像・図形（XObject。中の画像も）の
 * バイト列から作る。pdf-lib が頁を写すときは、これらをバイト列のまま写すので、
 * 正しく写せていれば元の頁と同じ指紋になる。
 *
 * @param {import('pdf-lib').PDFPage} page
 */
export async function pageDigest(page) {
  const { node } = page;
  const chunks = [];
  const contents = node.Contents();
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) chunks.push(streamBytes(contents.lookup(i)));
  } else if (contents) {
    chunks.push(streamBytes(contents));
  }
  collectXObjects(node.context, node.Resources(), chunks, new Set());

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** PDF の全頁の指紋（結合した PDF を確かめるとき）。 */
export async function pageDigests(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return Promise.all(doc.getPages().map(pageDigest));
}

/** 元の文書の情報のうち、引き継ぐもの。 */
function sourceInfo(doc) {
  const info = {
    author: doc.getAuthor(),
    subject: doc.getSubject(),
    keywords: doc.getKeywords(),
    creationDate: doc.getCreationDate(),
  };
  // 別の文書の中の物は、そのままでは持ち込めない（参照先が違う）ので、文字に直す。
  const lang = doc.catalog.lookup(PDFName.of('Lang'));
  return { ...info, lang: typeof lang?.decodeText === 'function' ? lang.decodeText() : null };
}

/**
 * 頁を指定の順に並べた 1 つの PDF を作る。
 *
 * @param {object} options
 * @param {Map<string, {bytes:Uint8Array, name:string}>} options.sources ファイルの key → 中身
 * @param {{fileKey:string, pageIndex:number}[]} options.order 並べる順
 * @param {string} options.title 文書のタイトル
 * @param {{start:number, style:string|null, prefix:string, first:number}[]} [options.labels]
 * @param {string} [options.infoFrom] 文書の情報を引き継ぐファイルの key
 * @param {(done:number, total:number) => void} [options.onProgress]
 * @returns {Promise<{bytes:Uint8Array, digests:string[]}>}
 *   digests は、並べた順の元の頁の指紋（pageDigest）
 */
export async function mergePdf({ sources, order, title, labels = [], infoFrom, onProgress }) {
  const merged = await PDFDocument.create();
  const needed = new Map();
  for (const item of order) {
    if (!needed.has(item.fileKey)) needed.set(item.fileKey, new Set());
    needed.get(item.fileKey).add(item.pageIndex);
  }

  // ファイルごとに 1 度だけ写す（同じファイルの頁が共有している画像や
  // 書体を、頁の数だけ複製しないため）。
  const copied = new Map();
  const digests = new Map();
  let info = null;
  let done = 0;
  for (const [fileKey, indices] of needed) {
    const source = sources.get(fileKey);
    if (!source) throw new Error('結合するファイルの中身がありません。');
    const doc = await loadSource(source.bytes, source.name);
    if (fileKey === infoFrom || (!infoFrom && !info)) info = sourceInfo(doc);
    const list = [...indices].sort((a, b) => a - b);
    for (const index of list) {
      if (index >= doc.getPageCount()) {
        throw new Error(`「${source.name}」に ${index + 1} 頁目がありません。`);
      }
    }
    for (const index of list) digests.set(`${fileKey}:${index}`, await pageDigest(doc.getPage(index)));
    const pages = await merged.copyPages(doc, list);
    list.forEach((index, i) => copied.set(`${fileKey}:${index}`, pages[i]));
    done += list.length;
    onProgress?.(done, order.length);
  }

  for (const item of order) merged.addPage(copied.get(`${item.fileKey}:${item.pageIndex}`));

  merged.setTitle(title, { showInWindowTitleBar: true });
  merged.setCreator(CREATOR);
  if (info?.author) merged.setAuthor(info.author);
  if (info?.subject) merged.setSubject(info.subject);
  if (info?.keywords) merged.setKeywords(info.keywords.split(/\s+/).filter(Boolean));
  if (info?.creationDate) merged.setCreationDate(info.creationDate);
  merged.setModificationDate(new Date());
  // 文書の言語（読み上げ・検索が使う）は、元にあったときだけ引き継ぐ。
  if (info?.lang) merged.catalog.set(PDFName.of('Lang'), PDFHexString.fromText(info.lang));

  if (labels.length) setPageLabels(merged, labels);

  return {
    bytes: await merged.save({ useObjectStreams: true }),
    digests: order.map((item) => digests.get(`${item.fileKey}:${item.pageIndex}`)),
  };
}

/** 頁ラベル（/PageLabels の数の木）を書き込む。 */
function setPageLabels(doc, ranges) {
  const nums = [];
  for (const range of ranges) {
    const entry = { Type: 'PageLabel' };
    if (range.style) entry.S = range.style;
    if (range.prefix) entry.P = PDFHexString.fromText(range.prefix);
    if (range.style && range.first !== 1) entry.St = range.first;
    nums.push(PDFNumber.of(range.start), doc.context.obj(entry));
  }
  doc.catalog.set(PDFName.of('PageLabels'), doc.context.obj({ Nums: nums }));
}
