// 結合した PDF を、この端末に保存する。
//
// パソコンでは、名前を付けてダウンロードする（<a download>）。
//
// iPhone・iPad（と Android）では、共有シート（Web Share API）にファイルを
// 渡す。Safari は、ページの中で作った PDF をダウンロードせずにプレビューとして
// 開くことがあり、そのときは付けた名前が使われない（「Unknown」や「document」
// などになる）。共有シートなら付けた名前のまま渡り、「"ファイル" に保存」や
// Google ドライブのアプリへのアップロードもそこから選べる。

const PDF_MIME = 'application/pdf';

/**
 * 共有シートで渡す端末か（iPhone・iPad・Android）。
 *
 * iPad の Safari は Mac を名乗るので、タッチの有無で見分ける。
 *
 * @param {{userAgent?:string, platform?:string, maxTouchPoints?:number}} [nav]
 */
export function isMobile(nav) {
  if (!nav) return false;
  const userAgent = nav.userAgent || '';
  return (
    /\b(?:iPad|iPhone|iPod|Android)\b/.test(userAgent) ||
    (nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1)
  );
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
 * @param {Uint8Array} bytes
 * @param {string} fileName
 * @param {Navigator} [nav]
 * @returns {Promise<'shared'|'cancelled'|'downloaded'>}
 */
export async function savePdf(bytes, fileName, nav = globalThis.navigator) {
  const file = new File([bytes], fileName, { type: PDF_MIME });
  if (isMobile(nav) && typeof nav.share === 'function' && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: fileName });
      return 'shared';
    } catch (error) {
      // 共有シートを閉じただけなら何もしない。開けなかったときはダウンロードする。
      if (error?.name === 'AbortError') return 'cancelled';
    }
  }
  download(file);
  return 'downloaded';
}
