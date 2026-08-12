// PDF を成果物とするツール（構造計算安全証明書・面材張り大壁の計算書）が
// 共通で使うファイル操作まわりの見た目。
//
//   <portal-edit-bar class="edit-bar"></portal-edit-bar>       編集中のファイル
//   <portal-save-bar class="save-bar"></portal-save-bar>       保存
//   <portal-save-dialogs></portal-save-dialogs>                2 つのダイアログ
//
// 振る舞いは ../pdf-file-ops.js（保存の判断・文言）と ../save-dialogs.js
// （ダイアログの開閉）にある。ここはそこが探す id を持つマークアップを
// 1 か所にまとめるだけの部品なので、中身は light DOM に作る。

const doc_ = (host) => host.ownerDocument;

/** 一度だけ組み立てる（同じ部品を作り直さない）。 */
function once(host, build) {
  if (host.dataset.ready) return false;
  host.dataset.ready = 'true';
  build();
  return true;
}

function button(doc, id, text, className) {
  const node = doc.createElement('button');
  node.type = 'button';
  node.id = id;
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

/**
 * 編集中のファイルと、その切り替え操作（新規作成 / 開く）。
 * 通常のアプリのファイルメニューと同じ並びにする。
 */
export class PortalEditBar extends HTMLElement {
  connectedCallback() {
    once(this, () => {
      const doc = doc_(this);

      const line = doc.createElement('div');
      const label = doc.createElement('span');
      label.className = 'label';
      label.textContent = '編集中のファイル: ';
      const name = doc.createElement('span');
      name.className = 'name';
      name.id = 'sourceName';
      name.textContent = 'なし（新規作成）';
      line.append(label, name);

      const actions = doc.createElement('div');
      actions.className = 'file-actions';
      // 読み込むだけで Drive には保存しないため、Picker のアップロード画面
      // ではなくブラウザのファイル選択を使う。
      const upload = doc.createElement('input');
      upload.type = 'file';
      upload.id = 'uploadInput';
      upload.accept = 'application/pdf,.pdf';
      upload.hidden = true;
      actions.append(
        button(doc, 'newBtn', '新規作成'),
        button(doc, 'loadBtn', 'Drive から開く'),
        button(doc, 'uploadBtn', '手元の PDF を開く'),
        upload
      );

      const note = doc.createElement('p');
      note.className = 'hint';
      note.id = 'sourceNote';
      note.hidden = true;

      this.append(line, actions, note);
    });
  }
}

/**
 * 保存欄。保存先は「編集中のファイル」そのもので、ファイル名と場所は
 * 新規保存・別名保存のときだけ保存ダイアログで指定する。
 *
 * disabled 属性を付けておくと、押せない状態から始まる（雛形の設定など、
 * 準備が整うまで保存させたくないツール向け）。
 */
export class PortalSaveBar extends HTMLElement {
  connectedCallback() {
    once(this, () => {
      const doc = doc_(this);
      const disabled = this.hasAttribute('disabled');

      const heading = doc.createElement('h3');
      heading.textContent = '保存';
      const hint = doc.createElement('p');
      hint.className = 'hint';
      hint.id = 'saveHint';

      const actions = doc.createElement('div');
      actions.className = 'save-actions';
      const submit = button(doc, 'submitBtn', '保存');
      const saveAs = button(doc, 'saveAsBtn', '別名で保存', 'secondary');
      submit.disabled = disabled;
      saveAs.disabled = disabled;
      actions.append(submit, saveAs);

      this.append(heading, hint, actions);
    });
  }
}

/**
 * 未保存の確認と「名前を付けて保存」のダイアログ。
 *
 * Google Picker は「ファイルを選ぶ」画面で、保存する名前を入力させることは
 * できない。そのため保存ダイアログは自前で持ち、場所の選択だけを Picker に
 * 任せている（../save-dialogs.js）。
 */
export class PortalSaveDialogs extends HTMLElement {
  connectedCallback() {
    once(this, () => {
      const doc = doc_(this);
      this.append(this.unsavedDialog(doc), this.saveAsDialog(doc));
    });
  }

  unsavedDialog(doc) {
    const dialog = doc.createElement('dialog');
    dialog.id = 'unsavedDialog';
    dialog.className = 'app-dialog';
    const message = doc.createElement('p');
    message.id = 'unsavedMessage';
    const actions = doc.createElement('div');
    actions.className = 'dialog-actions';
    // 通常のアプリと同じ 3 択（保存する / 保存しない / キャンセル）。
    [
      ['save', '保存する', ''],
      ['discard', '保存しない', 'secondary'],
      ['cancel', 'キャンセル', 'secondary'],
    ].forEach(([choice, text, className]) => {
      const node = doc.createElement('button');
      node.type = 'button';
      node.dataset.choice = choice;
      node.textContent = text;
      if (className) node.className = className;
      actions.appendChild(node);
    });
    dialog.append(message, actions);
    return dialog;
  }

  saveAsDialog(doc) {
    const dialog = doc.createElement('dialog');
    dialog.id = 'saveAsDialog';
    dialog.className = 'app-dialog';

    const title = doc.createElement('h3');
    title.id = 'saveAsTitle';
    title.textContent = '別名で保存';

    const nameLabel = doc.createElement('label');
    nameLabel.setAttribute('for', 'saveAsName');
    nameLabel.textContent = 'ファイル名';
    const name = doc.createElement('input');
    name.type = 'text';
    name.id = 'saveAsName';
    name.placeholder = this.getAttribute('name-placeholder') || '';

    const folderLabel = doc.createElement('label');
    folderLabel.setAttribute('for', 'saveAsFolderBtn');
    folderLabel.textContent = '保存先フォルダ';
    const folderRow = doc.createElement('div');
    folderRow.className = 'folder-row';
    const folderName = doc.createElement('span');
    folderName.id = 'saveAsFolderName';
    folderName.className = 'unset';
    folderName.textContent = '未選択';
    folderRow.append(folderName, button(doc, 'saveAsFolderBtn', '選択', 'secondary'));

    const actions = doc.createElement('div');
    actions.className = 'dialog-actions';
    const confirm = button(doc, 'saveAsConfirmBtn', '保存');
    confirm.disabled = true;
    actions.append(confirm, button(doc, 'saveAsCancelBtn', 'キャンセル', 'secondary'));

    dialog.append(title, nameLabel, name, folderLabel, folderRow, actions);
    return dialog;
  }
}

const TAGS = [
  ['portal-edit-bar', PortalEditBar],
  ['portal-save-bar', PortalSaveBar],
  ['portal-save-dialogs', PortalSaveDialogs],
];

TAGS.forEach(([tag, constructor]) => {
  if (!customElements.get(tag)) customElements.define(tag, constructor);
});
