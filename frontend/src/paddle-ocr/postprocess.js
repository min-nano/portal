// PaddleOCR のモデルの出力を、文字のかたまりと文字列にする（DOM 非依存）。
//
// 数値（しきい値・広げ方）は PaddleOCR / RapidOCR の既定に合わせてある。
// 文字のかたまりの向きは、OpenCV の minAreaRect（輪郭を囲む最小の長方形）の
// 代わりに、つながった画素の広がりの主軸（2 次のモーメント）から求める。
// 文字の行は細長いので主軸がそのまま行の向きになり、OpenCV を配らずに済む。

/** det のモデルに渡す画像の長いほうの辺の上限（px）。 */
export const DET_LIMIT = 1600;

/** rec のモデルが受け取る画像の高さ（px）。 */
export const REC_HEIGHT = 48;

/** rec のモデルに渡す画像の最小の横幅（px。PaddleOCR の既定 [3, 48, 320]）。 */
export const REC_MIN_WIDTH = 320;

/**
 * det のモデルに渡す大きさ。長いほうの辺を DET_LIMIT までに縮め、
 * 縦横とも 32 の倍数にする（モデルの決まり）。
 *
 * @param {number} width
 * @param {number} height
 * @param {number} [limit]
 * @return {{width:number, height:number}}
 */
export function detInputSize(width, height, limit = DET_LIMIT) {
  const longer = Math.max(width, height);
  const ratio = longer > limit ? limit / longer : 1;
  return {
    width: Math.max(32, Math.round((width * ratio) / 32) * 32),
    height: Math.max(32, Math.round((height * ratio) / 32) * 32),
  };
}

/**
 * つながった画素の広がりの主軸の傾き（ラジアン。−45°〜45°に収める）。
 *
 * 細長くないもの（主軸の向きの広がりが、直交する向きの 2 倍に満たない。
 * 1 文字だけのかたまりなど）は、向きが当てにならないので傾けない（0）。
 * 主軸が縦に近いもの（縦書きの行）は 90° 回した向きを返す。長方形としては
 * 同じで、縦に長い長方形になる（読むときに回す。readingQuad）。
 */
export function principalAngle(cxx, cyy, cxy) {
  const half = (cxx - cyy) / 2;
  const root = Math.sqrt(half * half + cxy * cxy);
  const mean = (cxx + cyy) / 2;
  if (mean + root < 2 * (mean - root)) return 0;
  let angle = Math.atan2(2 * cxy, cxx - cyy) / 2;
  if (angle > Math.PI / 4) angle -= Math.PI / 2;
  if (angle < -Math.PI / 4) angle += Math.PI / 2;
  return angle;
}

/**
 * det の出力（文字らしさの地図）から、文字のかたまりを囲む長方形を拾う。
 *
 * 地図をしきい値で白黒にし、2×2 で太らせてから、つながった画素ごとに
 * 囲む。つながった画素の文字らしさの平均が低いものは捨て、残りは文字の
 * 向きに沿った長方形で囲んで、大きさに応じて外へ広げる（モデルは文字の芯
 * だけを小さめに塗るため。PaddleOCR の unclip と同じ広げ幅 = 面積 × 比 / 周の長さ）。
 *
 * 写真が傾いていても、文字の向きに沿って囲むので、隣の行が切り出しに
 * 入り込まない（縦横にそろえた長方形で囲むと、傾いた行の上下の行まで入り、
 * 読み違える）。
 *
 * @param {Float32Array} map 0〜1 の文字らしさ（width × height）
 * @param {number} width
 * @param {number} height
 * @param {{scaleX?:number, scaleY?:number, imageWidth?:number, imageHeight?:number,
 *   thresh?:number, boxThresh?:number, unclipRatio?:number}} [options]
 *   scaleX・scaleY は地図の 1 画素が元の画像の何画素にあたるか。
 * @return {{quad: import('./image-ops.js').Quad, x0:number, y0:number, x1:number, y1:number,
 *   score:number}[]}
 *   quad は文字の向きに沿った四隅、x0〜y1 はそれを囲む縦横にそろった範囲
 *   （どちらも元の画像の座標）。
 */
