// 構造計算安全証明書 作成ツールの名乗り（マニフェスト）。
// 書き方は README の「🧩 土台とツール」と、
// src/excel-report-formatter/tool.js のコメントを参照。

import { fileURLToPath } from 'node:url';

export default {
  id: 'structural-cert-formatter',
  name: '構造計算安全証明書 作成ツール',
  description: `
    「構造計算によって建築物の安全性を確かめた旨の証明書」（第四号書式）を
    作成し、Google Drive に PDF で保存します。雛形は Google ドキュメントを
    参照し、該当する選択肢には自動で印（番号は ○、□ はレ点）を付けます。
    作成済みの PDF を読み込んで編集し、上書き（版履歴あり）または別名で
    保存もできます。
  `,
  title: '構造計算安全証明書 作成ツール',
  dir: fileURLToPath(new URL('.', import.meta.url)),
  page: 'page.html',
  // <div id="app"> の外に出す部分（保存ダイアログ）。
  overlay: 'overlay.html',
  entry: 'main.js', // 画面の入口
  // styles は無い。このツールに出てくる形はすべてデザインシステム側の部品で
  // 足りているため（そのツールにしか出てこない形が無ければ、宣言しない）。
};
