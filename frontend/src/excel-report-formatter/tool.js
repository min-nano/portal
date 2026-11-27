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
  // トップページのツール一覧で、名前の下に出る説明。読まれる長さにとどめる
  // ため **1 行・40 字まで**（テストが数える）。詳しい説明は README に書く。
  description: '傾斜の計測値から、Excel の報告書を作ります。',
  // ページの見出し（<title>）。ツール名と違うことがあるので別に持つ。
  title: '現況検査レポート作成ツール',
  // 下のファイルは、このファイルからの相対で解決する（ツールが portal の中に
  // あっても、パッケージとして node_modules の中にあっても同じように解ける）。
  dir: fileURLToPath(new URL('.', import.meta.url)),
  page: 'page.html', // <div id="app"> の中身
  entry: 'main.js', // 画面の入口
  // トップページのツール一覧に大きく出す絵（SVG。カードの中へそのまま埋め込む）。
  // 描き方の決まり（48 の升目・currentColor・線の太さ 2.5）は README の
  // 「🧩 土台とツール」。この絵は、クリップボードに傾きの角度（傾斜の計測）。
  icon: 'icon.svg',
  styles: 'tool.css', // このツールにしか出てこない形（見本ページが束ねる）
  // 外部ユーザー（組織外のアカウント）にも使わせるツールは externalUsers: true を
  // 書く。書かなければ社内専用で、このツールは雛形を Drive から読むので書かない。
  // 書けるのは Drive を使わずに済むツールだけで、バックエンドの
  // Tool(external_users=True) とそろえる（README「外部ユーザー（組織外のアカウント）」）。
};