export function detectBoxes(map, width, height, options = {}) {
  const {
    scaleX = 1,
    scaleY = 1,
    imageWidth = Math.round(width * scaleX),
    imageHeight = Math.round(height * scaleY),
    thresh = 0.3,
    boxThresh = 0.5,
    unclipRatio = 1.6,
  } = options;

  // しきい値で白黒にし、2×2 で太らせる（cv2.dilate と同じく、右下の隣へ広げる）。
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (map[i] <= thresh) continue;
      mask[i] = 1;
      if (x + 1 < width) mask[i + 1] = 1;
      if (y + 1 < height) mask[i + width] = 1;
      if (x + 1 < width && y + 1 < height) mask[i + width + 1] = 1;
    }
  }

  const boxes = [];
  const stack = new Int32Array(width * height);
  const members = new Int32Array(width * height);
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1) continue;
    // つながった画素（斜めも含む）を塗りつぶしながら集め、広がりを測る。
    let top = 0;
    let count = 0;
    stack[top++] = start;
    mask[start] = 2;
    let sum = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    while (top > 0) {
      const i = stack[--top];
      members[count++] = i;
      sum += map[i];
      const x = i % width;
      const y = (i - x) / width;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const j = ny * width + nx;
          if (mask[j] !== 1) continue;
          mask[j] = 2;
          stack[top++] = j;
        }
      }
    }
    const score = sum / count;
    if (score < boxThresh) continue;

    const mx = sx / count;
    const my = sy / count;
    const angle = principalAngle(sxx / count - mx * mx, syy / count - my * my, sxy / count - mx * my);
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    // 文字の向き（u）と、それに直交する下向き（v = (−uy, ux)）に投影した広がり。
    // 画素は中心から ±0.5 の正方形なので、両端を 0.5 ずつ足す。
    let s0 = Infinity;
    let s1 = -Infinity;
    let t0 = Infinity;
    let t1 = -Infinity;
    for (let k = 0; k < count; k++) {
      const i = members[k];
      const x = (i % width) + 0.5;
      const y = Math.floor(i / width) + 0.5;
      const s = x * ux + y * uy;
      const t = -x * uy + y * ux;
      if (s < s0) s0 = s;
      if (s > s1) s1 = s;
      if (t < t0) t0 = t;
      if (t > t1) t1 = t;
    }
    const boxWidth = s1 - s0 + 1;
    const boxHeight = t1 - t0 + 1;
    if (Math.min(boxWidth, boxHeight) < 3) continue;

    const distance = (boxWidth * boxHeight * unclipRatio) / (2 * (boxWidth + boxHeight));
    const corner = (s, t) => ({ x: (s * ux - t * uy) * scaleX, y: (s * uy + t * ux) * scaleY });
    const quad = [
      corner(s0 - 0.5 - distance, t0 - 0.5 - distance),
      corner(s1 + 0.5 + distance, t0 - 0.5 - distance),
      corner(s1 + 0.5 + distance, t1 + 0.5 + distance),
      corner(s0 - 0.5 - distance, t1 + 0.5 + distance),
    ];
    const xs = quad.map((p) => p.x);
    const ys = quad.map((p) => p.y);
    boxes.push({
      quad,
      x0: clamp(Math.round(Math.min(...xs)), 0, imageWidth),
      y0: clamp(Math.round(Math.min(...ys)), 0, imageHeight),
      x1: clamp(Math.round(Math.max(...xs)), 0, imageWidth),
      y1: clamp(Math.round(Math.max(...ys)), 0, imageHeight),
      score,
    });
  }
  return boxes;
}

/** 2 点の間の長さ。 */
function distanceBetween(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * 読む向きにそろえた四隅。縦長のかたまり（縦書きの文字。PaddleOCR と同じく、
 * 高さが幅の 1.5 倍以上）は、反時計回りに 90° 回して横書きの 1 行にする
 * （上の文字が左に来る）。
 *
 * @param {import('./image-ops.js').Quad} quad
 * @return {{quad: import('./image-ops.js').Quad, width:number, height:number}}
 */
export function readingQuad(quad) {
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;
  const width = distanceBetween(topLeft, topRight);
  const height = distanceBetween(topLeft, bottomLeft);
  if (height < 1.5 * width) return { quad, width, height };
  return { quad: [topRight, bottomRight, bottomLeft, topLeft], width: height, height: width };
}

/**
 * rec のモデルに渡す横幅。高さを REC_HEIGHT にそろえたときの幅（drawWidth）と、
 * 右側を詰め物で埋めた全体の幅（tensorWidth）。
 *
 * @param {number} width 切り出す範囲の幅（readingQuad の width）
 * @param {number} height 同じく高さ
 * @return {{drawWidth:number, tensorWidth:number}}
 */
export function recInputWidth(width, height) {
  const drawWidth = Math.max(1, Math.ceil((REC_HEIGHT * width) / height));
  return { drawWidth, tensorWidth: Math.max(REC_MIN_WIDTH, drawWidth) };
}

/**
 * 文字の一覧（辞書）を読む。1 行に 1 文字。
 *
 * モデルの出力の 0 番は「文字なし」（CTC の空白）で、辞書の 1 文字目が 1 番に
 * あたる。空の行は文字ではないので外す（配布されている辞書には、先頭の近くに
 * 空の行が混じっているものがあり、そのまま数えると 1 文字ずつずれて読める）。
 * 最後の行の半角スペースは、PaddleOCR が辞書の後ろに足す空白の文字にあたるので残す。
 *
 * @param {string} text
 * @return {string[]}
 */
export function parseDictionary(text) {
  return text.split(/\r?\n/).filter((line) => line !== '');
}

/**
 * rec の出力（時刻ごとの各文字の確からしさ）を、文字列にする（CTC の貪欲な読み方）。
 * 時刻ごとにいちばん確からしい文字を選び、「文字なし」と、直前と同じ文字の
 * 続きを外す。確からしさは、残した文字の確からしさの平均。
 *
 * @param {Float32Array} probs steps × classes
 * @param {number} steps
 * @param {number} classes
 * @param {string[]} chars parseDictionary の結果（classes − 1 文字）
 * @return {{text:string, score:number}}
 */
export function ctcDecode(probs, steps, classes, chars) {
  let text = '';
  let sum = 0;
  let count = 0;
  let previous = 0;
  for (let t = 0; t < steps; t++) {
    const offset = t * classes;
    let best = 0;
    for (let c = 1; c < classes; c++) {
      if (probs[offset + c] > probs[offset + best]) best = c;
    }
    if (best !== 0 && best !== previous) {
      text += chars[best - 1];
      sum += probs[offset + best];
      count++;
    }
    previous = best;
  }
  return { text, score: count === 0 ? 0 : sum / count };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
