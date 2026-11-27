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
// ただし、使えないアカウント（社内ドメインでも外部ユーザーでもないもの。/api/me
// が目印 account_not_allowed 付きの 403 を返す）は、どのツールも使えないので、理由（サーバーの
// 文言）を投げて呼び出し側に出させる。それ以外の失敗（プロキシなどの 403・
// 5xx・通信の失敗）では何もしない。一時的なものかもしれず、社内ユーザーの
// 画面を一度の失敗で閉じてしまわないため。
//
// 待たない: /api/me の答えを待ってから画面を出すと、社内ユーザーまで
// Cloud Run の起動待ちを被る。社内ユーザーには何も変わらないので、外部ユーザー
// だけが、答えが届いた時点で入口が消えるのを見る。

import { apiGet } from './api.js';

/**
 * 本人が外部ユーザーなら、社内専用の入口を隠す。
 *
 * @returns {Promise<boolean>} 外部ユーザーだったか（読めなかったときは false）
 * @throws 使えないアカウント（account_not_allowed）のとき。message はサーバーの理由
 */
export async function hideStaffOnlyForExternalUsers(doc = document) {
  let account;
  try {
    account = await apiGet('/api/me');
  } catch (error) {
    if (error?.code === 'account_not_allowed') {
      // 使えないアカウント。社内専用の入口（「設定」など）も隠してから投げる。
      doc.documentElement.dataset.account = 'refused';
      throw error;
    }
    return false; // 隠せないだけ（使えば、サーバーが理由を添えて断る）。
  }
  if (account?.external !== true) return false;
  doc.documentElement.dataset.account = 'external';
  return true;
}
