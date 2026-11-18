// スキャン画像の検査（1 頁ぶんの測定と、頁どうしの見比べ）。
//
// スキャンの失敗は、1 頁だけを見ても分かりにくい。紙が斜めに送られた・
// 束がずれて置かれた・ガラスの汚れで縦にすじが入った、といった失敗は、
// **同じ本の他の頁と比べて違う**ことで初めて目立つ。そこで、
//
//   1. 頁ごとに、白黒にした縮小画像から「傾き・中身の位置・すじ・白紙」を測る
//   2. 本文の頁どうしで中央値と比べ、外れている頁に印を付ける
//
// の 2 段にしてある。どちらも画素の配列だけを相手にする（canvas にも
// pdf.js にも触らない）ので、合成した画像でテストできる。

/** 画素が「黒い（インクがある）」とみなす明るさ（これ以下）の、さらに上限。 */
const MAX_THRESHOLD = 170;

/** 頁の縁の、スキャナーの影や裁断の跡が出やすい帯（割合）。測定から外す。 */
const EDGE = 0.02;

/**
 * 明るさの分布から、インクと紙を分ける境目を決める（大津の方法）。
 * 境目の値そのものはインクの側に入る（境目以下がインク）。
 *
 * 白紙に近い頁では分布に山が 1 つしか無く、境目が紙の明るさの中に入って
 * しまうので、上限を設けて紙のむらをインクと数えないようにする。
 *
 * @param {Uint8Array} gray
 */
export function otsuThreshold(gray) {
  const histogram = new Float64Array(256);
  // 明るさは 0〜255。& 0xff で、必ずその範囲の添字にする。
  for (let i = 0; i < gray.length; i++) histogram[gray[i] & 0xff]++;
  const total = gray.length;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * histogram[v];

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let threshold = 128;
  for (let v = 0; v < 256; v++) {
    weightBackground += histogram[v];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += v * histogram[v];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const between = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (between > best) {
      best = between;
      threshold = v;
    }
  }
  return Math.min(threshold, MAX_THRESHOLD);
}

/**
 * 傾きを測る。
 *
 * 文字の行（横書き）や列（縦書き）は、傾きを正しく打ち消す向きから見たときに
 * いちばんくっきり並ぶ。点の集まりを角度を変えながら投影し、行（列）ごとの
 * 点の数のばらつき（2 乗の和）がいちばん大きくなる角度を探す。縦書きの本も
 * 多いので、横向きと縦向きの両方を試して、くっきりした方を採る。
 *
 * 角度は「画面上で時計回りに傾いている」を正とする（度）。
 *
 * @param {{x:Int32Array,y:Int32Array,length:number}} points インクのある画素
 * @returns {{angle:number, sharpness:number, direction:'horizontal'|'vertical'}}
 *   sharpness は「いちばんくっきりした角度」と「いちばんぼやけた角度」の比。
 *   文字の並びが無い頁（写真・図）では 1 に近くなり、傾きは当てにならない。
 */
