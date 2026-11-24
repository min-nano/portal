// 各ページの入口の、共通の段取り。
//
// どのページも同じ順序で始まる。順序そのものに意味があり、5 つの入口に
// 写して回ると必ずずれるので、ここに 1 つだけ置く。
//
//   1. カノニカルなドメインへ寄せる。別ドメインなら、ここで終わり
//      （リダイレクト中に Clerk を初期化しない。別ドメインでセッションを
//      持たせないため。location.replace() は同期的にスクリプトを止めない
//      ので、早期の中断が要る）
//   2. バックエンド（Cloud Run）を起こしておく。ツールの準備は /config から
//      始まり、その先頭がインスタンスの起動待ちを丸ごと被る。サインインの
//      確認と同時に始めておけば、その分が待ち時間から消える
//   3. ポータルの名前とロゴを出す（前回の値をすぐ出して、裏で読み直す。
//      サインインの確認を待たない。サインイン画面のヘッダーにも出すため）
//   4. サインインの確認。未サインインなら、サインイン画面を出して終わり。
//      サインイン済みなら、アカウントのメニューの「設定」をつなぎ、外部
//      ユーザーなら社内専用の入口を隠す（答えは待たない。account.js）
//   5. 待っているものを言い換えて（サインインの確認 → ツールの準備）、
//      そのページの準備を走らせる
//   6. 準備が終わったら画面を出す。**画面を出すのは「入力できるように
//      なった時点」**で、組み立て途中のフォームは見せない
//
// どこで失敗しても、読み込み中の表示は必ず終わらせて理由を出す（回り続けた
// まま終わる画面を作らない）。理由の出し方はページによって違うので
// （ツールは画面の中の #message、トップページはサインインゲート）、
// onError に任せる。

import { hideStaffOnlyForExternalUsers } from './account.js';
import { warmUpApi } from './api.js';
import { requireSignIn } from './auth.js';
import { redirectToCanonicalHost } from './canonical-host.js';
import { connectSiteSettingsMenu, showSite } from './site-settings.js';
import {
  finishPageLoading,
  setPageLoadingLabel,
  showApp,
} from './components/loading.js';

/**
 * ページを開始する。
 *
 * @param {object} options
 * @param {(clerk: object) => Promise<void>} [options.prepare]
 *   このページの準備（フォーム定義の取得・入力欄の組み立て）。これが終わった
 *   時点で「入力できる」とみなして画面を出す。投げた失敗は onError へ回る。
 * @param {boolean} [options.usesApi] バックエンドを使うページかどうか。
 *   true なら、サインインの確認と同時に起こしておく。
 * @param {string} [options.preparing] 準備のあいだの、読み込み中の文言。
 * @param {(message: string) => void} [options.onError]
 *   先に進めないときの理由の出し方。読み込み中の表示を消してから呼ばれる。
 *   既定は「画面を出して、その中のメッセージ欄へ書く」（ツールはどれもこの形）。
 */
export function startPage({
  prepare,
  usesApi = false,
  preparing = '',
  onError = showStartError,
}) {
  begin().catch((error) => {
    // 待っても出てこないので、読み込み中の表示は終わりにして理由を出す。
    finishPageLoading();
    // 使えないアカウント・社内専用のツールとして断られたなら、画面の中身も隠す
    // （出しておいても、どのボタンも同じ理由で断られるだけ）。
    if (CLOSING_CODES.has(error.code)) closeApp();
    onError(error.message);
  });

  async function begin() {
    if (redirectToCanonicalHost()) return; // 別ドメインへ移動中。
    if (usesApi) warmUpApi();
    showSite();

    const clerk = await requireSignIn();
    if (!clerk) return; // サインイン画面を表示中。
    connectSiteSettingsMenu();
    // 答えは待たない。使えないアカウントだと分かったら理由を出すが、出すのは
    // 画面を出した後（組み立て途中の画面を見せない）。準備のほうが先に失敗
    // したら、そちらの理由を出す（準備が API を呼ぶページなら、同じ理由で断られる）。
    const refusal = hideStaffOnlyForExternalUsers().then(
      () => null,
      (error) => error
    );

    if (preparing) setPageLoadingLabel(preparing);
    try {
      if (prepare) await prepare(clerk);
    } catch (error) {
      // 準備が別の理由（起動待ちの 503 など）で先に失敗しても、使えない
      // アカウントだと分かれば、そちらを出す（「待てば通る」と思わせない）。
      // 待つのは少しだけ（答えが遅いときに、準備の失敗を出すのを遅らせない）。
      throw (await settledWithin(refusal, REFUSAL_GRACE_MS)) ?? error;
    }
    showApp();

    const refused = await refusal;
    if (refused) {
      // 準備が API を呼ばないページ（PDF 結合ツールは画面の中だけで動く）でも
      // 使わせないよう、理由の欄（#message）だけを残して画面の中身を隠す。
      closeApp();
      onError(refused.message);
    }
  }
}

/** 準備が失敗したとき、使えないアカウントかの答えを待つ時間の上限。 */
const REFUSAL_GRACE_MS = 2000;

/** promise の結果を、ms 以内に出れば返す（出なければ null）。 */
function settledWithin(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}

/**
 * 画面を閉じる断り（バックエンドが付ける目印）。使えないアカウント
 * （account.js も同じものを見る）と、外部ユーザーが社内専用のツールを開いたとき。
 */
const CLOSING_CODES = new Set(['account_not_allowed', 'staff_only']);

/**
 * 画面（#app）の中身を、理由の欄（#message）だけ残して隠す。
 *
 * 要素は消さず、#app に印を付けて CSS（base.css）で隠す。動いている途中の
 * 処理が要素を見失って落ちることがなく、ツールが後から要素を出し直しても
 * （hidden を外しても）閉じたままになる。
 */
function closeApp() {
  document.getElementById('app').dataset.closed = '';
  // #app の外に開いているもの（頁の拡大表示など）も閉じる。
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
}

/**
 * 先に進めないときの、既定の理由の出し方。
 *
 * 理由の置き場所（#message）は画面の中にあるので、**出せないときも画面は
 * 出す**。ここを忘れると、理由が隠れたまま輪だけが回り続ける。
 *
 * @param {string} message
 */
function showStartError(message) {
  showApp();
  const box = document.getElementById('message');
  if (!box) return;
  box.style.color = 'red';
  box.textContent = message;
}
