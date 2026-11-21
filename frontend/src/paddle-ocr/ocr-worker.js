// 写真の文字を読む worker（client.js から使う）。
//
// PaddleOCR の PP-OCRv5（軽量版・日本語を含む多言語）を、onnxruntime-web の
// WebAssembly で動かす。モデルは文字の位置を探すもの（約 5 MB）と、文字を
// 読むもの（約 17 MB）の 2 つで、どちらも外部の CDN ではなくこのポータルから
// 配る（Vite が assets/ に置く。PDF 結合ツールの Tesseract.js と同じ考え方）。
// 1 枚読むのに数秒かかるので、画面が固まらないようここで動かす。
//
// モデルを読み込むのは最初に頼まれたときだけで、あとは使い回す。
// この worker に話しかけられるのは、作った画面だけ（専用の worker）。それでも
// 届いたものは形を確かめてから使う。

import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import detUrl from 'pdfmarkdown-ppocrv5-models/detection/PP-OCRv5_mobile_det_infer.ort?url';
import recUrl from 'pdfmarkdown-ppocrv5-models/recognition/PP-OCRv5_mobile_rec_infer.onnx?url';
import dictUrl from 'pdfmarkdown-ppocrv5-models/recognition/ppocrv5_dict.txt?url';
import { readText } from './pipeline.js';
import { parseDictionary } from './postprocess.js';

let modelsPromise = null;

/** 相対の URL を、worker の中からでも引ける絶対の URL にする。 */
function absolute(url) {
  return new URL(url, self.location.href).href;
}

async function fetchOk(url) {
  const response = await fetch(absolute(url));
  if (!response.ok) throw new Error(`読み取りのモデルを読み込めませんでした（${response.status}）。`);
  return response;
}

/** モデル 1 つを、Float32 を受けて Float32 を返す関数にする。 */
async function loadModel(url) {
  const bytes = new Uint8Array(await (await fetchOk(url)).arrayBuffer());
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  const [input] = session.inputNames;
  const [output] = session.outputNames;
  return async (data, dims) => {
    const results = await session.run({ [input]: new ort.Tensor('float32', data, dims) });
    const tensor = results[output];
    return { data: tensor.data, dims: tensor.dims };
  };
}

async function loadModels() {
  // 画面のページは別オリジンから分離されていない（crossOriginIsolated でない）
  // ので、WebAssembly のスレッドは使えない。1 本で動かすと明示する。
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = { wasm: absolute(wasmUrl) };
  const [detect, recognize, dictionary] = await Promise.all([
    loadModel(detUrl),
    loadModel(recUrl),
    fetchOk(dictUrl).then((response) => response.text()),
  ]);
  return { detect, recognize, chars: parseDictionary(dictionary) };
}

/** モデルを用意する（1 度だけ）。失敗したら、次に頼まれたときにやり直す。 */
function models() {
  modelsPromise ??= loadModels().catch((error) => {
    modelsPromise = null;
    throw error;
  });
  return modelsPromise;
}

/** 届いたものが「読む画像」の形をしていれば、その画像を返す。違えば null。 */
export function imageFrom(data) {
  const image = data?.image;
  if (!Number.isInteger(data?.id) || !image || !(image.data instanceof Uint8ClampedArray)) return null;
  const { width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (width * height * 4 !== image.data.length) return null;
  return { width, height, data: image.data };
}

self.onmessage = async (event) => {
  // 専用の worker への知らせには送り主が付かない（空）。付いていれば、この
  // 画面と同じところからのものだけを受ける。
  if (event.origin && event.origin !== self.location.origin) return;
  const { data } = event;
  const image = imageFrom(data);
  if (!image) {
    if (Number.isInteger(data?.id)) self.postMessage({ id: data.id, error: '読む画像の形が正しくありません。' });
    return;
  }
  try {
    self.postMessage({ id: data.id, items: await readText(image, await models()) });
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error?.message || error) });
  }
};