export function estimateSkew(points, { range = 4, coarse = 0.25, fine = 0.05 } = {}) {
  if (points.length < 200) return { angle: 0, sharpness: 1, direction: 'horizontal' };

  // 投影した位置ごとの点の数は、配列で数える（角度ごとに数十回数え直すので、
  // Map だと 1 頁で 100ms を超える）。位置は -（幅 + 高さ）〜（幅 + 高さ）に収まる。
  let extent = 1;
  for (let i = 0; i < points.length; i++) extent = Math.max(extent, points.x[i] + points.y[i] + 2);
  const bins = new Int32Array(2 * extent + 1);

  const profileScore = (degrees, vertical) => {
    const theta = (degrees * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    bins.fill(0);
    let low = bins.length;
    let high = 0;
    for (let i = 0; i < points.length; i++) {
      const x = points.x[i];
      const y = points.y[i];
      const key = Math.round(vertical ? x * cos + y * sin : y * cos - x * sin) + extent;
      bins[key]++;
      if (key < low) low = key;
      if (key > high) high = key;
    }
    let score = 0;
    for (let k = low; k <= high; k++) score += bins[k] * bins[k];
    return score;
  };

  const search = (vertical) => {
    let best = { angle: 0, score: -1 };
    let worst = Infinity;
    for (let a = -range; a <= range + 1e-9; a += coarse) {
      const score = profileScore(a, vertical);
      if (score > best.score) best = { angle: a, score };
      worst = Math.min(worst, score);
    }
    const center = best.angle;
    for (let a = center - coarse; a <= center + coarse + 1e-9; a += fine) {
      const score = profileScore(a, vertical);
      if (score > best.score) best = { angle: a, score };
    }
    return { angle: best.angle, sharpness: worst > 0 ? best.score / worst : 1 };
  };

  const horizontal = search(false);
  const vertical = search(true);
  const pick =
    vertical.sharpness > horizontal.sharpness
      ? { ...vertical, direction: 'vertical' }
      : { ...horizontal, direction: 'horizontal' };
  return { ...pick, angle: Math.round(pick.angle * 100) / 100 };
}

/**
 * 1 頁ぶんの画像を測る。
 *
 * @param {{width:number, height:number, gray:Uint8Array}} image 縮小した白黒画像
 * @returns {{
 *   inkRatio:number, blank:boolean,
 *   box:{left:number,top:number,right:number,bottom:number}|null,
 *   skew:{angle:number,sharpness:number,direction:string},
 *   streaks:number,
 *   print:Int8Array|null,
 * }} box は中身（インクのある範囲）で、頁の幅・高さを 1 とした割合。
 *   print は同じ頁が 2 度入っていないかを見比べるための指紋（imagePrint。白紙に
 *   近い頁は null）。
 */
export function measurePage({ width, height, gray }) {
  const threshold = otsuThreshold(gray);
  const x0 = Math.floor(width * EDGE);
  const x1 = Math.ceil(width * (1 - EDGE));
  const y0 = Math.floor(height * EDGE);
  const y1 = Math.ceil(height * (1 - EDGE));

  const rowInk = new Uint32Array(height);
  const colInk = new Uint32Array(width);
  // 縦・横のすじは頁の端から端まで通るので、縁の帯も含めて数える。
  const colFull = new Uint32Array(width);
  const rowFull = new Uint32Array(height);
  let ink = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (gray[row + x] > threshold) continue;
      colFull[x]++;
      rowFull[y]++;
      if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
      rowInk[y]++;
      colInk[x]++;
      ink++;
    }
  }

  const innerArea = Math.max(1, (x1 - x0) * (y1 - y0));
  const inkRatio = ink / innerArea;
  const blank = inkRatio < 0.002;

  const box = blank ? null : contentBox(rowInk, colInk, { width, height, x0, x1, y0, y1 });
  const points = blank ? { x: new Int32Array(0), y: new Int32Array(0), length: 0 } : samplePoints(
    { width, gray, threshold },
    box ? scaleBox(box, width, height) : { left: x0, right: x1, top: y0, bottom: y1 }
  );

  return {
    inkRatio: Math.round(inkRatio * 10000) / 10000,
    blank,
    box,
    skew: estimateSkew(points),
    streaks: countStreaks(colFull, height) + countStreaks(rowFull, width),
    print: box && inkRatio >= PRINT_MIN_INK ? imagePrint({ width, height, gray }, threshold, box) : null,
  };
}

/** 指紋のます目（横 × 縦）。 */
export const PRINT_COLUMNS = 32;
export const PRINT_ROWS = 48;
/** これよりインクの少ない頁（番号や見出しだけの頁）は、指紋を作らない（形が似やすい）。 */
const PRINT_MIN_INK = 0.005;

