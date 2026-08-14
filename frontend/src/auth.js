// Clerk によるサインイン管理。
//
// Google アカウントでのログインのみを許可する（ソーシャル接続として Google
// だけを有効にする設定は Clerk ダッシュボード側で行う。README 参照）。
// バックエンドはセッショントークンの email クレームを検証してそのユーザーの
// 代理で Workspace API を呼ぶため、ここで取得するトークンが GAS 版の
// 「アクセスしているユーザーとして実行」に相当する本人性の根拠になる。

import { Clerk } from '@clerk/clerk-js';
import { jaJP } from '@clerk/localizations';
import { finishPageLoading } from './components/loading.js';

let clerkInstance = null;
// このタブでサインアウト操作中かどうか。下のセッション監視リスナーが
// サインアウトの処理中に割り込んで reload するのを防ぐ。
let signingOut = false;

// clerk-js v6 から、サインイン画面などの UI コンポーネントは本体に含まれず
// @clerk/ui として分離された。load() に渡さないと mountSignIn() が
// 「Clerk was not loaded with Ui components」で失敗する。
//
// ただし @clerk/ui は React ごと抱えていて、ポータルの JS のおよそ 2/3 を
// 占める。使うのは**未サインインのときだけ**なので、すでにサインイン済み
// （＝ふだんの利用）では最初から読み込まない。
//
// clerk-js は ui.ClerkUI に Promise を渡せて、それを待つのはサインイン画面
// などをマウントするときだけ、という作りになっている。そこで「まだ果たして
// いない約束」を渡しておき、未サインインだと分かってから動的 import で
// 果たす（loadClerkUI）。サインイン済みのまま終われば、この約束は果たされず
// @clerk/ui は 1 バイトも読み込まれない。
let fulfillClerkUI;
const clerkUI = new Promise((resolve) => {
  fulfillClerkUI = resolve;
});

/** @clerk/ui を読み込み、clerk-js に渡してある約束を果たす。 */
async function loadClerkUI() {
  const { ClerkUI } = await import('@clerk/ui/entry');
  fulfillClerkUI(ClerkUI);
  // clerk-js 側が ClerkUI を組み立て終える（＝マウントできる）まで待つ。
  await clerkUI;
}

async function initClerk() {
  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw new Error(
      'VITE_CLERK_PUBLISHABLE_KEY が設定されていません。frontend/.env（または CI のリポジトリ変数）を確認してください。'
    );
  }
  clerkInstance = new Clerk(publishableKey);
  await clerkInstance.load({ localization: jaJP, ui: { ClerkUI: clerkUI } });
  return clerkInstance;
}

/**
 * サインイン画面をゲートの中にマウントする。
 * 描き終わるまでのあいだは、ゲートに置いてある読み込み中の表示を残す
 * （@clerk/ui の読み込みと、Clerk 自身の画面の組み立ての 2 段があるため）。
 *
 * @param {import('@clerk/clerk-js').Clerk} clerk
 * @param {HTMLElement} mount .clerk-mount
 */
async function mountSignInInto(clerk, mount) {
  const loading = mount.querySelector('portal-loading');
  // Clerk が中身を差し込んだら消す（マウントの完了を知らせる口が無いため、
  // マウント先に子が増えたことで判断する）。
  const observer = new MutationObserver(() => {
    if (!mount.querySelector(':scope > *:not(portal-loading)')) return;
    observer.disconnect();
    loading.remove();
  });
  if (loading) observer.observe(mount, { childList: true });

  try {
    await loadClerkUI();
    clerk.mountSignIn(mount);
  } catch (error) {
    // 出てこないものを待たせない（理由は呼び出し側が画面に出す）。
    observer.disconnect();
    loading?.remove();
    throw error;
  }
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
 * サインイン済みならヘッダーにアカウントを表示し、Clerk のインスタンスを返す。
 * 未サインインならサインイン画面をマウントして null を返す。
 *
 * 画面（#app）を出すのは呼び出し側の仕事（components/loading.js の showApp）。
 * ツールはこのあとにも準備（フォーム定義と計算実装の取得）があり、そこまで
 * 済んでから出したいため、読み込み中の表示もここでは消さない。
 */
export async function requireSignIn() {
  const gate = document.getElementById('authGate');

  const clerk = await initClerk();

  if (!clerk.user) {
    // サインイン画面を出すので、ページの読み込み中の表示はここで終わり
    // （ゲートの中には、サインイン画面が現れるまでの表示が別にある）。
    finishPageLoading();
    gate.hidden = false;
    await mountSignInInto(clerk, gate.querySelector('.clerk-mount'));
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
      signingOut = true;
      await clerk.signOut();
      window.location.reload();
    });
  }
  // 別タブでのサインアウトなどでセッションが消えたら、サインイン画面に戻す。
  //
  // このタブ自身のサインアウト中は何もしない。clerk-js v6 の signOut() は
  // セッションの削除リクエスト（client.removeSessions()）より先にローカルの
  // user を空にしてリスナーへ通知する（v5 は削除の完了後だった）。ここで
  // reload してしまうと削除リクエストが中断され、リロード後もサインイン状態の
  // ままになる。このタブの後始末は上のクリックハンドラ側が行う。
  clerk.addListener(({ user }) => {
    if (!user && !signingOut) window.location.reload();
  });

  return clerk;
}
