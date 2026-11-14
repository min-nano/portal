// JPEG の符号の表（ハフマン表）を作り直して、画素を変えずに小さくする
// （PDF 結合ツール。jpegtran -optimize と同じこと）。
//
// JPEG は、画素を DCT の係数にして量子化したもの（ここで画質が決まる）を、
// ハフマン符号で詰めて書く。スキャナの多くは、規格の例に載っている決まった
// 表（どの画像にも使える代わりに、どの画像にも合っていない表）で書くので、
// その画像に合わせた表で書き直すと、係数は 1 つも変えずに 2 割ほど小さくなる
// ことがある（600dpi のカラーのスキャンで 19 %）。係数が同じなので、展開した
// 画素も元と 1 つ残らず同じになる。
//
// 書き直しは、
//   1. 符号を読んで、記号（係数の並びを表す 0〜255 の値）ごとの数を数える
//   2. 数から最適な表を作る（規格の附属書 K.2。libjpeg と同じ手順）
//   3. もう 1 度読みながら、記号を新しい表の符号に置き換えて書く
//      （記号に続く係数の値のビットは、そのまま写す）
//   4. 書いたものを読み直し、元と記号・係数の値が 1 つ残らず同じか確かめる
// の順に行う。確かめられなかったとき（扱わない形・壊れたデータ・小さく
// ならない）は null を返し、元の JPEG をそのまま使う。
//
// 扱うのは、ハフマン符号の順次（ベースライン・拡張）の JPEG だけ。
// プログレッシブ・算術符号・可逆・階層の JPEG は、そのまま残す。

/** 1 つのブロック（8×8 の係数）が持つ記号の数の上限（DC 1 つ + AC 63）。 */
const BLOCK_SYMBOLS = 64;

/** 符号を表から一度に引く長さ（ビット）。これより長い符号は 1 ビットずつ探す。 */
const LOOKUP_BITS = 9;

/** 扱えない JPEG・壊れた JPEG（optimizeJpeg は null を返して、元のまま使う）。 */
function fail(message) {
  throw new Error(message);
}

function u16(bytes, at) {
  return (bytes[at] << 8) | bytes[at + 1];
}

/**
 * 符号を読むための表を作る。
 *
 * @param {Uint8Array} counts 長さ 1〜16 の符号の数
 * @param {Uint8Array} symbols 符号の短い順の記号
 */
function decodingTable(counts, symbols) {
  const lookup = new Uint16Array(1 << LOOKUP_BITS);
  const maxcode = new Int32Array(17).fill(-1);
  const offset = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    offset[length] = k - code;
    for (let i = 0; i < counts[length - 1]; i++) {
      if (length <= LOOKUP_BITS) {
        const shift = LOOKUP_BITS - length;
        lookup.fill((length << 8) | symbols[k], code << shift, (code + 1) << shift);
      }
      code++;
      k++;
    }
    if (code > 1 << length) fail('符号の表が壊れています');
    if (counts[length - 1]) maxcode[length] = code - 1;
    code <<= 1;
  }
  return { counts, symbols, lookup, maxcode, offset };
}

/** 符号を書くための表（記号 → 符号と長さ）。 */
function encodingTable({ counts, symbols }) {
  const codes = new Uint16Array(256);
  const sizes = new Uint8Array(256);
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < counts[length - 1]; i++) {
      codes[symbols[k]] = code++;
      sizes[symbols[k++]] = length;
    }
    code <<= 1;
  }
  return { codes, sizes };
}

/**
 * 記号ごとの数から、最適な符号の表を作る（規格の附属書 K.2。libjpeg の
 * jpeg_gen_optimal_table と同じ手順なので、同じ表になる）。
 *
 * どの記号にも「1 が並ぶだけの符号」を振らないよう、数 1 の仮の記号（256）を
 * 足して作り、最後に外す。符号は 16 ビットまでに縮める。
 *
 * @param {Int32Array} frequencies 記号 0〜255 の数
 */
