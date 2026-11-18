// PDF 結合ツールの名乗り（マニフェスト）。
// 書き方は README の「🧩 土台とツール」と、
// src/excel-report-formatter/tool.js のコメントを参照。

import { fileURLToPath } from 'node:url';

export default {
  id: 'pdf-book-merger',
  name: 'PDF 結合ツール',
  description: '複数の PDF を 1 つに結合します（スキャンした本も頁順に）。',
  title: 'PDF 結合ツール',
  dir: fileURLToPath(new URL('.', import.meta.url)),
  page: 'page.html',
  // <div id="app"> の外に出す部分（拡大表示と、Drive への保存ダイアログ）。
  overlay: 'overlay.html',
  entry: 'main.js', // 画面の入口
  icon: 'icon.svg', // トップページの絵: 2 つの書類が 1 つにまとまる
  styles: 'tool.css', // このツールにしか出てこない形（見本ページが束ねる）
};
