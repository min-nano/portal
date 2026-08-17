// 現況検査レポート作成ツールの名乗り（マニフェスト）。
//
// ポータルはツールの名前を知らない。ツールが自分でこれを名乗り、ビルドの
// 入口・トップページのツール一覧・ページの外枠が、ここから決まる
// （README の「🧩 土台とツール」）。
//
// このファイルはビルド時に Node が読むだけで、ブラウザへは行かない。

import { fileURLToPath } from 'node:url';

export default {
  // URL（/tools/<id>/）と API の接頭辞（/api/tools/<id>/）になる。
  id: 'excel-report-formatter',
  name: '現況検査レポート作成ツール',
  // トップページのツール一覧に出る説明。
  description: `
    傾斜測定の計測値を入力して、Excel の報告書（社外秘フォーマット）を生成します。
    雛形は Google Drive 上の最新ファイルを自動で参照します。
  `,
  // ページの見出し（<title>）。ツール名と違うことがあるので別に持つ。
  title: '現況検査レポート作成ツール',
  // 下の 3 つは、このファイルからの相対で解決する（ツールが portal の中に
  // あっても、パッケージとして node_modules の中にあっても同じように解ける）。
  dir: fileURLToPath(new URL('.', import.meta.url)),
  page: 'page.html', // <div id="app"> の中身
  entry: 'main.js', // 画面の入口
  styles: 'tool.css', // このツールにしか出てこない形（見本ページが束ねる）
};
