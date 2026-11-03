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
// ダウンロード（既定のダウンロードフォルダ）にする。共有シートに渡すと、Safari は
// ファイルの中身をまるごとページのメモリに読むので、1 頁のファイル 492 個を
// 結合した 615 MB の PDF では、共有シートが開く前にページごと落ちた（215 MB は
// 渡せた）。
//
// ダウンロードでは、中身の種類を application/pdf と言わずに
// application/octet-stream にする。Safari は PDF と分かると、<a download> でも
// 保存せずにタブで開いてツールのページを閉じ、blob: の URL がページと一緒に
// 消えるので、開いた PDF を「ファイル」に保存できなかった（WebKitBlobResource
// エラー 1）。octet-stream なら、iOS の Safari もダウンロードの確認を出す
// （jsPDF の issue 3059 で報告されたやり方）。名前は download 属性の .pdf のまま。

import { isIOS } from './device.js';

const PDF_MIME = 'application/pdf';

/** 共有シートに渡す大きさの上限（バイト）。これより大きければダウンロードにする。 */
export const SHARE_LIMIT = 256 * 1024 * 1024;

/**
 * blob: の URL を手放すまでの時間（ミリ秒）。ダウンロードは確かめの表示を待って
 * から中身を読むので、すぐに手放すと、読む前に無くなる。
 */
const REVOKE_MS = 10 * 60 * 1000;

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
 * 保存のしかた。共有シートで渡す端末でも、大きなファイルはダウンロードにする。
 *
 * @param {number} size バイト数
 * @param {{userAgent?:string, platform?:string, maxTouchPoints?:number}} [nav]
 * @returns {'share'|'download'}
 */
export function saveMethod(size, nav) {
  return isMobile(nav) && size <= SHARE_LIMIT ? 'share' : 'download';
}

/** 名前を付けてダウンロードする。中身は octet-stream として渡す（上の説明）。 */
function download(file) {
  const url = URL.createObjectURL(new Blob([file], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
}

/**
 * PDF を保存する。押されたボタンの処理の中から、待たずに呼ぶこと（共有シートは
 * 利用者の操作の直後でないと開けない）。
 *
 * @param {Uint8Array|Blob} data 中身（保存領域のファイルなら、メモリに読まずに渡す）
 * @param {string} fileName
 * @param {Navigator} [nav]
 * @param {'share'|'download'} [method] 保存のしかた（saveMethod。決めてあれば渡す）
 * @returns {Promise<'shared'|'cancelled'|'downloaded'>}
 */
export async function savePdf(data, fileName, nav = globalThis.navigator, method = undefined) {
  const file = new File([data], fileName, { type: PDF_MIME });
  method ??= saveMethod(file.size, nav);
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
