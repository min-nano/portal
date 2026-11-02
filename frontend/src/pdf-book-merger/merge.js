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
  PDFHeader,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
} from 'pdf-lib';
import './pdf-lib-views.js';

/** 画面に名乗る、このツールの名前（文書の情報の「作成アプリ」に入れる）。 */
const CREATOR = 'PDF 結合ツール';

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

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 頁の「描くもの」の指紋（SHA-256 の 16 進）。
 *
 * 中身の命令（Contents）と、使っている画像・図形（XObject。中の画像も）の
 * バイト列から作る。pdf-lib が頁を写すときは、これらをバイト列のまま写すので、
 * 正しく写せていれば元の頁と同じ指紋になる。
 *
 * バイト列は 1 つずつ SHA-256 にして、その並びをもう 1 度 SHA-256 にする。
 * つなげてから 1 度に求めると、頁の画像をまるごと写すことになるため
 * （crypto.subtle.digest も、渡したものを写してから求める）。
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

  const all = new Uint8Array(chunks.length * 32);
  for (let i = 0; i < chunks.length; i++) all.set(await sha256(chunks[i]), i * 32);
  return hex(await sha256(all));
}

/**
 * PDF の全頁の指紋（結合した PDF を確かめるとき）。
 *
 * 1 頁ずつ求める（全頁を並べて求めると、どの頁の画像も同時に写されて、本の
 * 何冊ぶんものメモリを使う）。
 */
