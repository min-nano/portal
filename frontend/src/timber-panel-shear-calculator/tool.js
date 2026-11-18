// 面材張り大壁 計算ツールの名乗り（マニフェスト）。
// 書き方は README の「🧩 土台とツール」と、
// src/excel-report-formatter/tool.js のコメントを参照。

import { fileURLToPath } from 'node:url';

export default {
  id: 'timber-panel-shear-calculator',
  name: '面材張り大壁 計算ツール',
  description: '大壁の剛性と耐力を計算し、計算書を PDF にします。',
  title: '面材張り大壁 計算ツール',
  dir: fileURLToPath(new URL('.', import.meta.url)),
  page: 'page.html',
  overlay: 'overlay.html',
  entry: 'main.js', // 画面の入口
  icon: 'icon.svg', // トップページの絵: 釘を打った面材に、横からの力（面内せん断）
  styles: 'tool.css', // このツールにしか出てこない形（見本ページが束ねる）
};
