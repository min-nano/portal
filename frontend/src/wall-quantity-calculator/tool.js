// 小規模木造建築物 必要壁量 計算ツールの名乗り（マニフェスト）。
// 書き方は README の「🧩 土台とツール」と、
// src/excel-report-formatter/tool.js のコメントを参照。

import { fileURLToPath } from 'node:url';

export default {
  id: 'wall-quantity-calculator',
  name: '小規模木造建築物 必要壁量 計算ツール',
  description: `
    日本住宅・木材技術センターが配布している「壁量等の基準(令和7年施行)に
    対応した表計算ツール（多機能版）」に、フォームの入力をそのまま書き込んだ
    Excel ファイルを作ります。提出を求められるのは配布物そのものなので、
    様式は一切変えず、Excel 形式のままダウンロードします。
  `,
  title: '小規模木造建築物 必要壁量 計算ツール',
  dir: fileURLToPath(new URL('.', import.meta.url)),
  page: 'page.html',
  entry: 'main.js', // 画面の入口
  styles: 'tool.css', // このツールにしか出てこない形（見本ページが束ねる）
};