export function optimalTable(frequencies) {
  const freq = new Float64Array(257);
  freq.set(frequencies.subarray(0, 256));
  freq[256] = 1;
  const codesize = new Int32Array(257);
  const others = new Int32Array(257).fill(-1);
  for (;;) {
    // いちばん少ないもの（同じなら番号の大きいほう）と、その次。
    let c1 = -1;
    let c2 = -1;
    for (let i = 0; i <= 256; i++) {
      if (!freq[i]) continue;
      if (c1 < 0 || freq[i] <= freq[c1]) {
        c2 = c1;
        c1 = i;
      } else if (c2 < 0 || freq[i] <= freq[c2]) {
        c2 = i;
      }
    }
    if (c2 < 0) break;
    freq[c1] += freq[c2];
    freq[c2] = 0;
    codesize[c1]++;
    while (others[c1] >= 0) {
      c1 = others[c1];
      codesize[c1]++;
    }
    others[c1] = c2;
    codesize[c2]++;
    while (others[c2] >= 0) {
      c2 = others[c2];
      codesize[c2]++;
    }
  }

  const bits = new Int32Array(258);
  for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++;
  // 16 ビットより長い符号を、木の浅いところへ移して縮める。
  for (let i = 257; i > 16; i--) {
    while (bits[i] > 0) {
      let j = i - 2;
      while (bits[j] === 0) j--;
      bits[i] -= 2;
      bits[i - 1]++;
      bits[j + 1] += 2;
      bits[j]--;
    }
  }
  // 仮の記号（いちばん長い符号のどれか）を外す。
  let longest = 16;
  while (bits[longest] === 0) longest--;
  bits[longest]--;

  const symbols = [];
  for (let length = 1; length <= 257; length++) {
    for (let symbol = 0; symbol < 256; symbol++) if (codesize[symbol] === length) symbols.push(symbol);
  }
  return { counts: Uint8Array.from(bits.subarray(1, 17)), symbols: Uint8Array.from(symbols) };
}

/**
 * JPEG の作りを読む。中身（係数の符号）は読まず、場所だけ覚える。
 *
 * @returns {{frame:object, items:object[], trailing:Uint8Array}}
 *   items は、そのまま写す区切り（{copy:[start,end]}）と、走査（{scan}）の並び
 */
function parseJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail('JPEG ではありません');
  const tables = [new Array(4), new Array(4)]; // [DC, AC][番号]
  const items = [];
  let frame = null;
  let restartInterval = 0;
  let pos = 2;
  for (;;) {
    if (bytes[pos] !== 0xff) fail('区切りが見つかりません');
    while (bytes[pos] === 0xff) pos++;
    const marker = bytes[pos++];
    const start = pos - 2;
    if (marker === 0xd9) {
      items.push({ copy: [start, pos] });
      return { frame, items, trailing: bytes.subarray(pos) };
    }
    if (marker === undefined || marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      fail('区切りの並びが正しくありません');
    }
    const end = pos + u16(bytes, pos);
    if (end < pos + 2 || end > bytes.length) fail('区切りの長さが正しくありません');
    const body = bytes.subarray(pos + 2, end);
    pos = end;

    if (marker === 0xc4) {
      readTables(body, tables);
    } else if (marker === 0xc0 || marker === 0xc1) {
      if (frame) fail('画像が 2 つあります');
      frame = readFrame(body);
      items.push({ copy: [start, end] });
    } else if ((marker >= 0xc2 && marker <= 0xcf) || marker === 0xdc || marker === 0xde || marker === 0xdf) {
      // プログレッシブ・可逆・算術符号・階層・行数を後で書く形。
      fail('ハフマン符号の順次の JPEG ではありません');
    } else if (marker === 0xdd) {
      if (body.length !== 2) fail('リスタートの間隔が正しくありません');
      restartInterval = u16(body, 0);
      items.push({ copy: [start, end] });
    } else if (marker === 0xda) {
      if (!frame) fail('画像の情報より前に走査があります');
      const scan = readScanHeader(body, frame, tables);
      scan.restartInterval = restartInterval;
      scan.header = [start, end];
      scan.data = [end, scanEnd(bytes, end)];
      pos = scan.data[1];
      items.push({ scan });
    } else {
      items.push({ copy: [start, end] });
    }
  }
}

