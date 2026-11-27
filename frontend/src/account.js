// 社内専用の入口は、社内ユーザーだと確かめてから見せる。
//
// 外部ユーザー（組織外のアカウント）は Drive を使えない（代理アクセスが
// Workspace の外のアカウントには効かないため）。社内専用のもの——トップページの
// 社内専用ツール、PDF 結合ツールの「Drive から選ぶ」、全員共通の設定の「設定」
// メニュー——には data-staff-only を付けておく。CSS（base.css）は、
// <html data-account="internal"> になるまでそれらを隠す。社内ユーザーだと
// 確かめられない限り（外部ユーザー・使えないアカウント・確かめられなかった）
// 見えないので、外部の人に社内専用の入口は見えない（例外は下の「待たない」）。
// 部品ごとに隠す処理を書かないので、社内専用の入口を増やすときは印を付けるだけでよい。
//
// これは**見せ方だけ**。断るのはいつもサーバー（社内専用のツールと Drive の
// 入口は 403 を返す）。使えないアカウント（社内ドメインでも外部ユーザーでもない
// もの。/api/me が目印 account_not_allowed 付きの 403 を返す）は、どのツールも
// 使えないので、理由（サーバーの文言）を投げて呼び出し側に出させる。
//
// 待たない: /api/me の答えを待ってから画面を出すと、社内ユーザーまで Cloud Run の
// 起動待ちを被る。そこで、この端末で最後に社内ユーザーと確かめたアドレスを
// 1 つだけ覚えておき（ポータルの名前とロゴと同じ）、同じアドレスでサインイン
// したら**まず入口を見せてから**確かめ直す。違っていれば（外部ユーザーに
// なった、使えなくなった）その時点で隠す。つまり、前回社内ユーザーだった人には、
// 確かめ終わるまで（確かめられなければそのページの間）入口が見えることがある。
// 覚えた値は見せ方にしか使わないので、書き換えられても使えるようにはならない。
// 外部ユーザーのアドレスは覚えない（端末に残さない）。
//
// 一時的な失敗（起動待ちの 5xx・429・通信の失敗）では、少し間を置いて取り直す
// （RETRY_DELAYS_MS）。取り直しても確かめられなければ、見せ方はそのまま
// （覚えた値で見せていればそのまま、そうでなければ隠したまま）。

import { apiGet } from './api.js';
import { deviceStorage } from './device-storage.js';

/** 取り直すまでに待つ時間（回ごと）。使い切ったら、見せ方を変えずにあきらめる。 */
// 確かめられないと社員にも入口が出ないので、Cloud Run の起動待ち（数秒〜10 秒
// ほど）を越えられるだけ待つ（合わせて約 12 秒）。
export const RETRY_DELAYS_MS = Object.freeze([1000, 3000, 8000]);

const CACHE_KEY = 'portal.account';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 待てば通りうる失敗か（通信の失敗・5xx・429）。 */
function retryable(error) {
  // fetch の通信の失敗は TypeError（応答の読み損ない・コードの誤りは取り直さない）。
  if (error instanceof TypeError) return true;
  const status = error?.status;
  return status >= 500 || status === 429;
}

function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** この端末で最後に社内ユーザーと確かめたアドレス（{ email }）。無ければ null。 */
function readRemembered(storage) {
  try {
    const value = JSON.parse(storage.getItem(CACHE_KEY) || 'null');
    return value && typeof value === 'object' ? value : null;
  } catch {
    // 保存場所が無い・壊れた値は、覚えていないのと同じ。
    return null;
  }
}

// このページで一度忘れたら（サインアウトしたら）、もう覚えない。取り直し中の
// /api/me の答えが後から届いても、消したアドレスを書き戻さないため。ほかの
// タブで消されたとき（storage イベント）も同じ。
let forgotten = false;
globalThis.addEventListener('storage', (event) => {
  if (event.key === CACHE_KEY && event.newValue === null) forgotten = true;
});

/** 社内ユーザーと確かめたアドレスを覚える（email が無ければ忘れる）。 */
function remember(email, storage) {
  if (email && forgotten) return;
  try {
    if (email) storage.setItem(CACHE_KEY, JSON.stringify({ email }));
    else storage.removeItem(CACHE_KEY);
  } catch {
    // 覚えられなくても、毎回確かめてから見せるだけで困らない。
  }
}

/** 覚えたアドレスを忘れる（サインアウトのとき。共用の端末にアドレスを残さない）。 */
export function forgetRememberedAccount(storage = deviceStorage()) {
  forgotten = true;
  remember(null, storage);
}

/**
 * 前回、このアドレスが社内ユーザーだったと覚えていれば、すぐに入口を見せる。
 *
 * @param {string} email サインインしているアドレス
 */
export function showRememberedAccount(
  email,
  doc = document,
  storage = deviceStorage()
) {
  const remembered = readRemembered(storage);
  if (remembered && sameAddress(remembered.email, email)) {
    doc.documentElement.dataset.account = 'internal';
  }
}

/**
 * /api/me で本人を確かめ、見せ方をそろえて覚えておく。
 *
 * @param {Document} [doc]
 * @param {(ms: number) => Promise<void>} [wait] 取り直す前に待つ（テストが差し替える）
 * @param {Storage} [storage]
 * @returns {Promise<'internal'|'external'|null>} 確かめた結果（確かめられなかったときは null）
 * @throws 使えないアカウント（account_not_allowed）のとき。message はサーバーの理由
 */
export async function checkAccount(
  doc = document,
  wait = sleep,
  storage = deviceStorage()
) {
  let account;
  for (let attempt = 0; ; attempt += 1) {
    try {
      account = await apiGet('/api/me');
      break;
    } catch (error) {
      if (error?.code === 'account_not_allowed') {
        // 使えないアカウント。覚えた値も捨て、社内専用の入口を隠してから投げる。
        doc.documentElement.dataset.account = 'refused';
        remember(null, storage);
        throw error;
      }
      // 取り直すのは、待てば通りうる失敗（通信の失敗・5xx・429）のときだけ。
      if (!retryable(error) || attempt >= RETRY_DELAYS_MS.length) return null;
      await wait(RETRY_DELAYS_MS[attempt]);
    }
  }
  // external を true / false ではっきり答えなければ（途中の何かが返した null、
  // 古いバックエンドなど）、確かめられなかったのと同じ（見せ方も覚えた値も変えない）。
  if (typeof account?.external !== 'boolean') return null;
  const internal = !account.external;
  const kind = internal ? 'internal' : 'external';
  doc.documentElement.dataset.account = kind;
  remember(internal ? account.email : null, storage);
  return kind;
}
