// 画像 1 枚を読む流れ（文字の位置を探す → かたまりごとに読む）。
//
// モデルを動かすところ（onnxruntime-web）は、呼び出し側（ocr-worker.js）が
// run 関数として渡す。ここは画素の受け渡しと順番だけを受け持つので、
// 偽物のモデルでテストできる。

import { toTensor, wholeImage } from './image-ops.js';
import {
  REC_HEIGHT,
  ctcDecode,
  detInputSize,
  detectBoxes,
  readingQuad,
  recInputWidth,
} from './postprocess.js';

/** これより確からしさの低い読みは捨てる（模様や線を文字として読んだもの）。 */
const MIN_SCORE = 0.5;

/**
 * @typedef {(data: Float32Array, dims: number[]) => Promise<{data: Float32Array, dims: number[]}>} RunModel
 * モデルを 1 回動かす。入力は NCHW の Float32、出力はモデルの出力そのまま。
 */

/**
 * 画像から文字を読む。
 *
 * @param {{width:number, height:number, data:Uint8ClampedArray}} image RGBA
 * @param {{detect: RunModel, recognize: RunModel, chars: string[]}} models
 * @return {Promise<{text:string, score:number, x0:number, y0:number, x1:number, y1:number}[]>}
 *   読めたかたまり（それを囲む、画像の縦横にそろった範囲）
 */
export async function readText(image, models) {
  const size = detInputSize(image.width, image.height);
  const detected = await models.detect(toTensor(image, wholeImage(image), size.width, size.height), [
    1,
    3,
    size.height,
    size.width,
  ]);
  const [, , mapHeight, mapWidth] = detected.dims;
  const boxes = detectBoxes(detected.data, mapWidth, mapHeight, {
    scaleX: image.width / mapWidth,
    scaleY: image.height / mapHeight,
    imageWidth: image.width,
    imageHeight: image.height,
  });

  const items = [];
  for (const box of boxes) {
    const reading = readingQuad(box.quad);
    const { drawWidth, tensorWidth } = recInputWidth(reading.width, reading.height);
    const tensor = toTensor(image, reading.quad, drawWidth, REC_HEIGHT, {
      tensor: new Float32Array(3 * REC_HEIGHT * tensorWidth),
      stride: tensorWidth,
    });
    const output = await models.recognize(tensor, [1, 3, REC_HEIGHT, tensorWidth]);
    const [, steps, classes] = output.dims;
    const { text, score } = ctcDecode(output.data, steps, classes, models.chars);
    if (text.trim() === '' || score < MIN_SCORE) continue;
    items.push({ text, score, x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 });
  }
  return items;
}