/** 符号の表の区切り（DHT）を読む（1 つの区切りに何個あってもよい）。 */
function readTables(body, tables) {
  let at = 0;
  while (at < body.length) {
    const kind = body[at] >> 4;
    const slot = body[at] & 15;
    if (kind > 1 || slot > 3) fail('符号の表の番号が正しくありません');
    const counts = body.subarray(at + 1, at + 17);
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (at + 17 + total > body.length) fail('符号の表が途中で切れています');
    tables[kind][slot] = decodingTable(counts, body.subarray(at + 17, at + 17 + total));
    at += 17 + total;
  }
}

/** 画像の情報の区切り（SOF0・SOF1）を読む。 */
function readFrame(body) {
  const count = body[5];
  if (body.length !== 6 + 3 * count || count === 0) fail('画像の情報が正しくありません');
  const height = u16(body, 1);
  const width = u16(body, 3);
  if (!height || !width) fail('画像の大きさが分かりません');
  const components = [];
  for (let i = 0; i < count; i++) {
    const h = body[7 + 3 * i] >> 4;
    const v = body[7 + 3 * i] & 15;
    if (!h || !v || h > 4 || v > 4) fail('色の間引き方が正しくありません');
    components.push({ id: body[6 + 3 * i], h, v });
  }
  const hmax = Math.max(...components.map((c) => c.h));
  const vmax = Math.max(...components.map((c) => c.v));
  for (const c of components) {
    // 1 色だけの走査で並ぶブロックの数（その色の大きさを 8 で割って切り上げ）。
    c.blocksWide = Math.ceil(Math.ceil((width * c.h) / hmax) / 8);
    c.blocksHigh = Math.ceil(Math.ceil((height * c.v) / vmax) / 8);
  }
  return {
    width,
    height,
    components,
    mcusWide: Math.ceil(width / (8 * hmax)),
    mcusHigh: Math.ceil(height / (8 * vmax)),
  };
}

/** 走査の頭（SOS）を読む。使う表は、この時点で決まっているもの。 */
function readScanHeader(body, frame, tables) {
  const count = body[0];
  if (count < 1 || count > 4 || body.length !== 4 + 2 * count) fail('走査の頭が正しくありません');
  const components = [];
  for (let i = 0; i < count; i++) {
    const component = frame.components.find((c) => c.id === body[1 + 2 * i]);
    const dcSlot = body[2 + 2 * i] >> 4;
    const acSlot = body[2 + 2 * i] & 15;
    if (!component || components.some((c) => c.component === component)) fail('走査の色が正しくありません');
    const dc = tables[0][dcSlot];
    const ac = tables[1][acSlot];
    if (!dc || !ac) fail('走査が使う符号の表がありません');
    components.push({ component, dcSlot, acSlot, dc, ac });
  }
  const at = 1 + 2 * count;
  if (body[at] !== 0 || body[at + 1] !== 63 || body[at + 2] !== 0) fail('順次の走査ではありません');
  return { components };
}

/**
 * 走査の中身（係数の符号）の終わり（次の区切りの 0xFF の位置）。リスタートの
 * 区切り（RSTn。前に埋め草の 0xFF が並んでいてもよい）は、中身の一部として進む。
 */
function scanEnd(bytes, from) {
  for (let i = from; i < bytes.length - 1; i++) {
    if (bytes[i] !== 0xff || bytes[i + 1] === 0x00) continue;
    let next = i + 1;
    while (bytes[next] === 0xff) next++;
    if (bytes[next] >= 0xd0 && bytes[next] <= 0xd7) i = next;
    else return i;
  }
  return fail('走査の終わりが見つかりません');
}

/** 係数の符号をビットずつ読む。0xFF の後の 0x00 を飛ばし、区切りの手前で止まる。 */
class BitReader {
  constructor(bytes, [start, end]) {
    this.bytes = bytes;
    this.pos = start;
    this.end = end;
    this.buffer = 0;
    this.bits = 0;
    // 区切りより先を読もうとしたときに足した 0 のビットの数（読んではいけない）。
    this.padding = 0;
  }

  fill() {
    while (this.bits <= 24) {
      let byte = 0;
      if (this.pos < this.end && this.bytes[this.pos] !== 0xff) {
        byte = this.bytes[this.pos++];
      } else if (this.pos < this.end && this.bytes[this.pos + 1] === 0x00) {
        byte = 0xff;
        this.pos += 2;
      } else {
        this.padding += 8;
      }
      this.buffer = (this.buffer << 8) | byte;
      this.bits += 8;
    }
  }

