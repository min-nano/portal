// 分けた PDF を 1 つの ZIP にまとめる。
//
// PDF の中身（スキャンの JPEG・Flate で縮めた文字）はもう縮んでいるので、
// ZIP では縮めずに格納する（stored）。縮めないので、中身を読まずに、保存領域の
// ファイル（File）をそのまま Blob の部品として並べられる。メモリに読むのは、
// 頭と目録の小さなバイト列だけになる。
//
// ZIP には中身の CRC-32 が要る。結合した PDF は検証のときに 1 度メモリに読む
// ので、そのときに求めておく（crc32）。
//
// ファイル名は UTF-8 で書き、その印（汎用フラグの 11 ビット目）を立てる
// （Windows のエクスプローラー・macOS・iOS の「ファイル」は、これで日本語の
// 名前を正しく出す）。ZIP64 は使わないので、全体で 4 GB 未満に限る。

const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c >>> 0;
}

/**
 * CRC-32（ZIP・PNG と同じもの）。続きから求めるときは、前の値を crc に渡す。
 *
 * @param {Uint8Array} bytes
 * @param {number} [crc]
 */
export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** ZIP に書ける大きさの上限（ZIP64 を使わないので 4 GB 未満）。 */
export const ZIP_LIMIT = 0xffffffff;

/** 日時を、ZIP に書く MS-DOS の形（時刻・日付）にする。 */
function dosTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** 決まった形の頭を書く（数はすべて小さい方から）。 */
function header(fields) {
  const size = fields.reduce((total, [bytes]) => total + bytes, 0);
  const view = new DataView(new ArrayBuffer(size));
  let at = 0;
  for (const [bytes, value] of fields) {
    if (bytes === 2) view.setUint16(at, value, true);
    else view.setUint32(at, value, true);
    at += bytes;
  }
  return new Uint8Array(view.buffer);
}

/**
 * ファイルを縮めずに並べた ZIP を作る。中身は読まずに、Blob の部品にする。
 *
 * @param {{name:string, data:Blob|Uint8Array, size:number, crc:number}[]} entries
 * @param {Date} [date] 書き込む日時
 * @returns {Blob}
 */
export function zipBlob(entries, date = new Date()) {
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  // 頭と目録の分（1 ファイルにつき 100 バイトほど）も足して確かめる。
  if (total + entries.length * 1024 >= ZIP_LIMIT) {
    throw new Error('分けたファイルの合計が 4 GB を超えるため、ZIP にまとめられません。1 つずつダウンロードしてください。');
  }
  const { time, date: day } = dosTime(date);
  const encoder = new TextEncoder();
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const common = [
      [2, 20], // 展開に要る版（2.0）
      [2, 0x0800], // 名前は UTF-8
      [2, 0], // 縮めない（stored）
      [2, time],
      [2, day],
      [4, entry.crc],
      [4, entry.size], // 縮めた大きさ
      [4, entry.size], // 元の大きさ
      [2, name.length],
      [2, 0], // 拡張の欄の長さ
    ];
    const local = header([[4, 0x04034b50], ...common]);
    parts.push(local, name, entry.data);
    directory.push(
      header([
        [4, 0x02014b50],
        [2, 20], // 作った版
        ...common,
        [2, 0], // 注釈の長さ
        [2, 0], // ディスクの番号
        [2, 0], // 中身の種類
        [4, 0], // 属性
        [4, offset],
      ]),
      name
    );
    offset += local.length + name.length + entry.size;
  }
  const directorySize = directory.reduce((sum, bytes) => sum + bytes.length, 0);
  const end = header([
    [4, 0x06054b50],
    [2, 0], // このディスクの番号
    [2, 0], // 目録の始まるディスク
    [2, entries.length],
    [2, entries.length],
    [4, directorySize],
    [4, offset],
    [2, 0], // 注釈の長さ
  ]);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