export async function pageDigests(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const digests = [];
  for (const page of doc.getPages()) digests.push(await pageDigest(page));
  return digests;
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

/** 書き出すときに、小さな物をまとめて渡す大きさ（バイト）。 */
const CHUNK = 1 << 20;

/**
 * 書き出し口。渡したバイト列を順に write へ流し、書いた位置（offset）を数える。
 * 小さな物はまとめてから渡し、大きな物（スキャンの画像）はそのまま渡す。
 */
function outputTo(write) {
  let offset = 0;
  let pending = [];
  let pendingSize = 0;
  // まとめているものを渡す（書く物の頭と終わりの印が必ずあるので、空にはならない）。
  const flush = async () => {
    const chunk = new Uint8Array(pendingSize);
    let at = 0;
    for (const part of pending) {
      chunk.set(part, at);
      at += part.length;
    }
    pending = [];
    pendingSize = 0;
    await write(chunk);
  };
  return {
    get offset() {
      return offset;
    },
    async push(bytes) {
      offset += bytes.length;
      if (bytes.length >= CHUNK) {
        await flush();
        await write(bytes);
        return;
      }
      pending.push(bytes);
      pendingSize += bytes.length;
      if (pendingSize >= CHUNK) await flush();
    },
    async text(text) {
      await this.push(new TextEncoder().encode(text));
    },
    flush,
  };
}

/** pdf-lib の物を、PDF に書くバイト列にする。 */
function bytesOf(object) {
  const bytes = new Uint8Array(object.sizeInBytes());
  object.copyBytesInto(bytes, 0);
  return bytes;
}

/** 間接の物を 1 つ書く（「n 0 obj … endobj」）。書いた位置を offsets に残す。 */
async function writeObject(out, offsets, ref, object) {
  offsets[ref.objectNumber] = out.offset;
  await out.text(`${ref.objectNumber} ${ref.generationNumber} obj\n`);
  await out.push(bytesOf(object));
  await out.text('\nendobj\n\n');
}

/**
 * 相互参照表（xref）と trailer を書く。書いていない番号は空き（f）にする
 * （元のファイルが無い物を指していると、pdf-lib は番号だけ振って中身を入れない）。
 */
async function writeTrailer(out, offsets, context) {
  const size = context.largestObjectNumber + 1;
  const start = out.offset;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) {
    xref += offsets[n] === undefined ? '0000000000 00000 f \n' : `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  await out.text(xref);
  const trailer = context.obj({ Size: size, Root: context.trailerInfo.Root, Info: context.trailerInfo.Info });
  await out.text('trailer\n');
  await out.push(bytesOf(trailer));
  await out.text(`\nstartxref\n${start}\n%%EOF\n`);
}

/**
 * 頁を指定の順に並べた 1 つの PDF を、少しずつ書き出す。
 *
 * 元のファイルは 1 つずつ読み（load）、頁を写したら、写した中身（画像・書体
 * など）をすぐに書き出して手放す。結合した PDF をメモリの上で丸ごと組み立て
 * ないので、使うメモリは、いちばん大きな元のファイル 1 つぶんほどで済む
 * （pdf-lib の save は、元のファイルすべてと書き出した PDF を同時に持つ）。
 * 頁そのもの（小さな辞書）は、並べ終えてから頁の木と一緒に書く。
 *
 * @param {object} options
 * @param {Map<string, {name:string, load:() => Promise<Uint8Array>}>} options.sources
 *   ファイルの key → 名前と、中身を読む関数
 * @param {{fileKey:string, pageIndex:number}[]} options.order 並べる順
 * @param {string} options.title 文書のタイトル
 * @param {{start:number, style:string|null, prefix:string, first:number}[]} [options.labels]
 * @param {string} [options.infoFrom] 文書の情報を引き継ぐファイルの key
 * @param {(chunk:Uint8Array) => (void|Promise<void>)} options.write 書き出す先
 * @param {(done:number, total:number) => void} [options.onProgress]
 * @returns {Promise<{size:number, digests:string[]}>}
 *   size は書き出した大きさ、digests は並べた順の元の頁の指紋（pageDigest）
 */
export async function writeMergedPdf({ sources, order, title, labels = [], infoFrom, write, onProgress }) {
  const merged = await PDFDocument.create();
  const { context } = merged;
  const needed = new Map();
  for (const item of order) {
    if (!needed.has(item.fileKey)) needed.set(item.fileKey, new Set());
    needed.get(item.fileKey).add(item.pageIndex);
  }

  const out = outputTo(write);
  const offsets = [];
  await out.push(bytesOf(PDFHeader.forVersion(1, 7)));
  await out.text('\n\n');
  // 最後まで残す物（文書の目録・頁の木・文書の情報と、写した頁）。
  const kept = new Set(context.enumerateIndirectObjects().map(([ref]) => ref));

  // ファイルごとに 1 度だけ写す（同じファイルの頁が共有している画像や
  // 書体を、頁の数だけ複製しないため）。
  const copied = new Map();
  const digests = new Map();
  let info = null;
  let done = 0;
  for (const [fileKey, indices] of needed) {
    const source = sources.get(fileKey);
    if (!source) throw new Error('結合するファイルの中身がありません。');
    const doc = await loadSource(await source.load(), source.name);
    if (fileKey === infoFrom || (!infoFrom && !info)) info = sourceInfo(doc);
    const list = [...indices].sort((a, b) => a - b);
    for (const index of list) {
      if (index >= doc.getPageCount()) {
        throw new Error(`「${source.name}」に ${index + 1} 頁目がありません。`);
      }
    }
    for (const index of list) digests.set(`${fileKey}:${index}`, await pageDigest(doc.getPage(index)));
    const pages = await merged.copyPages(doc, list);
    list.forEach((index, i) => {
      copied.set(`${fileKey}:${index}`, pages[i]);
      kept.add(pages[i].ref);
    });
    // 写した中身を書き出して、手放す（元のファイルのバイト列を指しているので、
    // 手放せば元のファイルもまるごと手放せる）。
    for (const [ref, object] of context.enumerateIndirectObjects()) {
      if (kept.has(ref)) continue;
      await writeObject(out, offsets, ref, object);
      context.delete(ref);
    }
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

  // 残りの物（頁・頁の木・目録・文書の情報など）を書き、相互参照表で締める。
  for (const [ref, object] of context.enumerateIndirectObjects()) await writeObject(out, offsets, ref, object);
  await writeTrailer(out, offsets, context);
  await out.flush();

  return {
    size: out.offset,
    digests: order.map((item) => digests.get(`${item.fileKey}:${item.pageIndex}`)),
  };
}

/**
 * 頁を指定の順に並べた 1 つの PDF を、メモリの上に作る（保存領域を使えないとき）。
 *
 * @param {object} options writeMergedPdf と同じ（write は要らない）。sources の
 *   中身は、load の代わりに bytes でも渡せる
 * @returns {Promise<{bytes:Uint8Array, digests:string[]}>}
 */
export async function mergePdf({ sources, ...options }) {
  const chunks = [];
  const loaders = new Map(
    [...sources].map(([key, source]) => [key, { name: source.name, load: source.load ?? (async () => source.bytes) }])
  );
  const { size, digests } = await writeMergedPdf({
    ...options,
    sources: loaders,
    write: (chunk) => {
      chunks.push(chunk);
    },
  });
  // つなげながら、写し終えた分は手放す（全部の分と、つなげたものを同時に持たない）。
  const bytes = new Uint8Array(size);
  let at = 0;
  for (let i = 0; i < chunks.length; i++) {
    bytes.set(chunks[i], at);
    at += chunks[i].length;
    chunks[i] = null;
  }
  return { bytes, digests };
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
