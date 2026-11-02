// 画像からの頁番号の読み取り（Tesseract.js。WebAssembly で動く OCR）。
//
// サーチャブル PDF でも、余白にぽつんと置かれた頁番号は OCR で読み落とされ
// やすい。文字情報に番号が見つからなかった頁だけ、余白の帯を画像として
// 読み直す。
//
// 読むのは英数字のモデル（約 3 MB）で、日本語のモデル（十数 MB）は使わない。
// 欲しいのは数字だけで、柱や本文の和文は、読む前に形（長くつながる）で外す。
//
// OCR の本体と言語のデータは、外部の CDN ではなくこのポータルから配る
// （Vite が assets/ に置く）。社内のネットワークで CDN が塞がれていても
// 動くようにするため。準備（読み込みと WebAssembly の翻訳）には何秒も
// かかるので、要りそうなファイルが追加された時点で読み込み始める（main.js）。

import corePath from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url';
import workerPath from 'tesseract.js/dist/worker.min.js?url';
import languageUrl from '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url';
import { shortTextBoxes, toGray } from './image-checks.js';
import { releaseCanvas } from './pdf-source.js';

/** 同時に動かす OCR の数。多くしても、頁を描く側（pdf.js）が追いつかない。 */
const WORKERS = 2;

/** これより自信の無い読み取りは捨てる（0〜100）。 */
const MIN_CONFIDENCE = 60;

let schedulerPromise = null;

/** 相対の URL を、worker の中（blob: の URL）からでも引ける絶対の URL にする。 */
function absolute(url) {
  return new URL(url, window.location.href).href;
}

/**
 * 言語のデータの置き場所（Tesseract.js の langPath）。
 *
 * Tesseract.js は「langPath + '/eng.traineddata.gz'」を取りに行く。Vite は
 * 配るファイルの名前に中身のハッシュを付ける（eng.traineddata-XXXX.gz）ので、
 * そのままでは名前が合わない。そこで、ハッシュ付きの URL の後ろに問い合わせ
 * （?file=）を付けて渡す。取りに行く URL は「…-XXXX.gz?file=/eng.traineddata.gz」
 * になり、配る側は問い合わせを見ずにハッシュ付きのファイルを返す。
 *
 * 中身をメモリで渡す方法（{ code, data }）もあるが、Tesseract.js 7.0.0 には
 * そのとき言語の名前の代わりに中身を渡してしまう不具合があり、使えない。
 */
function languagePath() {
  return `${absolute(languageUrl)}?file=`;
}

async function addWorker(Tesseract, scheduler) {
  const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
    workerPath: absolute(workerPath),
    corePath: absolute(corePath),
    langPath: languagePath(),
    // 言語のデータはブラウザのキャッシュ（/assets/ は中身が変わらない限り
    // 使い回される）に任せ、Tesseract.js 独自の保存領域には残さない。
    cacheMethod: 'none',
  });
  try {
    await worker.setParameters({
      // 渡すのは切り出した短いかたまり 1 つずつなので、1 行として読む。
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
      // 頁番号に出てくる文字だけ。和文を無理に英字として読ませない。
      tessedit_char_whitelist: '0123456789-()',
      // 描いた細かさ（帯は 1 頁 2400px で描くので、およそ 300dpi）を伝える。
      // 伝えないと、読むたびに推定してその旨を出力する。
      user_defined_dpi: '300',
    });
  } catch (error) {
    await worker.terminate().catch(() => {});
    throw error;
  }
  scheduler.addWorker(worker);
}

/**
 * OCR の worker を用意する。
 *
 * worker ごとの準備（本体の WebAssembly の読み込みと翻訳・言語のデータの展開）は
 * 重く、端末やブラウザによっては 1 つに何秒もかかる。worker はそれぞれ別の
 * スレッドで動くので、1 つずつ順に待たずに全部を同時に用意し、1 つ目が
 * 用意できたところで使い始める（頼んだ読み取りは scheduler が順番待ちに
 * 持ち、あとから加わった worker にも振り分ける）。1 つも用意できなければ、
 * 最初の失敗を返す。
 */
