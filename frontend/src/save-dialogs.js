// 「保存しますか？」と「名前を付けて保存」のダイアログ。
//
// PDF を成果物とするツール（構造計算安全証明書・釘配列諸定数の計算書）が
// 共通で使う。マークアップは各ツールの index.html に同じ id で置いてある。
//
// Google Picker は「ファイルを選ぶ」画面で、保存する名前を入力させることは
// できない。そのため保存ダイアログは自前で持ち、場所（フォルダ）の選択だけを
// Picker に任せている。

/**
 * 未保存の入力があるまま別のファイルへ移ってよいかを尋ねる。
 *
 * 通常のアプリと同じ 3 択で、'save' / 'discard' / 'cancel' のいずれかを返す。
 */
export function askUnsaved(message) {
  const dialog = document.getElementById('unsavedDialog');
  document.getElementById('unsavedMessage').textContent = message;
  // <dialog> を開けない環境では、保存の有無までは選べないので破棄の確認だけ行う。
  if (typeof dialog.showModal !== 'function') {
    return Promise.resolve(
      window.confirm(`${message}\n\n（OK で保存せずに進みます）`) ? 'discard' : 'cancel'
    );
  }
  return new Promise((resolve) => {
    // 選ばれた時点で、この 1 回分の待ち受けをまとめて解除する。
    const listening = new AbortController();
    const finish = (choice) => {
      listening.abort();
      dialog.close();
      resolve(choice);
    };
    dialog.querySelectorAll('[data-choice]').forEach((button) => {
      button.addEventListener('click', () => finish(button.dataset.choice), {
        signal: listening.signal,
      });
    });
    // Esc キーで閉じたときは「キャンセル」と同じ扱いにする。
    dialog.addEventListener(
      'cancel',
      (event) => {
        event.preventDefault();
        finish('cancel');
      },
      { signal: listening.signal }
    );
    dialog.showModal();
  });
}

/**
 * 保存ダイアログ。ファイル名と保存先フォルダが決まったら
 * { fileName, folder } を返す。キャンセルなら null。
 *
 * フォルダを選ぶ Picker は Google 側の重ね表示で、モーダルダイアログ
 * （最前面レイヤー）の下に隠れてしまう。そのため Picker を出す間だけ
 * ダイアログを閉じ、選び終えたら開き直す（入力中の名前はそのまま残る）。
 *
 * @param {{title:string, defaultName:string, initialFolder:?object,
 *          pickFolder:function, ensureName:function}} options
 */
export function askSaveAs({ title, defaultName, initialFolder, pickFolder, ensureName }) {
  const dialog = document.getElementById('saveAsDialog');
  const nameInput = document.getElementById('saveAsName');
  const folderEl = document.getElementById('saveAsFolderName');
  const confirmBtn = document.getElementById('saveAsConfirmBtn');

  document.getElementById('saveAsTitle').textContent = title;
  nameInput.value = defaultName;
  let folder = initialFolder;

  const showFolder = () => {
    folderEl.textContent = folder ? folder.name : '未選択';
    folderEl.className = folder ? 'name' : 'unset';
    // 名前と場所の両方が決まるまでは保存できない。
    confirmBtn.disabled = !folder || !nameInput.value.trim();
  };
  showFolder();

  return new Promise((resolve) => {
    const listening = new AbortController();
    const on = (el, type, handler) =>
      el.addEventListener(type, handler, { signal: listening.signal });
    const finish = (value) => {
      listening.abort();
      dialog.close();
      resolve(value);
    };

    on(nameInput, 'input', showFolder);
    on(nameInput, 'keydown', (event) => {
      if (event.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click();
    });
    on(document.getElementById('saveAsFolderBtn'), 'click', async () => {
      dialog.close();
      const picked = await pickFolder();
      if (picked) folder = picked;
      showFolder();
      dialog.showModal();
    });
    on(confirmBtn, 'click', () => finish({ fileName: ensureName(nameInput.value), folder }));
    on(document.getElementById('saveAsCancelBtn'), 'click', () => finish(null));
    // Esc キーで閉じたときは「キャンセル」と同じ扱いにする。
    on(dialog, 'cancel', (event) => {
      event.preventDefault();
      finish(null);
    });

    dialog.showModal();
    nameInput.focus();
    nameInput.select();
  });
}
