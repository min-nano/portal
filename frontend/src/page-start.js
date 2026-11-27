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
//      サインイン済みなら、アカウントのメニューの「設定」をつなぎ、社内
//      ユーザーだと確かめてから社内専用の入口を見せる（答えは待たない。前回
//      社内ユーザーだった人には先に見せておく。account.js）
//   5. 待っているものを言い換えて（サインインの確認 → ツールの準備）、
//      そのページの準備を走らせる
//   6. 準備が終わったら画面を出す。**画面を出すのは「入力できるように
//      なった時点」**で、組み立て途中のフォームは見せない
//
// どこで失敗しても、読み込み中の表示は必ず終わらせて理由を出す（回り続けた
// まま終わる画面を作らない）。理由の出し方はページによって違うので
// （ツールは画面の中の #message、トップページはサインインゲート）、
// onError に任せる。

import { checkAccount, showRememberedAccount } from './account.js';
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
    if (CLOSING_CODES.has(error.code)) closeApp(error.message);
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
    // 前回社内ユーザーだったなら、確かめ直す前に社内専用の入口を見せておく。
    showRememberedAccount(clerk.user?.primaryEmailAddress?.emailAddress);
    const refusal = checkAccount().then(
      () => null,
      (error) => error
    );
    // 既に届いた断り（準備が失敗したときに、どちらの理由を出すかを決めるため）。
    let refusedEarly = null;
    refusal.then((refused) => {
      refusedEarly = refused;
    });

    if (preparing) setPageLoadingLabel(preparing);
    try {
      if (prepare) await prepare(clerk);
    } catch (error) {
      // 準備の失敗はすぐに出す（使えないアカウントかの答えを待って遅らせない）。
      // 使えないアカウントだと既に分かっていれば、そちらを出す（「待てば通る」と
      // 思わせない）。まだなら、後から分かったときに画面を閉じて理由を出し直す。
      // 準備の失敗そのものが断りなら、それで閉じる（begin の catch）。
      if (refusedEarly) throw refusedEarly;
      if (!CLOSING_CODES.has(error.code)) refusal.then((late) => late && refuse(late));
      throw error;
    }
    showApp();

    // 準備が API を呼ばないページ（PDF 結合ツールは画面の中だけで動く）でも
    // 使わせないよう、画面の中身を隠して理由だけを出す。
    const refused = await refusal;
    if (refused) refuse(refused);
  }

  /** 使えないアカウント: 画面の中身を隠して、理由を出す。 */
  function refuse(refused) {
    closeApp(refused.message);
    onError(refused.message);
  }
}

/**
 * 画面を閉じる断り（バックエンドが付ける目印）。使えないアカウント
 * （account.js も同じものを見る）と、外部ユーザーが社内専用のツールを開いたとき。
 */
const CLOSING_CODES = new Set(['account_not_allowed', 'staff_only']);

/**
 * 画面（#app）の中身を隠し、断りの理由だけを出す。
 *
 * 要素は消さず、#app に印を付けて CSS（base.css）で隠す。動いている途中の
 * 処理が要素を見失って落ちることがなく、ツールが後から要素を出し直しても
 * （hidden を外しても）閉じたままになる。
 *
 * 理由はツールの理由の欄（#message）ではなく、専用の欄（#refusal）に出す。
 * #message は動いている途中の処理（PDF の読み取りの失敗など）も書き換えるので、
 * そこに出すと理由が後から消えてしまうため。
 */
function closeApp(reason) {
  // 1 つのページで閉じるのは 1 度だけ（断りは、準備の失敗か /api/me の答えの
  // どちらか一方からしか届かない）。
  const app = document.getElementById('app');
  const box = document.createElement('p');
  box.id = 'refusal';
  box.setAttribute('role', 'alert');
  box.style.color = 'red';
  box.textContent = reason;
  app.append(box);
  app.dataset.closed = '';
  // #app の外に開いているもの（頁の拡大表示など）も閉じる。閉じた後に開こうと
  // したもの（読み込みを待ってから開くダイアログなど）も、開いたそばから閉じる。
  // CSS で隠すだけだと、見えないモーダルが残って画面全体（サインアウトも）が
  // 操作できなくなるため。
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  new MutationObserver((changes) => {
    for (const { target } of changes) {
      if (target instanceof HTMLDialogElement && target.open) target.close();
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
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
