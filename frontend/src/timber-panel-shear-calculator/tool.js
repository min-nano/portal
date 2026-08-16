// 面材張り大壁 計算ツールの名乗り（マニフェスト）。
// 書き方は docs/plugin-architecture.md §4.1 と、
// src/excel-report-formatter/tool.js のコメントを参照。

import { fileURLToPath } from 'node:url';

export default {
  id: 'timber-panel-shear-calculator',
  name: '面材張り大壁 計算ツール',
  description: `
    グレー本『木造軸組工法住宅の許容応力度設計』3.3・3.2 節に沿って、
    面材張り大壁の面内せん断剛性 K と許容せん断耐力 Pa を算定し、
    面材のせん断破壊・せん断座屈を検定します。壁を構成する面材ごとに
    寸法・釘の間隔・へりあきを決めると、その釘配列諸定数
    Ixy・Zxy・Cxy が壁の計算の一部として求まります。
    計算の途中経過と釘配列図を添えた計算書を PDF で Google Drive に保存し、
    入力内容は PDF に埋め込まれるので、保存したファイルを開き直して
    続きを編集できます。
  `,
  title: '面材張り大壁 計算ツール',
  dir: fileURLToPath(new URL('.', import.meta.url)),
  page: 'page.html',
  overlay: 'overlay.html',
  entry: 'main.js', // 画面の入口
  styles: 'tool.css', // このツールにしか出てこない形（見本ページが束ねる）
};