  peek(count) {
    return (this.buffer >>> (this.bits - count)) & ((1 << count) - 1);
  }

  skip(count) {
    this.bits -= count;
    if (this.bits < this.padding) fail('係数の符号が途中で切れています');
  }

  /** 記号を 1 つ読む。 */
  decode(table) {
    if (this.bits < 16) this.fill();
    const hit = table.lookup[this.peek(LOOKUP_BITS)];
    if (hit) {
      this.skip(hit >> 8);
      return hit & 0xff;
    }
    const code = this.peek(16);
    for (let length = LOOKUP_BITS + 1; length <= 16; length++) {
      const value = code >>> (16 - length);
      if (value <= table.maxcode[length]) {
        this.skip(length);
        return table.symbols[table.offset[length] + value];
      }
    }
    return fail('表に無い符号があります');
  }

  /** 係数の値のビットを読む（0〜15 ビット）。 */
  bitsOf(count) {
    if (this.bits < count) this.fill();
    const value = this.peek(count);
    this.skip(count);
    return value;
  }

  /** 読み残し（バイトの区切りまでの埋め草）を捨てる。 */
  align() {
    this.fill();
    if (this.bits - this.padding >= 8) fail('係数の符号の後ろに余りがあります');
    this.bits = 0;
    this.padding = 0;
  }

  /** リスタートの区切り（RSTn）を読む。 */
  restart(number) {
    this.align();
    // 区切りの前の埋め草（0xFF の並び）は読み飛ばす。
    while (this.bytes[this.pos] === 0xff && this.bytes[this.pos + 1] === 0xff) this.pos++;
    if (this.bytes[this.pos] !== 0xff || this.bytes[this.pos + 1] !== 0xd0 + (number % 8)) {
      fail('リスタートの区切りが見つかりません');
    }
    this.pos += 2;
  }

  /** 走査の終わり。読み残しが埋め草だけであることを確かめる。 */
  finish() {
    this.align();
    if (this.pos !== this.end) fail('係数の符号の後ろに余りがあります');
  }
}

/** 係数の符号をビットずつ書く。0xFF の後には 0x00 を挟む。 */
class BitWriter {
  constructor(capacity) {
    this.out = new Uint8Array(Math.max(capacity, 64));
    this.length = 0;
    this.buffer = 0;
    this.bits = 0;
  }

  byte(value) {
    if (this.length === this.out.length) {
      const grown = new Uint8Array(this.out.length * 2);
      grown.set(this.out);
      this.out = grown;
    }
    this.out[this.length++] = value;
  }

  put(code, size) {
    this.buffer = (this.buffer << size) | code;
    this.bits += size;
    while (this.bits >= 8) {
      const value = (this.buffer >>> (this.bits - 8)) & 0xff;
      this.byte(value);
      if (value === 0xff) this.byte(0x00);
      this.bits -= 8;
    }
  }

  /** 記号の符号と、続く係数の値のビットを書く。 */
  symbol(table, symbol, extra, extraBits) {
    this.put(table.codes[symbol], table.sizes[symbol]);
    this.put(extra, extraBits);
  }

  /** バイトの区切りまで 1 で埋める。 */
  align() {
    if (this.bits) this.put((1 << (8 - this.bits)) - 1, 8 - this.bits);
  }

  restart(number) {
    this.align();
    this.byte(0xff);
    this.byte(0xd0 + (number % 8));
  }

  bytes() {
    this.align();
    return this.out.subarray(0, this.length);
  }
}

/**
 * ブロックを 1 つ読み、記号と係数の値のビットを symbols・extras の at から入れる。
 * @returns {number} 記号の数
 */
function readBlock(reader, dc, ac, symbols, extras, at) {
  const size = reader.decode(dc);
  if (size > 15) fail('DC の記号が正しくありません');
  symbols[at] = size;
  extras[at] = reader.bitsOf(size);
  let n = 1;
  for (let k = 1; k < 64; ) {
    const symbol = reader.decode(ac);
    const bits = symbol & 15;
    symbols[at + n] = symbol;
    extras[at + n++] = reader.bitsOf(bits);
    if (bits) {
      k += (symbol >> 4) + 1;
    } else if (symbol === 0xf0) {
      k += 16;
    } else {
      break; // ブロックの終わり（EOB）
    }
    if (k > 64) fail('ブロックの係数が多すぎます');
  }
  return n;
}

