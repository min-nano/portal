// 写真の文字を読む（画面の側）。読むのは ocr-worker.js。
//
// 写真はこの画面で開いて画素にし（向きは写真に記録された向きに直る）、
// 長いほうの辺を MAX_SIDE までに縮めてから worker へ渡す。スマホの写真
// （4000px 前後）をそのまま渡すと、画素だけで 50 MB 近くになるため。
// 縮めても、A4 の間取り図の小さな室名が読める大きさは残る。
//
// 写真はこの端末の中で読むだけで、どこにも送らない・残さない。

/** worker に渡す画像の長いほうの辺の上限（px）。 */
export const MAX_SIDE = 3200;

let worker = null;
let nextId = 1;
/** id → { resolve, reject } */
const pending = new Map();

function ocrWorker() {
  if (!worker) {
    if (typeof Worker === 'undefined') throw new Error('このブラウザでは写真を読み取れません。');
    worker = new Worker(new URL('./ocr-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const job = pending.get(data.id);
      if (!job) return;
      pending.delete(data.id);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data.items);
    };
    worker.onerror = () => {
      // 壊れた worker は捨て、次に頼まれたら作り直す。
      releaseReader(new Error('写真の読み取りが止まりました。もう一度お試しください。'));
    };
  }
  return worker;
}

/**
 * 写真を画素にする（長いほうの辺を MAX_SIDE までに縮める）。
 *
 * @param {Blob} file
 * @return {Promise<ImageData>}
 */
export async function imageDataOf(file) {
  let bitmap;
  try {
    // 写真に記録された向き（スマホを縦に構えて撮ったもの）に直して開く。
    // 既定の扱いがブラウザや版で違ったので、はっきり頼む。この値を知らない
    // 古いブラウザは投げるので、そのときは既定の扱いで開き直す。
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() =>
      createImageBitmap(file)
    );
  } catch {
    throw new Error('写真を開けませんでした。JPEG か PNG の画像を選んでください。');
  }
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    // iPhone の Safari は、使い終えた canvas の画素をすぐには手放さないので、
    // 大きさを 0 にして手放させる。
    canvas.width = 0;
    canvas.height = 0;
    return image;
  } finally {
    bitmap.close();
  }
}

/**
 * 写真の文字を読む。
 *
 * @param {Blob} file
 * @return {Promise<{text:string, score:number, x0:number, y0:number, x1:number, y1:number}[]>}
 *   読めた文字のかたまり（写真を縮めた後の画素の座標）
 */
export async function readImageFile(file) {
  const image = await imageDataOf(file);
  const target = ocrWorker();
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    // 画素は写さず渡す（この画面ではもう使わない）。
    target.postMessage(
      { id, image: { width: image.width, height: image.height, data: image.data } },
      [image.data.buffer]
    );
  });
}

/**
 * 読み取りを手放す（worker を止め、モデルが使っていたメモリを返す）。
 * 次に読むときは、モデルを読み込み直す（ブラウザのキャッシュから）。
 * 読んでいる途中のものは、error で失敗させる。
 */
export function releaseReader(error = new Error('写真の読み取りを止めました。')) {
  worker?.terminate();
  worker = null;
  for (const [id, job] of pending) {
    pending.delete(id);
    job.reject(error);
  }
}
