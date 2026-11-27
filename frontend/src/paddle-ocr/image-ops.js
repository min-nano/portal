// 写真の画素を、PaddleOCR のモデルに渡す形（Float32 の CHW）にする。
//
// どちらのモデル（文字の位置を探す det・文字を読む rec）も、PaddleOCR では
// OpenCV で読んだ画像（チャンネルの並びが B, G, R）を線形補間で描き直し、
// (値 / 255 − 0.5) / 0.5 に揃えたものを受け取る。ここでは OpenCV を使わず
// （ブラウザへ配ると数 MB 増える）、同じ計算を素の JS で行う。
//
// 画像は { width, height, data }（data は RGBA の並び。ImageData と同じ形）。

/**
 * @typedef {{x:number, y:number}} Point
 * @typedef {[Point, Point, Point, Point]} Quad
 *   描き出す範囲の四隅（左上・右上・右下・左下の順。画素の角の座標）。
 *   傾いた長方形でもよい。左上 → 右上の向きが、描いた画像の横の向きになる。
 */

/** 画像全体を表す四隅。 */
export function wholeImage(image) {
  const { width: w, height: h } = image;
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
}

/**
 * 四隅で囲んだ範囲を dstWidth × dstHeight に線形補間で描き直し、正規化した
 * CHW（B, G, R の順）として tensor へ書き込む。
 *
 * 範囲が画像の縦横にそろっていれば、cv2.resize（INTER_LINEAR）と同じ値になる
 * （画素の中心どうしを合わせる）。傾いた長方形なら、傾きを戻しながら描く
 * （PaddleOCR が文字のかたまりを切り出すときの透視変換にあたる）。
 *
 * tensor の横幅（stride）は dstWidth より広くてよい。書かなかった右側は
 * そのまま（0 = 正規化後の灰色）残る。rec のモデルへ渡すときの詰め物と同じ。
 *
 * @param {{width:number, height:number, data:Uint8ClampedArray}} image
 * @param {Quad} quad
 * @param {number} dstWidth
 * @param {number} dstHeight
 * @param {{tensor?:Float32Array, stride?:number}} [options]
 * @return {Float32Array}
 */
export function toTensor(image, quad, dstWidth, dstHeight, options = {}) {
  const stride = options.stride ?? dstWidth;
  const tensor = options.tensor ?? new Float32Array(3 * dstHeight * stride);
  const plane = dstHeight * stride;
  const { width, height, data } = image;
  const [topLeft, topRight, , bottomLeft] = quad;
  // 描く先の 1 画素ぶん右・下へ進んだときの、元の画像での進み方。
  const ax = (topRight.x - topLeft.x) / dstWidth;
  const ay = (topRight.y - topLeft.y) / dstWidth;
  const bx = (bottomLeft.x - topLeft.x) / dstHeight;
  const by = (bottomLeft.y - topLeft.y) / dstHeight;

  for (let dy = 0; dy < dstHeight; dy++) {
    for (let dx = 0; dx < dstWidth; dx++) {
      // 描く先の画素の中心にあたる元の画像の位置（画素の中心を整数に置く座標）。
      const px = clamp(topLeft.x + ax * (dx + 0.5) + bx * (dy + 0.5) - 0.5, 0, width - 1);
      const py = clamp(topLeft.y + ay * (dx + 0.5) + by * (dy + 0.5) - 0.5, 0, height - 1);
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      const fx = px - x0;
      const fy = py - y0;
      const out = dy * stride + dx;
      for (let c = 0; c < 3; c++) {
        // RGBA の並びから B, G, R の順に取り出す。
        const channel = 2 - c;
        const top =
          data[(y0 * width + x0) * 4 + channel] * (1 - fx) +
          data[(y0 * width + x1) * 4 + channel] * fx;
        const bottom =
          data[(y1 * width + x0) * 4 + channel] * (1 - fx) +
          data[(y1 * width + x1) * 4 + channel] * fx;
        const value = top * (1 - fy) + bottom * fy;
        tensor[c * plane + out] = (value / 255 - 0.5) / 0.5;
      }
    }
  }
  return tensor;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