/**
 * 走査のブロックを、書かれている順にたどる。
 *
 * 1 色だけの走査はその色のブロックを左上から 1 つずつ、何色かを混ぜた走査は
 * MCU（色ごとに h×v 個のブロック）ずつ並ぶ。リスタートの間隔は、その単位で数える。
 */
function forEachBlock(frame, scan, onRestart, onBlock) {
  const single = scan.components.length === 1;
  const units = single
    ? scan.components[0].component.blocksWide * scan.components[0].component.blocksHigh
    : frame.mcusWide * frame.mcusHigh;
  const interval = scan.restartInterval;
  let restarts = 0;
  let index = 0;
  for (let unit = 0; unit < units; unit++) {
    if (interval && unit && unit % interval === 0) onRestart(restarts++);
    for (const slot of scan.components) {
      const blocks = single ? 1 : slot.component.h * slot.component.v;
      for (let b = 0; b < blocks; b++) onBlock(slot, index++);
    }
  }
}

/** 走査のブロックの数。 */
function blockCount(frame, scan) {
  if (scan.components.length === 1) {
    const { component } = scan.components[0];
    return component.blocksWide * component.blocksHigh;
  }
  const perMcu = scan.components.reduce((sum, slot) => sum + slot.component.h * slot.component.v, 0);
  return frame.mcusWide * frame.mcusHigh * perMcu;
}

/** 走査で使う表の番号（DC・AC ごと、重なりなし）。 */
function slotsOf(scan, key) {
  return [...new Set(scan.components.map((slot) => slot[key]))].sort((a, b) => a - b);
}

/**
 * 走査の記号をすべて読んで覚え、表ごとに記号を数える（書き直しと確かめでは、
 * 元の JPEG を読み直さずに、覚えた記号を使う）。
 */
function readScan(bytes, frame, scan) {
  const dc = [0, 1, 2, 3].map(() => new Int32Array(256));
  const ac = [0, 1, 2, 3].map(() => new Int32Array(256));
  const lengths = new Uint8Array(blockCount(frame, scan));
  // 記号は、だいたい 1 バイトに 1 つより少ない。足りなくなったら広げる。
  let symbols = new Uint8Array(scan.data[1] - scan.data[0] + BLOCK_SYMBOLS);
  let extras = new Uint16Array(symbols.length);
  let at = 0;
  const reader = new BitReader(bytes, scan.data);
  forEachBlock(
    frame,
    scan,
    (number) => reader.restart(number),
    (slot, index) => {
      if (at + BLOCK_SYMBOLS > symbols.length) {
        const grownSymbols = new Uint8Array(symbols.length * 2);
        const grownExtras = new Uint16Array(symbols.length * 2);
        grownSymbols.set(symbols);
        grownExtras.set(extras);
        symbols = grownSymbols;
        extras = grownExtras;
      }
      const n = readBlock(reader, slot.dc, slot.ac, symbols, extras, at);
      lengths[index] = n;
      dc[slot.dcSlot][symbols[at]]++;
      for (let i = 1; i < n; i++) ac[slot.acSlot][symbols[at + i]]++;
      at += n;
    }
  );
  reader.finish();
  return {
    symbols: symbols.subarray(0, at),
    extras: extras.subarray(0, at),
    lengths,
    frequencies: { dc, ac },
  };
}

/** 走査で使う表ごとに、数えた記号から最適な表を作る。 */
function optimalTables(scan, { dc, ac }) {
  return {
    dc: new Map(slotsOf(scan, 'dcSlot').map((slot) => [slot, optimalTable(dc[slot])])),
    ac: new Map(slotsOf(scan, 'acSlot').map((slot) => [slot, optimalTable(ac[slot])])),
  };
}

/** 符号の表の区切り（DHT）を作る。 */
function tableSegment(tables) {
  const entries = [
    ...[...tables.dc].map(([slot, table]) => [slot, table]),
    ...[...tables.ac].map(([slot, table]) => [0x10 | slot, table]),
  ];
  const length = 2 + entries.reduce((sum, [, table]) => sum + 17 + table.symbols.length, 0);
  const segment = new Uint8Array(2 + length);
  segment.set([0xff, 0xc4, length >> 8, length & 0xff]);
  let at = 4;
  for (const [id, table] of entries) {
    segment[at] = id;
    segment.set(table.counts, at + 1);
    segment.set(table.symbols, at + 17);
    at += 17 + table.symbols.length;
  }
  return segment;
}

