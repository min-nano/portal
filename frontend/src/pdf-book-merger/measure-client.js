// 頁の画像を測る（image-checks.js の measurePage を、worker で動かす）。
//
// worker を使えない環境（古いブラウザ・テスト）や、worker が壊れたときは、
// 画面と同じスレッドで測る。どちらでも結果は同じ（同じ measurePage を動かす）。

import { measurePage } from './image-checks.js';

let worker = null;
let unavailable = false;
let nextId = 1;
/** id → { resolve, reject, image } */
const pending = new Map();

function giveUp() {
  unavailable = true;
  worker?.terminate();
  worker = null;
  // 待っていた分は、ここで測る（画素は渡したあとも手元に残してある）。
  for (const [id, job] of pending) {
    pending.delete(id);
    try {
      job.resolve(measurePage(job.image));
    } catch (error) {
      job.reject(error);
    }
  }
}

function measureWorker() {
  if (unavailable || typeof Worker === 'undefined') return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./measure-worker.js', import.meta.url), { type: 'module' });
    } catch {
      unavailable = true;
      return null;
    }
    worker.onmessage = ({ data }) => {
      const job = pending.get(data.id);
      if (!job) return;
      pending.delete(data.id);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data.measure);
    };
    worker.onerror = giveUp;
  }
  return worker;
}

/**
 * 頁の画像を測る。
 *
 * @param {{width:number, height:number, gray:Uint8Array}} image
 * @returns {Promise<ReturnType<typeof measurePage>>}
 */
export function measure(image) {
  const target = measureWorker();
  if (!target) return Promise.resolve().then(() => measurePage(image));
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, image });
    // 画素は渡さず写す（worker が壊れたときに、ここで測り直せるように）。
    target.postMessage({ id, image });
  });
}
