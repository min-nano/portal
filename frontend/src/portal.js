// ポータルトップページ。サインイン状態を確認してツール一覧を表示する。

import './styles.css';
import './components/index.js';
import { requireSignIn } from './auth.js';
import { redirectToCanonicalHost } from './canonical-host.js';

async function start() {
  // .web.app へのアクセスはカスタムドメインへ寄せる。リダイレクト中は
  // Clerk を初期化しない（別ドメインでセッションを持たせないため）。
  if (redirectToCanonicalHost()) return;
  await requireSignIn();
}

start().catch(function (error) {
  const gate = document.getElementById('authGate');
  gate.hidden = false;
  gate.querySelector('.note').textContent = error.message;
});