/** 覚えた記号を、新しい表で書く。 */
function writeScan(frame, scan, record, tables, size) {
  const { symbols, extras, lengths } = record;
  const dc = new Map([...tables.dc].map(([slot, table]) => [slot, encodingTable(table)]));
  const ac = new Map([...tables.ac].map(([slot, table]) => [slot, encodingTable(table)]));
  const writer = new BitWriter(size);
  let at = 0;
  forEachBlock(
    frame,
    scan,
    (number) => writer.restart(number),
    (slot, index) => {
      const dcCodes = dc.get(slot.dcSlot);
      const acCodes = ac.get(slot.acSlot);
      writer.symbol(dcCodes, symbols[at], extras[at], symbols[at]);
      const end = at + lengths[index];
      for (let i = at + 1; i < end; i++) writer.symbol(acCodes, symbols[i], extras[i], symbols[i] & 15);
      at = end;
    }
  );
  return writer.bytes();
}

/** JPEG を読み、走査ごとに記号を覚える。 */
function decodeJpeg(bytes) {
  const parsed = parseJpeg(bytes);
  const records = parsed.items.filter((item) => item.scan).map(({ scan }) => readScan(bytes, parsed.frame, scan));
  return { parsed, records };
}

function sameArray(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 覚えた記号と係数の値が、走査ごとに 1 つ残らず同じか。 */
function sameRecords(a, b) {
  return (
    a.length === b.length &&
    a.every(
      (record, i) =>
        sameArray(record.lengths, b[i].lengths) &&
        sameArray(record.symbols, b[i].symbols) &&
        sameArray(record.extras, b[i].extras)
    )
  );
}

/**
 * 2 つの JPEG の係数が同じか（どちらも読めることが前提。読めなければ投げる）。
 * 係数が同じなら、展開した画素も同じになる。
 */
export function sameCoefficients(a, b) {
  return sameRecords(decodeJpeg(a).records, decodeJpeg(b).records);
}

/**
 * JPEG の符号の表を、その画像に合わせて作り直す。扱えない形・壊れたデータは投げる。
 *
 * 書き直した JPEG は、書いた表の区切りから読み直し、記号と係数の値が元と
 * 1 つ残らず同じことを確かめてから返す。
 *
 * @param {Uint8Array} bytes JPEG
 * @returns {Uint8Array} 書き直した JPEG（元より小さいとは限らない）
 */
export function rewriteJpeg(bytes) {
  const { parsed, records } = decodeJpeg(bytes);
  const parts = [];
  let scanIndex = 0;
  for (const item of parsed.items) {
    if (item.copy) {
      parts.push(bytes.subarray(...item.copy));
      continue;
    }
    const { scan } = item;
    const record = records[scanIndex++];
    const tables = optimalTables(scan, record.frequencies);
    parts.push(
      tableSegment(tables),
      bytes.subarray(...scan.header),
      writeScan(parsed.frame, scan, record, tables, scan.data[1] - scan.data[0])
    );
  }
  parts.push(parsed.trailing);

  const out = new Uint8Array(2 + parts.reduce((sum, part) => sum + part.length, 0));
  out.set([0xff, 0xd8]);
  let at = 2;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  // 書き直しの手順に誤りがあっても、違う画像を PDF に入れないための確かめ。
  if (!sameRecords(records, decodeJpeg(out).records)) fail('書き直すと係数が変わりました');
  return out;
}

/**
 * JPEG の符号の表を作り直す。
 *
 * @param {Uint8Array} bytes JPEG（PDF の DCTDecode の画像の中身）
 * @returns {Uint8Array|null} 書き直した JPEG。扱えない・確かめられない・
 *   小さくならないときは null（元のまま使う）
 */
export function optimizeJpeg(bytes) {
  try {
    const out = rewriteJpeg(bytes);
    return out.length < bytes.length ? out : null;
  } catch {
    // 扱えない形・壊れたデータ。書き直しは結合を止めるほどのことではないので、
    // 元のまま使う。
    return null;
  }
}
