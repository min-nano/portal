// 画面の部品（Web Components）。
//
// ページをまたいで同じものが出てくる部分は、ここでカスタム要素として定義して
// 1 か所にまとめる。フレームワークは入れていない（今のところ、素の Web
// Components で足りている）。ページ側は main.js の先頭でこのファイルを
// 読み込むだけでよい。
//
//   <portal-header>            ヘッダー（ポータル名・アカウント欄）
//   <portal-loading>           読み込み中の表示（JS を待たずに出る）
//   <portal-auth-gate>         サインインゲート
//   <portal-section>           折り畳めるセクション
//   <portal-section-controls>  セクションの一括開閉
//   <portal-edit-bar>          編集中のファイル（PDF ツール）
//   <portal-save-bar>          保存欄（PDF ツール）
//   <portal-save-dialogs>      未保存の確認・名前を付けて保存（PDF ツール）
//
// 部品を足すときの約束事:
//
//   - 名前は portal- で始める（カスタム要素の名前にはハイフンが要る）。
//   - 中身は原則 light DOM に作る。ページ共通の styles.css をそのまま当てられ、
//     既存のコード（auth.js・save-dialogs.js など）が id で探せるため。
//   - shadow DOM を使うのは、ページ側の CSS から隔てたい部分だけ
//     （<portal-section> の見出しの行）。外から整えたいところは part で出す。
//   - 見出しや入力欄そのものは light DOM に置く。aria-labelledby は shadow の
//     境界を越えられないため。

import './page-header.js';
import './loading.js';
import './auth-gate.js';
import './collapsible-section.js';
import './section-controls.js';
import './pdf-file-ui.js';

export { PortalSection, revealSection, setSectionsOpen } from './collapsible-section.js';
export { finishPageLoading } from './loading.js';
