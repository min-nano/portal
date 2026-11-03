// 結合した PDF を、この端末に保存する。
//
// パソコンでは、名前を付けてダウンロードする（<a download>）。
//
// iPhone・iPad（と Android）では、共有シート（Web Share API）にファイルを
// 渡す。Safari は、ページの中で作った PDF をダウンロードせずにプレビューとして
// 開くことがあり、そのときは付けた名前が使われない（「Unknown」や「document」
// などになる）。共有シートなら付けた名前のまま渡り、「"ファイル" に保存」や
// Google ドライブのアプリへのアップロードもそこから選べる。
//
// ただし大きなファイル（SHARE_LIMIT を超えるもの）は、共有シートに渡さず、
// Service Worker（download-worker.js）を通して端末のダウンロード（既定の
// ダウンロードフォルダ）に保存する。共有シートに渡すと、Safari はファイルの
// 中身をまるごとページのメモリに読むので、1 頁のファイル 492 個を結合した
// 615 MB の PDF では、共有シートが開く前にページごと落ちた（215 MB は渡せた）。
// <a download> では、Safari は PDF を保存せずにタブで開いてツールのページを閉じ、
// 作ったページと一緒に blob: の URL が消えるので、そこから保存できなかった。

import { isIOS } from './device.js';
import downloadWorkerUrl from './download-worker.js?url&no-inline';

const PDF_MIME = 'application/pdf';

/** 共有シートに渡す大きさの上限（バイト）。これより大きければダウンロードにする。 */
export const SHARE_LIMIT = 256 * 1024 * 1024;

/**
 * 共有シートで渡す端末か（iPhone・iPad・Android）。
 *
 * @param {{userAgent?:string, platform?:string, maxTouchPoints?:number}} [nav]
 */
export function isMobile(nav) {
  if (!nav) return false;
  return isIOS(nav) || /\bAndroid\b/.test(nav.userAgent || '');
}

/**
 * Service Worker の場所。ダウンロードのアドレスは、その下の pdf-download/ に作る。
 * 小さなファイルは data: の URL に埋め込まれるが、Service Worker はそこから登録
 * できないので、ファイルとして置かせる（no-inline）。
 */
const DOWNLOAD_WORKER = new URL(downloadWorkerUrl, globalThis.location.href).href;
const DOWNLOAD_SCOPE = new URL('./pdf-download/', DOWNLOAD_WORKER).href;

/** Service Worker が PDF を受け取るまで待つ時間（ミリ秒）。 */
const HANDOFF_MS = 10 * 1000;

/**
 * 保存のしかた。共有シートで渡す端末では、大きなファイルを Service Worker を
 * 通してダウンロードする（worker）。パソコンは <a download>（download）。
 *
 * @param {number} size バイト数
 * @param {{userAgent?:string, platform?:string, maxTouchPoints?:number}} [nav]
 * @returns {'share'|'worker'|'download'}
 */
export function saveMethod(size, nav) {
  if (!isMobile(nav)) return 'download';
  return size <= SHARE_LIMIT ? 'share' : 'worker';
}

/** 登録した Service Worker が動き出すのを待つ。 */
function activeWorker(registration) {
  if (registration.active) return Promise.resolve(registration.active);
  const worker = registration.installing ?? registration.waiting;
  return new Promise((resolve, reject) => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') resolve(worker);
      else if (worker.state === 'redundant') reject(new Error('Service Worker を動かせませんでした'));
    });
  });
}

/**
 * Service Worker に PDF を渡し、それを保存させるアドレスを開く（download-worker.js）。
 * 渡すのは参照で、中身はページのメモリに読まない。
 */
async function downloadThroughWorker(file, nav) {
  if (!nav.serviceWorker) throw new Error('このブラウザは Service Worker を使えません');
  const registration = await nav.serviceWorker.register(DOWNLOAD_WORKER, { scope: DOWNLOAD_SCOPE });
  const worker = await activeWorker(registration);
  const id = globalThis.crypto.randomUUID();
  await new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error('Service Worker が PDF を受け取りませんでした')), HANDOFF_MS);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      resolve();
    };
    worker.postMessage({ id, file }, [channel.port2]);
  });
  // download を付けずに開く（Service Worker が attachment で返すので、ページは
  // そのまま残り、ブラウザのダウンロードとして保存される）。
  const link = document.createElement('a');
  link.href = `${DOWNLOAD_SCOPE}${id}`;
  document.body.append(link);
  link.click();
  link.remove();
}

function download(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  // すぐに消すと、ダウンロードが始まる前に中身が無くなるブラウザがある。
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

/**
 * PDF を保存する。押されたボタンの処理の中から、待たずに呼ぶこと（共有シートは
 * 利用者の操作の直後でないと開けない）。
 *
 * @param {Uint8Array|Blob} data 中身（保存領域のファイルなら、メモリに読まずに渡す）
 * @param {string} fileName
 * @param {Navigator} [nav]
 * @param {'share'|'worker'|'download'} [method] 保存のしかた（saveMethod。決めてあれば渡す）
 * @returns {Promise<'shared'|'cancelled'|'downloaded'>} 大きな PDF を Service Worker に
 *   渡せなければ、失敗を投げる
 */
export async function savePdf(data, fileName, nav = globalThis.navigator, method = undefined) {
  const file = new File([data], fileName, { type: PDF_MIME });
  method ??= saveMethod(file.size, nav);
  if (method === 'worker') {
    // 渡せなければ、共有シートにもダウンロードにも替えない（共有シートでは落ち、
    // <a download> では保存できないため）。呼ぶ側が知らせる。
    await downloadThroughWorker(file, nav);
    return 'downloaded';
  }
  if (
    method === 'share' &&
    typeof nav.share === 'function' &&
    nav.canShare?.({ files: [file] })
  ) {
    try {
      // ファイルだけを渡す（title などを添えると、iOS はそれを「テキスト.txt」と
      // して一緒に渡してしまう）。
      await nav.share({ files: [file] });
      return 'shared';
    } catch (error) {
      // 共有シートを閉じただけなら何もしない。開けなかったときはダウンロードする。
      if (error?.name === 'AbortError') return 'cancelled';
    }
  }
  download(file);
  return 'downloaded';
}
