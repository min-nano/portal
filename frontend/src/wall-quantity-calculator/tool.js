// 小規模木造建築物 必要壁量 計算ツールの名乗り（マニフェスト）。
// 書き方は README の「🧩 土台とツール」と、
// src/excel-report-formatter/tool.js のコメントを参照。

import { fileURLToPath } from 'node:url';

export default {
  id: 'wall-quantity-calculator',
  name: '小規模木造建築物 必要壁量 計算ツール',
  description: '必要壁量を計算し、配布の Excel 様式のまま出力します。',
  title: '小規模木造建築物 必要壁量 計算ツール',
  dir: fileURLToPath(new URL('.', import.meta.url)),
  page: 'page.html',
  entry: 'main.js', // 画面の入口
  icon: 'icon.svg', // トップページの絵: 筋かいの入った壁のある家（木造の壁量）
  styles: 'tool.css', // このツールにしか出てこない形（見本ページが束ねる）
  // 外部ユーザー（組織外のアカウント）にも使わせる。Drive を使わない（入力 → xlsx のダウンロード）。
  // バックエンドの Tool(external_users=True) とそろえる。
  externalUsers: true,
};
