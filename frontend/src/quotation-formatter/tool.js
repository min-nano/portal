// 見積書 作成ツールの名乗り（マニフェスト）。
// 書き方は README の「🧩 土台とツール」と、
// src/excel-report-formatter/tool.js のコメントを参照。

import { fileURLToPath } from 'node:url';

export default {
  id: 'quotation-formatter',
  name: '見積書 作成ツール',
  description: `
    設計等業務の見積書（御見積書）を作成し、Google Drive に PDF で保存します。
    業務を選ぶと規模・設計方法から摘要の下書きが付き、金額と消費税は入力の
    たびに計算します。耐震診断・耐震補強設計は、平成27年国土交通省告示第670号
    の標準業務人・時間数から報酬の参考額を出せます。作成済みの PDF を読み込んで
    編集し、上書き（版履歴あり）または別名で保存もできます。
  `,
  title: '見積書 作成ツール',
  dir: fileURLToPath(new URL('.', import.meta.url)),
  page: 'page.html',
  // <div id="app"> の外に出す部分（保存ダイアログ・設定ダイアログ）。
  overlay: 'overlay.html',
  entry: 'main.js', // 画面の入口
  styles: 'tool.css', // このツールにしか出てこない形（見本ページが束ねる）
};
