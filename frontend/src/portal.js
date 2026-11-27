// ポータルトップページ。サインイン状態を確認してツール一覧を表示する。

import './styles.css';
import './components/index.js';
import { startPage } from './page-start.js';

// ツール一覧は HTML に書いてあるので、このページに準備は要らない
// （サインインの確認が済んだ時点で使える）。理由を出す先は、ツールと違って
// サインインゲートになる（画面の中にはメッセージ欄が無いため）。
function showStartError(message) {
  // ツール一覧を出した後に分かることもある（使えない
  // アカウント。page-start.js）。そのときは一覧をしまって理由だけを出す。
  document.getElementById('app').hidden = true;
  const gate = document.getElementById('authGate');
  gate.hidden = false;
  gate.querySelector('.clerk-mount').replaceChildren();
  gate.querySelector('.note').textContent = message;
}

// バックエンドは、外部ユーザーかを聞く（/api/me。答えは待たない）ために使う。
// サインインの確認と同時に起こしておき、外部ユーザーに社内専用のツールが
// 見えている時間を、起動待ちのぶん短くする。
startPage({ usesApi: true, onError: showStartError });
