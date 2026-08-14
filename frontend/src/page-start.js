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
//   3. サインインの確認。未サインインなら、サインイン画面を出して終わり
//   4. 待っているものを言い換えて（サインインの確認 → ツールの準備）、
//      そのページの準備を走らせる
//   5. 準備が終わったら画面を出す。**画面を出すのは「入力できるように
//      なった時点」**で、組み立て途中のフォームは見せない
//
// どこで失敗しても、読み込み中の表示は必ず終わらせて理由を出す（回り続けた
// まま終わる画面を作らない）。理由の出し方はページによって違うので
// （ツールは画面の中の #message、トップページはサインインゲート）、
// onError に任せる。

import { warmUpApi } from './api.js';
import { requireSignIn } from './auth.js';
import { redirectToCanonicalHost } from './canonical-host.js';
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
    onError(error.message);
  });

  async function begin() {
    if (redirectToCanonicalHost()) return; // 別ドメインへ移動中。
    if (usesApi) warmUpApi();

    const clerk = await requireSignIn();
    if (!clerk) return; // サインイン画面を表示中。

    if (preparing) setPageLoadingLabel(preparing);
    if (prepare) await prepare(clerk);
    showApp();
  }
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
