// ポータルトップページ。サインイン状態を確認してツール一覧を表示する。

import './styles.css';
import './components/index.js';
import { startPage } from './page-start.js';

// ツール一覧は HTML に書いてあるので、このページに準備は要らない
// （サインインの確認が済んだ時点で使える）。理由を出す先は、ツールと違って
// サインインゲートになる（画面の中にはメッセージ欄が無いため）。
function showStartError(message) {
  const gate = document.getElementById('authGate');
  gate.hidden = false;
  gate.querySelector('.clerk-mount').replaceChildren();
  gate.querySelector('.note').textContent = message;
}

startPage({ onError: showStartError });
