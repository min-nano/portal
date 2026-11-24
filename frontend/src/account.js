// 外部ユーザー（組織外のアカウント）に、使えない入口を見せない。
//
// 外部ユーザーは Drive を使えない（代理アクセスが Workspace の外のアカウントには
// 効かないため）。社内専用のもの——トップページの社内専用ツール、PDF 結合ツールの
// 「Drive から選ぶ」、全員共通の設定の「設定」メニュー——には data-staff-only を
// 付けておき、外部ユーザーだと分かったら <html data-account="external"> にして、
// CSS（base.css）でまとめて隠す。部品ごとに隠す処理を書かないので、社内専用の
// 入口を増やすときは印を付けるだけでよい。
//
// これは**見せ方だけ**。断るのはいつもサーバー（社内専用のツールと Drive の
// 入口は 403 を返す）で、ここが失敗しても入口が見えたままになるだけ。
// ただし、どちらの許可リストにも無いアカウント（/api/me が 403）と、サーバーの
// 設定の漏れ（500。社内ドメインが未設定など）は、どのツールも使えないので、
// 理由（サーバーの文言）を投げて呼び出し側に出させる。外部ユーザーは確認コード
// でサインインするので、誰でもサインインまでは進めるため。
// 起動待ちなどの一時的な失敗（502〜504、通信の失敗）では何もしない。
//
// 待たない: /api/me の答えを待ってから画面を出すと、社内ユーザーまで
// Cloud Run の起動待ちを被る。社内ユーザーには何も変わらないので、外部ユーザー
// だけが、答えが届いた時点で入口が消えるのを見る。

import { apiGet } from './api.js';

/** 待っても通らない失敗（使えないアカウント・サーバーの設定の漏れ）。 */
const REFUSED = new Set([403, 500]);

/**
 * 本人が外部ユーザーなら、社内専用の入口を隠す。
 *
 * @returns {Promise<boolean>} 外部ユーザーだったか（読めなかったときは false）
 * @throws 使えないアカウント（403）か、サーバーの設定の漏れ（500）のとき。
 *   message はサーバーの理由
 */
export async function hideStaffOnlyForExternalUsers(doc = document) {
  let account;
  try {
    account = await apiGet('/api/me');
  } catch (error) {
    if (REFUSED.has(error?.status)) throw error; // どのツールも使えない。
    return false; // 隠せないだけ（使えば、サーバーが理由を添えて断る）。
  }
  if (account?.external !== true) return false;
  doc.documentElement.dataset.account = 'external';
  return true;
}
