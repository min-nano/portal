// PDF 結合ツール: 分けた PDF を 1 つの ZIP にまとめる（zip.js）。
//
// 書いた ZIP を、目録（central directory）からたどって読み直し、名前・中身・
// CRC が合うことを確かめる。CRC は Node の zlib の値と突き合わせる。

import { crc32 as zlibCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, ZIP_LIMIT, zipBlob } from '../src/pdf-book-merger/zip.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** ZIP を目録から読む。 */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  const directoryEnd = view.getUint32(end + 16, true) + view.getUint32(end + 12, true);
  expect(directoryEnd).toBe(end);
  let at = view.getUint32(end + 16, true);
  const entries = [];
  for (let k = 0; k < count; k++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    // 中身の頭（local header）にも、同じ名前と CRC が書いてある。
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    expect(view.getUint32(offset + 14, true)).toBe(crc);
    const localName = view.getUint16(offset + 26, true);
    expect(decoder.decode(bytes.subarray(offset + 30, offset + 30 + localName))).toBe(name);
    const start = offset + 30 + localName + view.getUint16(offset + 28, true);
    entries.push({ name, flags, method, crc, data: bytes.slice(start, start + size) });
    at += 46 + nameLength;
  }
  return entries;
}

describe('crc32', () => {
  it('zlib と同じ値になり、続きからも求められる', () => {
    const bytes = encoder.encode('%PDF-1.7 吾輩は猫である。名前はまだ無い。');
    expect(crc32(bytes)).toBe(zlibCrc32(bytes));
    expect(crc32(bytes.subarray(10), crc32(bytes.subarray(0, 10)))).toBe(zlibCrc32(bytes));
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('zipBlob', () => {
  it('縮めずに格納し、日本語の名前は UTF-8 の印を付けて書く（中身は Blob のまま並べる）', async () => {
    const first = encoder.encode('%PDF-first');
    const second = encoder.encode('%PDF-second part');
    const entries = [
      { name: '猫_1.pdf', data: first, size: first.length, crc: crc32(first) },
      { name: '猫_2.pdf', data: new Blob([second]), size: second.length, crc: crc32(second) },
    ];
    const blob = zipBlob(entries, new Date(2026, 10, 14, 9, 30, 15));
    expect(blob.type).toBe('application/zip');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const read = readZip(bytes);
    expect(read.map((entry) => entry.name)).toEqual(['猫_1.pdf', '猫_2.pdf']);
    expect(read.map((entry) => decoder.decode(entry.data))).toEqual(['%PDF-first', '%PDF-second part']);
    for (const entry of read) {
      expect(entry.method).toBe(0);
      expect(entry.flags & 0x0800).toBe(0x0800);
      expect(entry.crc).toBe(zlibCrc32(entry.data));
    }
    // 日時（MS-DOS の形）。
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(10, true)).toBe((9 << 11) | (30 << 5) | 7);
    expect(view.getUint16(12, true)).toBe(((2026 - 1980) << 9) | (11 << 5) | 14);
  });

  it('4 GB を超えるときは、まとめずに断る', () => {
    const entry = { name: 'a.pdf', data: new Uint8Array(0), size: ZIP_LIMIT - 10, crc: 0 };
    expect(() => zipBlob([entry])).toThrow('4 GB');
  });
});
