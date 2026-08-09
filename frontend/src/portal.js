// ポータルトップページ。サインイン状態を確認してツール一覧を表示する。

import './styles.css';
import { requireSignIn } from './auth.js';

async function start() {
  await requireSignIn();
}

start().catch(function (error) {
  const gate = document.getElementById('authGate');
  gate.hidden = false;
  gate.querySelector('.note').textContent = error.message;
});