/**
 * 同じ頁が 2 度入っていないかを見比べるための、頁の画像の指紋。
 *
 * 中身の範囲（box）を縦横のます目に分け、ます目ごとのインクの割合を数える。
 * 範囲で切り揃えるので、置き方のずれ・わずかな拡大縮小には左右されず、
 * インクの割合で数えるので、明るさの違いにも左右されない。
 *
 * そのままでは、同じ本の頁どうしが似すぎる（文字の行の位置は、どの頁でも
 * 同じ）。そこで、行ごと・列ごとの平均を引いて、どの頁にも共通する「行の
 * 縞」を消し、頁ごとに違う形（段落の切れ目・行の長さ・図）だけを残す。
 * 最後に平均 0・ばらつき 1 にそろえ、32 倍して整数（-127〜127）にする。
 *
 * 合成した頁（本文を描いた画像を、ずらす・0.6° まで回す・明るさを変える・
 * ざらつかせる）で、同じ頁は相関 0.6 以上、違う頁は 0.2 以下だった。
 *
 * @param {{width:number, height:number, gray:Uint8Array}} image
 * @param {number} threshold これ以下の明るさをインクとみなす
 * @param {{left:number,top:number,right:number,bottom:number}} box 中身の範囲（割合）
 * @returns {Int8Array} PRINT_COLUMNS × PRINT_ROWS
 */
export function imagePrint({ width, height, gray }, threshold, box) {
  const cols = PRINT_COLUMNS;
  const rows = PRINT_ROWS;
  const { left, right, top, bottom } = scaleBox(box, width, height);
  const ink = new Float64Array(cols * rows);
  const area = new Float64Array(cols * rows);
  for (let y = top; y < bottom; y++) {
    const cy = Math.min(rows - 1, Math.floor(((y - top) * rows) / (bottom - top)));
    for (let x = left; x < right; x++) {
      const cell = cy * cols + Math.min(cols - 1, Math.floor(((x - left) * cols) / (right - left)));
      area[cell]++;
      if (gray[y * width + x] <= threshold) ink[cell]++;
    }
  }
  // 中身の範囲がます目より狭いと、画素の入らないます目がある（0 とする）。
  const values = ink.map((count, i) => count / Math.max(1, area[i]));
  for (let y = 0; y < rows; y++) {
    let sum = 0;
    for (let x = 0; x < cols; x++) sum += values[y * cols + x];
    for (let x = 0; x < cols; x++) values[y * cols + x] -= sum / cols;
  }
  for (let x = 0; x < cols; x++) {
    let sum = 0;
    for (let y = 0; y < rows; y++) sum += values[y * cols + x];
    for (let y = 0; y < rows; y++) values[y * cols + x] -= sum / rows;
  }
  // 行・列の平均を引いたので、全体の平均は 0。
  let squares = 0;
  for (const value of values) squares += value * value;
  const deviation = Math.sqrt(squares / values.length) || 1;
  return Int8Array.from(values, (value) => Math.max(-127, Math.min(127, Math.round((value / deviation) * 32))));
}

/**
 * 2 つの指紋の似かた（相関。-1〜1）。どちらかが無ければ null。
 *
 * @param {Int8Array|null} a
 * @param {Int8Array|null} b
 */
export function printSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

/** 行・列ごとのインクの量から、中身のある範囲を割合で返す。 */
function contentBox(rowInk, colInk, { width, height, x0, x1, y0, y1 }) {
  // 紙のごみ（数画素の点）を中身と数えないよう、少しだけ下限を設ける。
  const rowMin = Math.max(2, Math.round((x1 - x0) * 0.004));
  const colMin = Math.max(2, Math.round((y1 - y0) * 0.004));
  const first = (counts, from, to, min) => {
    for (let i = from; i < to; i++) if (counts[i] >= min) return i;
    return -1;
  };
  const last = (counts, from, to, min) => {
    for (let i = to - 1; i >= from; i--) if (counts[i] >= min) return i;
    return -1;
  };
  const top = first(rowInk, y0, y1, rowMin);
  const left = first(colInk, x0, x1, colMin);
  if (top < 0 || left < 0) return null;
  const round = (value) => Math.round(value * 1000) / 1000;
  return {
    left: round(left / width),
    top: round(top / height),
    right: round((last(colInk, x0, x1, colMin) + 1) / width),
    bottom: round((last(rowInk, y0, y1, rowMin) + 1) / height),
  };
}

