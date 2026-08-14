// ポータルトップページ。サインイン状態を確認してツール一覧を表示する。

import './styles.css';
import './components/index.js';
import { finishPageLoading } from './components/loading.js';
import { requireSignIn } from './auth.js';
import { redirectToCanonicalHost } from './canonical-host.js';

async function start() {
  // .web.app へのアクセスはカスタムドメインへ寄せる。リダイレクト中は
  // Clerk を初期化しない（別ドメインでセッションを持たせないため）。
  if (redirectToCanonicalHost()) return;
  await requireSignIn();
}

start().catch(function (error) {
  // 待っても出てこないので、読み込み中の表示は消してから理由を出す。
  finishPageLoading();
  const gate = document.getElementById('authGate');
  gate.hidden = false;
  gate.querySelector('.clerk-mount').replaceChildren();
  gate.querySelector('.note').textContent = error.message;
});
