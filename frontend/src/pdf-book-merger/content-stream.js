// 頁の中身（コンテンツストリーム）を読む。
//
// スキャンの画像を探す（scan-images.js）のと、透明な文字を消す（strip-text.js）
// のに使う。

import { PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/**
 * 頁の中身の命令を、[オペランド…, 命令] の並びに切り分ける。
 *
 * 要るのは数と名前だけなので、文字列・配列・辞書は「何かがあった」ことだけを
 * 残す（null）。インライン画像（BI … ID … EI）が出てきたら、そこで止める。
 * start と end は、その命令（オペランドから命令の語まで）が bytes の中で占める
 * 範囲（strip-text.js が、命令をオペランドごと取り除くのに使う）。
 *
 * @param {Uint8Array} bytes
 * @returns {Generator<{op:string, operands:(number|string|null)[], start:number, end:number}>}
 */
export function* operations(bytes) {
  let operands = [];
  let start = -1;
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const c = bytes[i];
    if (WHITESPACE.has(c)) {
      i++;
      continue;
    }
    if (c === 0x25) {
      // % から行の終わりまでは注釈。
      while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
      continue;
    }
    if (start < 0) start = i;
    if (c === 0x28) {
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
        yield { op: word, operands, start, end: j };
        if (word === 'BI') return;
        operands = [];
        start = -1;
      }
    }
  }
}

function latin1(bytes, start, end) {
  let text = '';
  for (let k = start; k < end; k++) text += String.fromCharCode(bytes[k]);
  return text;
}

/** ストリームを展開してつなげる（間に改行を挟む）。展開できないものがあれば null。 */
export function decodedBytes(streams) {
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

/** 頁の中身（Contents。いくつかに分かれていてもつなげる）を展開したもの。 */
export function contentBytes(node) {
  const contents = node.Contents();
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((ref) => node.context.lookup(ref))
      : contents
        ? [contents]
        : [];
  return decodedBytes(streams);
}
