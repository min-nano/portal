// 書籍スキャン PDF 結合ツールの名乗り（マニフェスト）。
// 書き方は README の「🧩 土台とツール」と、
// src/excel-report-formatter/tool.js のコメントを参照。

import { fileURLToPath } from 'node:url';

export default {
  id: 'pdf-book-merger',
  name: '書籍スキャン PDF 結合ツール',
  description: `
    裁断した本を分けてスキャンした PDF（奇数頁・偶数頁の束、表紙・裏表紙）を
    Google Drive から複数選び、頁番号を読み取って 1 冊ぶんの順に並べ、
    1 つの PDF に結合します。頁の抜け・重なりやスキャンの傾き・ずれを確かめ、
    結合した PDF も元と突き合わせて検証します。処理はすべてブラウザの中で行い、
    検索できる文字情報はそのまま残ります。
  `,
  title: '書籍スキャン PDF 結合ツール',
  dir: fileURLToPath(new URL('.', import.meta.url)),
  page: 'page.html',
  // <div id="app"> の外に出す部分（拡大表示と、Drive への保存ダイアログ）。
  overlay: 'overlay.html',
  entry: 'main.js', // 画面の入口
  styles: 'tool.css', // このツールにしか出てこない形（見本ページが束ねる）
};