function scaleBox(box, width, height) {
  return {
    left: Math.floor(box.left * width),
    right: Math.ceil(box.right * width),
    top: Math.floor(box.top * height),
    bottom: Math.ceil(box.bottom * height),
  };
}

/** 傾きを測るための点を、多すぎないように間引いて取り出す。 */
function samplePoints({ width, gray, threshold }, { left, right, top, bottom }, limit = 60000) {
  let count = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) if (gray[y * width + x] <= threshold) count++;
  }
  const stride = Math.max(1, Math.ceil(count / limit));
  const size = Math.ceil(count / stride);
  const xs = new Int32Array(size);
  const ys = new Int32Array(size);
  let seen = 0;
  let n = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      if (gray[y * width + x] > threshold) continue;
      if (seen++ % stride === 0 && n < size) {
        xs[n] = x;
        ys[n] = y;
        n++;
      }
    }
  }
  return { x: xs, y: ys, length: n };
}

/**
 * 端から端まで通る線（スキャナーのガラスの汚れによるすじ）を数える。
 *
 * 本文の罫線や挿絵は余白までは届かないので、頁のほぼ全長にわたって
 * インクが続く列（行）だけを数える。隣り合う列は 1 本と数える。
 */
function countStreaks(counts, length) {
  const limit = length * 0.9;
  let streaks = 0;
  let inStreak = false;
  // 頁の縁そのもの（裁断の影）はすじと数えない。
  const from = Math.floor(counts.length * EDGE);
  const to = Math.ceil(counts.length * (1 - EDGE));
  for (let i = from; i < to; i++) {
    const hit = counts[i] >= limit;
    if (hit && !inStreak) streaks++;
    inStreak = hit;
  }
  return streaks;
}

/** 数の並びの中央値。 */
export function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 検査のしきい値。画面に出す文言と揃えるため、ここに 1 つだけ置く。 */
export const LIMITS = {
  sizeRatio: 0.02, // 頁の大きさが中央値から 2% 以上違う
  skewDegrees: 0.5, // 0.5° 以上傾いている
  skewSharpness: 1.15, // これより文字の並びがぼやけた頁では傾きを当てにしない
  shift: 0.03, // 中身の位置が、同じ側の頁の中央値から 3% 以上ずれている
};

/**
 * 頁どうしを見比べて、外れている頁に印を付ける。
 *
 * 位置のずれは、**同じ側の頁（奇数頁どうし・偶数頁どうし）**で比べる。
 * 本の余白は見開きで左右対称になっているので、奇数頁と偶数頁では中身の
 * 位置が違うのが正しいため。中身の位置は頁の内容で変わる（章の終わりの
 * 頁は下が空く）ので、左右の端が**そろって**同じ向きにずれたとき、
 * 上下の端が**そろって**同じ向きにずれたときだけを「ずれ」とする。
 *
 * @param {{
 *   key:string, side:'odd'|'even'|null,
 *   size:{width:number,height:number},
 *   measure:ReturnType<typeof measurePage>|null,
 * }[]} pages 本文の頁（表紙などは含めない）
 * @returns {Map<string, {kind:string, message:string, level:'warn'|'info'}[]>}
 */
