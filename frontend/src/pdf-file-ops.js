// PDF を成果物とするツールで共通の「ファイル操作」の考え方。
//
// 構造計算安全証明書 作成ツールと 釘配列諸定数 計算ツールは、どちらも
// 通常のアプリと同じ 4 つの操作（新規作成 / 開く / 保存 / 別名で保存）で
// Drive 上の PDF を扱う。保存先は「編集中のファイル」そのもので、まだ実体が
// 無いときだけ保存ダイアログで名前と場所を尋ねる。
//
// その判断と文言はツールに依らず同じなので、ここに集約する（バックエンド側も
// main.py の _resolve_pdf_destination で同じ規則を共有している）。

/** ファイル名に使えない文字を落とす。バックエンドの整形と同じ規則。 */
export function sanitizeFileName(name) {
  return String(name || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .trim()
    .replace(/^\.+|\.+$/g, '');
}

/** 拡張子 .pdf を必ず付ける。 */
export function ensurePdfExtension(name, fallback) {
  const cleaned = sanitizeFileName(name);
  if (!cleaned) return fallback;
  return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned}.pdf`;
}

/** 上書き保存できるのは、Drive 上のファイルを開いているときだけ。 */
export function canOverwrite(sourceFile) {
  return Boolean(sourceFile && sourceFile.id);
}

/**
 * 「保存」を押したときの動き。
 *
 * 通常のアプリと同じで、保存先は基本的に編集中のファイル。まだ Drive 上に
 * 実体が無い（新規作成・手元の PDF を開いた）ときだけ、別名保存と同じく
 * 保存する場所をそのつど選ぶ。
 */
export function saveModeFor(sourceFile) {
  return canOverwrite(sourceFile) ? 'overwrite' : 'new';
}

/** 保存前の確認文。上書きは取り消しづらいので、対象を明示する。 */
export function confirmSaveMessage(mode, fileName, sourceFile) {
  if (mode === 'overwrite') {
    const target = (sourceFile && sourceFile.name) || fileName;
    return (
      `Google Drive 上の「${target}」を上書きします。\n` +
      '（上書き前の内容は、しばらくの間は Drive の版履歴から復元できます）\n\nよろしいですか？'
    );
  }
  return `「${fileName}」という名前で新しく保存します。\n\nよろしいですか？`;
}

/** 保存欄の案内文。「保存」を押すと何が起きるかを書く。 */
export function saveHintMessage(sourceFile) {
  if (canOverwrite(sourceFile)) {
    return (
      `「保存」で Drive 上の「${sourceFile.name}」を上書きします` +
      '（直前の内容はしばらくの間 Drive の版履歴から復元できます）。' +
      '別の名前・別の場所に保存するときは「別名で保存」を使ってください。'
    );
  }
  return 'まだ保存していません。「保存」を押すと、ファイル名と保存先フォルダを指定する画面が開きます。';
}

/** 未保存のまま新規作成・読み込みへ移ろうとしたときの確認文。 */
export function unsavedPromptMessage(sourceFile, action) {
  const target = canOverwrite(sourceFile)
    ? `「${sourceFile.name}」への変更`
    : '入力した内容';
  return `${target}は保存されていません。${action}の前に保存しますか？`;
}