async function createScheduler() {
  const Tesseract = await import('tesseract.js');
  const scheduler = Tesseract.createScheduler();
  const adding = Array.from({ length: WORKERS }, () => addWorker(Tesseract, scheduler));
  await new Promise((resolve, reject) => {
    const errors = [];
    for (const promise of adding) {
      promise.then(resolve, (error) => {
        if (errors.push(error) === adding.length) reject(errors[0]);
      });
    }
  });
  return scheduler;
}

/** OCR を使えるようにしておく（初回の読み込み）。失敗したら次の呼び出しでやり直す。 */
export function prepareOcr() {
  if (!schedulerPromise) {
    schedulerPromise = createScheduler().catch((error) => {
      schedulerPromise = null;
      throw error;
    });
  }
  return schedulerPromise;
}

// 1 つのかたまりを読む字の高さ（px）。1 文字だけの「1」「9」は、大きさに
// よって読めたり読めなかったりする（Tesseract は 1 文字の行が苦手）ので、
// 3 通りの大きさで読んで多数決にする。
const READ_HEIGHTS = [34, 20, 54];

/** 頁番号として意味のある読み（数字を含み、数字と飾りだけ）。 */
const NUMERIC = /^[-()]*\d[-()\d]*$/;

/**
 * かたまりを、周りに字の高さぶんの白い余白を付けて、指定の字の高さで描き出す。
 */
function cropOf(canvas, box, height) {
  const h = box.y1 - box.y0;
  const scale = height / h;
  const crop = document.createElement('canvas');
  crop.width = Math.max(1, Math.round((box.x1 - box.x0 + 2 * h) * scale));
  crop.height = Math.max(1, Math.round(3 * h * scale));
  const context = crop.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, crop.width, crop.height);
  context.drawImage(
    canvas,
    box.x0,
    box.y0,
    box.x1 - box.x0,
    h,
    h * scale,
    h * scale,
    (box.x1 - box.x0) * scale,
    h * scale
  );
  return crop;
}

/**
 * 1 つのかたまりを 3 通りの大きさで読み、いちばん票（自信の合計）の多い読みを返す。
 *
 * @returns {Promise<string>} 読めなければ空
 */
async function readBox(scheduler, canvas, box) {
  const results = await Promise.all(
    READ_HEIGHTS.map(async (height) => {
      const crop = cropOf(canvas, box, height);
      try {
        return await scheduler.addJob('recognize', crop);
      } finally {
        releaseCanvas(crop);
      }
    })
  );
  const votes = new Map();
  for (const { data } of results) {
    const text = (data.text || '').replace(/\s+/g, '');
    if (!NUMERIC.test(text) || data.confidence < MIN_CONFIDENCE) continue;
    votes.set(text, (votes.get(text) || 0) + data.confidence);
  }
  let best = '';
  for (const [text, score] of votes) if (!best || score > votes.get(best)) best = text;
  return best;
}

/**
 * 余白の帯を読み、頁番号の読み取り（page-numbers.js）が使う形の断片にして返す。
 *
 * 帯をまるごと読ませると、ぽつんと置かれた 1 文字を読み落としやすいので、
 * 短い文字のかたまり（image-checks.js の shortTextBoxes）を 1 つずつ読む。
 *
 * @param {{canvas:HTMLCanvasElement, top:number, height:number}} strip
 *   renderMargins の帯（top・height は頁の高さに対する割合）
 * @returns {Promise<{text:string, x0:number, x1:number, y:number, h:number}[]>}
 */
export async function readStrip(strip) {
  const scheduler = await prepareOcr();
  const { canvas } = strip;
  const width = canvas.width;
  const height = canvas.height;
  const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height);
  const boxes = shortTextBoxes({ width, height, gray: toGray(pixels.data) });

  const texts = await Promise.all(boxes.map((box) => readBox(scheduler, canvas, box)));
  const items = [];
  texts.forEach((text, i) => {
    if (!text) return;
    const box = boxes[i];
    items.push({
      text,
      x0: box.x0 / width,
      x1: box.x1 / width,
      // 断片の y は基準線（字の下端）の位置。
      y: strip.top + (box.y1 / height) * strip.height,
      h: ((box.y1 - box.y0) / height) * strip.height,
    });
  });
  return items;
}