export function compareScans(pages) {
  const issues = new Map();
  const add = (key, issue) => {
    if (!issues.has(key)) issues.set(key, []);
    issues.get(key).push(issue);
  };

  const portrait = pages.filter((p) => p.size.height >= p.size.width).length;
  const mostlyPortrait = portrait * 2 >= pages.length;
  const widths = median(pages.map((p) => p.size.width));
  const heights = median(pages.map((p) => p.size.height));

  for (const page of pages) {
    const isPortrait = page.size.height >= page.size.width;
    if (isPortrait !== mostlyPortrait) {
      add(page.key, {
        kind: 'orientation',
        level: 'warn',
        message: `向きが他の頁と違います（${isPortrait ? '縦長' : '横長'}）`,
      });
    } else if (
      widths &&
      heights &&
      (Math.abs(page.size.width / widths - 1) > LIMITS.sizeRatio ||
        Math.abs(page.size.height / heights - 1) > LIMITS.sizeRatio)
    ) {
      add(page.key, {
        kind: 'size',
        level: 'warn',
        message: `大きさが他の頁と違います（${percent(page.size.width / widths)} × ${percent(page.size.height / heights)}）`,
      });
    }

    const m = page.measure;
    if (!m) continue;
    if (m.blank) {
      add(page.key, { kind: 'blank', level: 'info', message: '白紙の頁です' });
      continue;
    }
    if (m.skew.sharpness >= LIMITS.skewSharpness && Math.abs(m.skew.angle) >= LIMITS.skewDegrees) {
      add(page.key, {
        kind: 'skew',
        level: 'warn',
        message: `${Math.abs(m.skew.angle).toFixed(1)}° ${m.skew.angle > 0 ? '右' : '左'}に傾いています`,
      });
    }
    if (m.streaks > 0) {
      add(page.key, {
        kind: 'streak',
        level: 'warn',
        message: `端から端まで通るすじが ${m.streaks} 本あります（ガラスの汚れの可能性）`,
      });
    }
  }

  for (const side of ['odd', 'even']) {
    const group = pages.filter((p) => p.side === side && p.measure?.box);
    if (group.length < 3) continue;
    const ref = {};
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      ref[edge] = median(group.map((p) => p.measure.box[edge]));
    }
    for (const page of group) {
      const box = page.measure.box;
      const dx = sameDirection(box.left - ref.left, box.right - ref.right);
      const dy = sameDirection(box.top - ref.top, box.bottom - ref.bottom);
      const parts = [];
      if (Math.abs(dx) >= LIMITS.shift) parts.push(`${dx > 0 ? '右' : '左'}へ ${percent(Math.abs(dx))}`);
      if (Math.abs(dy) >= LIMITS.shift) parts.push(`${dy > 0 ? '下' : '上'}へ ${percent(Math.abs(dy))}`);
      if (parts.length) {
        add(page.key, {
          kind: 'shift',
          level: 'warn',
          message: `中身の位置が同じ側の頁からずれています（${parts.join('・')}）`,
        });
      }
    }
  }
  return issues;
}

/** 2 つの差が同じ向きなら、小さい方の大きさでその向きを返す。逆向きなら 0。 */
function sameDirection(a, b) {
  if (a > 0 && b > 0) return Math.min(a, b);
  if (a < 0 && b < 0) return Math.max(a, b);
  return 0;
}

function percent(value) {
  return `${Math.round(value * 1000) / 10}%`;
}

/**
 * RGBA の画素を白黒（明るさ）にする。
 *
 * @param {Uint8ClampedArray} rgba canvas の getImageData().data
 */
export function toGray(rgba) {
  const gray = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    gray[j] = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
  }
  return gray;
}

