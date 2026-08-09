// Clerk によるサインイン管理。
//
// Google アカウントでのログインのみを許可する（ソーシャル接続として Google
// だけを有効にする設定は Clerk ダッシュボード側で行う。README 参照）。
// バックエンドはセッショントークンの email クレームを検証してそのユーザーの
// 代理で Workspace API を呼ぶため、ここで取得するトークンが GAS 版の
// 「アクセスしているユーザーとして実行」に相当する本人性の根拠になる。

import { Clerk } from '@clerk/clerk-js';
// clerk-js v6 から、サインイン画面などの UI コンポーネントは本体に含まれず
// @clerk/ui として分離された。load() に渡さないと mountSignIn() が
// 「Clerk was not loaded with Ui components」で失敗する。
import { ClerkUI } from '@clerk/ui/entry';
import { jaJP } from '@clerk/localizations';

let clerkInstance = null;

async function initClerk() {
  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw new Error(
      'VITE_CLERK_PUBLISHABLE_KEY が設定されていません。frontend/.env（または CI のリポジトリ変数）を確認してください。'
    );
  }
  clerkInstance = new Clerk(publishableKey);
  await clerkInstance.load({ localization: jaJP, ui: { ClerkUI } });
  return clerkInstance;
}

/**
 * API 呼び出しに使うセッショントークンを返す。
 * Clerk のトークンは短命（約 60 秒）だが、getToken() が自動で更新するため
 * リクエストのたびに呼んでよい。
 */
export async function getSessionToken() {
  const token = await clerkInstance?.session?.getToken();
  if (!token) {
    throw new Error('サインインが必要です。ページを再読み込みしてください。');
  }
  return token;
}

/**
 * ページ共通のサインインゲート。
 * サインイン済みなら #app を表示してヘッダーにアカウントを表示し、Clerk の
 * インスタンスを返す。未サインインならサインイン画面をマウントして null を返す。
 */
export async function requireSignIn() {
  const gate = document.getElementById('authGate');
  const app = document.getElementById('app');

  const clerk = await initClerk();

  if (!clerk.user) {
    gate.hidden = false;
    clerk.mountSignIn(gate.querySelector('.clerk-mount'));
    return null;
  }

  const accountArea = document.getElementById('accountArea');
  if (accountArea) accountArea.hidden = false;
  const emailEl = document.getElementById('accountEmail');
  if (emailEl) {
    emailEl.textContent = clerk.user.primaryEmailAddress?.emailAddress || '';
  }
  const signOutBtn = document.getElementById('signOutBtn');
  if (signOutBtn) {
    signOutBtn.addEventListener('click', async () => {
      await clerk.signOut();
      window.location.reload();
    });
  }
  // 別タブでのサインアウトなどでセッションが消えたら、サインイン画面に戻す。
  clerk.addListener(({ user }) => {
    if (!user) window.location.reload();
  });

  app.hidden = false;
  return clerk;
}
