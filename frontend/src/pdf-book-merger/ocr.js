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
// かかるので、使うときになってから読み込み、画像を描く間に進める（main.js）。

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

/**
 * これまでに読んだかたまりの数（記録に出す。読み取りの手間はこれに比例する）。
 * 濃い字だけを残して読み直したかたまりは、2 つと数える。
 */
let boxesRead = 0;

/** これまでに読んだかたまりの数。 */
export function boxesReadSoFar() {
  return boxesRead;
}

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
    const starting = createScheduler().catch((error) => {
      // 用意している間に手放され、別のものを用意し始めていたら、そちらは残す。
      if (schedulerPromise === starting) schedulerPromise = null;
      throw error;
    });
    schedulerPromise = starting;
  }
  return schedulerPromise;
}

/**
 * OCR を手放す（worker を止める）。次に読むときは、prepareOcr で用意し直す。
 *
 * Tesseract.js の worker は、読んだ画像に合わせて WebAssembly のメモリを
 * 広げ、縮めない。200 頁を読み終えると 2 つで 300 MB を超えていた（Chromium で
 * 測ると、止めたらページのメモリが 876 MB → 514 MB）。iPhone では、これを
 * 抱えたまま結合するとページごと落ちたので、読み終えたら手放す。
 * 読んでいる最中に呼ばないこと（読みかけの頁は失敗する）。止め損ねても失敗に
 * しない（次に読むときは、新しく用意する）。
 */
export async function releaseOcr() {
  const starting = schedulerPromise;
  schedulerPromise = null;
  // 用意している途中に失敗したら、止めるものは無い。
  const scheduler = await starting?.catch(() => null);
  await scheduler?.terminate().catch(() => {});
}

// 1 つのかたまりを読む字の高さ（px）。1 文字だけの「1」「9」は、大きさに
// よって読めたり読めなかったりする（Tesseract は 1 文字の行が苦手）ので、
// 3 通りの大きさで読んで多数決にする。
const READ_HEIGHTS = [34, 20, 54];

/** 頁番号として意味のある読み（数字を含み、数字と飾りだけ）。 */
const NUMERIC = /^[-()]*\d[-()\d]*$/;

/** 濃い字の色とみなす、白でない画素の濃い方からの割合（ごみの点 1 つに引きずられない）。 */
const DARK_SHARE = 0.02;

/**
 * 画素（RGBA）のうち、濃い字の色と白の真ん中より薄いものを白にする（濃い字だけを
 * 残す）。濃い字の色は、白でない画素を濃い順に並べて DARK_SHARE のところの色。
 * 頁番号の両側に灰色の飾り（「● 2 ●」の丸）があると、Tesseract は字を読めても
 * 自信を 0 にする（防水施工マニュアルの 1 章の「● 2 ●」〜「● 6 ●」を読み落とした）。
 * 飾りを消して読み直すと、自信 95 ほどで読める。
 *
 * @param {Uint8ClampedArray} data getImageData の data（書き換える）
 */
export function keepDarkest(data) {
  const gray = toGray(data);
  const cut = darkCut(gray);
  gray.forEach((value, j) => {
    if (value > cut) data.fill(255, j * 4, j * 4 + 3);
  });
}

/** 濃い字だけを残すときの境目（これより薄い画素を白にする）。白しか無ければ 255。 */
function darkCut(gray) {
  const ink = gray.filter((value) => value < 250).sort();
  if (!ink.length) return 255;
  return (ink[Math.floor((ink.length - 1) * DARK_SHARE)] + 255) / 2;
}

/** 読み直すのは、薄いインクがこれだけを占めるかたまり（灰色の飾りのあるもの）だけ。 */
const LIGHT_SHARE = 0.2;

/**
 * かたまりに、濃い字より薄いインク（灰色の飾り）がまとまってあるか（帯の画素で）。
 * 罫線・ごみのように一様に濃いかたまりは読み直さない（読み直すと、罫線が濃い
 * 縦棒だけになって「1」と読めてしまう）。
 */
export function hasLightInk({ width, gray }, box) {
  const values = [];
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) values.push(gray[y * width + x]);
  }
  const cut = darkCut(values);
  const ink = values.filter((value) => value < 250);
  return ink.length > 0 && ink.filter((value) => value > cut).length >= ink.length * LIGHT_SHARE;
}

/**
 * かたまりを、周りに字の高さぶんの白い余白を付けて、指定の字の高さで描き出す。
 * dark なら、濃い字だけを残す（keepDarkest）。
 */
function cropOf(canvas, box, height, dark) {
  const h = box.y1 - box.y0;
  const scale = height / h;
  const crop = document.createElement('canvas');
  crop.width = Math.max(1, Math.round((box.x1 - box.x0 + 2 * h) * scale));
  crop.height = Math.max(1, Math.round(3 * h * scale));
  // 濃い字だけを残すときは画素を読み出すので、そのつもりで用意させる。
  const context = crop.getContext('2d', { willReadFrequently: dark });
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
  if (dark) {
    const pixels = context.getImageData(0, 0, crop.width, crop.height);
    keepDarkest(pixels.data);
    context.putImageData(pixels, 0, 0);
  }
  return crop;
}

/**
 * 1 つのかたまりを 3 通りの大きさで読み、いちばん票（自信の合計）の多い読みを返す。
 * 数字と読めたのに自信が足りず、灰色のインクがあるかたまり（hasLightInk）は、濃い
 * 字だけを残して読み直す（頁番号の両側の灰色の飾りなど。keepDarkest）。手間が
 * 増えるのは、そうしたかたまりだけ。
 *
 * @returns {Promise<string>} 読めなければ空
 */
async function readBox(scheduler, canvas, strip, box) {
  const { best, unsure } = await voteBox(scheduler, canvas, box, false);
  if (best || !unsure || !hasLightInk(strip, box)) return best;
  boxesRead++;
  return (await voteBox(scheduler, canvas, box, true)).best;
}

/**
 * 3 通りの大きさで読んで、票を数える。best は読み（読めなければ空）、unsure は数字と
 * して読めたのに自信が足りなかった読みがあったか（濃い字だけを残して読み直す）。
 * 数字として読めないかたまり（和文・罫線・ごみ）は読み直さない（手間が増え、
 * 罫線を「1」と読み違えることもあるので）。
 */
async function voteBox(scheduler, canvas, box, dark) {
  const results = await Promise.all(
    READ_HEIGHTS.map(async (height) => {
      const crop = cropOf(canvas, box, height, dark);
      try {
        return await scheduler.addJob('recognize', crop);
      } finally {
        releaseCanvas(crop);
      }
    })
  );
  const votes = new Map();
  let unsure = false;
  for (const { data } of results) {
    const text = (data.text || '').replace(/\s+/g, '');
    if (!NUMERIC.test(text)) continue;
    if (data.confidence < MIN_CONFIDENCE) {
      unsure = true;
      continue;
    }
    votes.set(text, (votes.get(text) || 0) + data.confidence);
  }
  let best = '';
  for (const [text, score] of votes) if (!best || score > votes.get(best)) best = text;
  return { best, unsure };
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
  const image = { width, height, gray: toGray(pixels.data) };
  const boxes = shortTextBoxes(image);
  boxesRead += boxes.length;

  const texts = await Promise.all(boxes.map((box) => readBox(scheduler, canvas, image, box)));
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