/**
 * 余白の帯の中から、頁番号らしい「短い文字のかたまり」を探す（OCR に渡す範囲）。
 *
 * Tesseract は、帯をまるごと渡すと、ぽつんと置かれた 1 文字（「5」）を
 * 読み落としやすい。そこで先に画素から文字のかたまりを切り出し、短いもの
 * だけを 1 つずつ読ませる。
 *
 *   1. インクのある行をまとめて「行」にする
 *   2. 行の中で、字の間より広く空いたところで区切って「かたまり」にする
 *   3. 幅が行の高さの数倍までのもの（数字 4 桁と飾りまで）だけを残す。
 *      本文や柱の和文は長くつながるので、ここで落ちる
 *
 * @param {{width:number, height:number, gray:Uint8Array}} image
 * @param {{maxBoxes?:number}} [options]
 * @returns {{x0:number, y0:number, x1:number, y1:number}[]} 画素の位置（x1・y1 は含まない）
 */
export function shortTextBoxes({ width, height, gray }, { maxBoxes = 8 } = {}) {
  const threshold = otsuThreshold(gray);
  // 帯の上から下まで通る線（ガラスの汚れのすじ）は字ではない。残しておくと、
  // 帯全体が 1 つの背の高い行になり、番号まで見落とす。
  const streak = new Uint8Array(width);
  for (let x = 0; x < width; x++) {
    let ink = 0;
    for (let y = 0; y < height; y++) if (gray[y * width + x] <= threshold) ink++;
    streak[x] = ink >= height * 0.9 ? 1 : 0;
  }
  const isInk = (x, y) => !streak[x] && gray[y * width + x] <= threshold;

  const rowInk = new Uint32Array(height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (isInk(x, y)) rowInk[y]++;
  }

  // 1. 行。1〜2 画素の切れ目（字の中の隙間）はつなげる。
  const bands = [];
  let start = -1;
  let gap = 0;
  for (let y = 0; y <= height; y++) {
    const ink = y < height && rowInk[y] > 0;
    if (ink) {
      if (start < 0) start = y;
      gap = 0;
    } else if (start >= 0 && ++gap > 2) {
      bands.push([start, y - gap + 1]);
      start = -1;
      gap = 0;
    }
  }
  if (start >= 0) bands.push([start, height]);

  const boxes = [];
  for (const [y0, y1] of bands) {
    const bandHeight = y1 - y0;
    // 紙のごみ（数画素）と、帯いっぱいの絵は相手にしない。
    if (bandHeight < 6 || bandHeight > height * 0.6) continue;

    // 2. かたまり。字の間（行の高さの 8 割まで）はつなげる。
    const colInk = new Uint8Array(width);
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < width; x++) if (isInk(x, y)) colInk[x] = 1;
    }
    const join = Math.max(2, Math.round(bandHeight * 0.8));
    let x0 = -1;
    let last = -1;
    const flush = () => {
      if (x0 < 0) return;
      const w = last + 1 - x0;
      // 3. 短いものだけ。頁の縁に触れているもの（裁断の影）は外す。
      if (w <= bandHeight * 4.5 && x0 > 0 && last < width - 1) {
        // 行の高さではなく、このかたまり自身の高さに詰める（同じ行に背の
        // 高い字があっても、ごみの点を字と取り違えないように）。
        let top = y1;
        let bottom = y0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x <= last; x++) {
            if (!isInk(x, y)) continue;
            top = Math.min(top, y);
            bottom = Math.max(bottom, y + 1);
          }
        }
        if (bottom - top >= 6) boxes.push({ x0, y0: top, x1: last + 1, y1: bottom });
      }
      x0 = -1;
    };
    for (let x = 0; x < width; x++) {
      if (!colInk[x]) continue;
      if (x0 >= 0 && x - last > join) flush();
      if (x0 < 0) x0 = x;
      last = x;
    }
    flush();
  }

  // 多すぎるときは、頁番号の置き場所（左右の端・中央）に近いものを優先する。
  const placement = (box) => {
    const center = (box.x0 + box.x1) / 2 / width;
    return Math.min(center, 1 - center, Math.abs(center - 0.5));
  };
  return boxes.sort((a, b) => placement(a) - placement(b)).slice(0, maxBoxes);
}
