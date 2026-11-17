// 構造計算安全証明書 作成ツールの名乗り（マニフェスト）。
// 書き方は README の「🧩 土台とツール」と、
// src/excel-report-formatter/tool.js のコメントを参照。

import { fileURLToPath } from 'node:url';

export default {
  id: 'structural-cert-formatter',
  name: '構造計算安全証明書 作成ツール',
  description: '安全証明書（第四号書式）を PDF で作ります。',
  title: '構造計算安全証明書 作成ツール',
  dir: fileURLToPath(new URL('.', import.meta.url)),
  page: 'page.html',
  // <div id="app"> の外に出す部分（保存ダイアログ）。
  overlay: 'overlay.html',
  entry: 'main.js', // 画面の入口
  icon: 'icon.svg', // トップページの絵: 書類と、認証のしるし（証明書）
  // styles は無い。このツールに出てくる形はすべてデザインシステム側の部品で
  // 足りているため（そのツールにしか出てこない形が無ければ、宣言しない）。
};
