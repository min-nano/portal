// サイトの設定画面（アカウントのメニューの「設定」から開く）。
//
// ポータルの表示名とロゴを変える。保存先は Firestore で（/api/site。
// backend/app/site_settings.py）、保存したらこのページのヘッダーにもすぐ出す。
// ほかのページ・ほかの人の画面には、次にページを開いたときに届く。
//
// ロゴは画像を base64 の data: URL にして送る。受け付けるのは PNG と SVG で、
// 大きさはサーバーと同じ上限で先に確かめる（大きなファイルを送ってから
// 断られないように）。種類の最終的な判定は、サーバーが中身を見て行う。
//
// 画面はどのページからでも開けるよう、ここで組み立てて <body> に足す
// （ページの HTML には置かない）。このファイルは「設定」を押したときに
// 初めて読み込まれる（site-settings.js の connectSiteSettingsMenu）。

import { apiSendJson } from './api.js';
import {
  DEFAULT_PORTAL_TITLE,
  applySite,
  loadSite,
  normalizeSite,
  writeCachedSite,
} from './site-settings.js';

/** ロゴの大きさの上限（backend/app/site_settings.py の MAX_LOGO_BYTES と同じ）。 */
export const MAX_LOGO_BYTES = 256 * 1024;

/** 表示名の長さの上限（同じく MAX_TITLE_LENGTH）。 */
export const MAX_TITLE_LENGTH = 60;

const LOGO_TYPES = { png: 'image/png', svg: 'image/svg+xml' };

/**
 * ロゴとして受け付けるファイルの種類。受け付けなければ null。
 *
 * 端末によっては SVG の種類（file.type）が空で届くので、拡張子でも見る。
 *
 * @param {{ name: string, type: string }} file
 * @return {string|null}
 */
export function logoMimeType(file) {
  if (Object.values(LOGO_TYPES).includes(file.type)) return file.type;
  const extension = /\.([^.]+)$/.exec(file.name || '')?.[1]?.toLowerCase();
  return LOGO_TYPES[extension] || null;
}

/**
 * ロゴにできないファイルなら、その理由。できるなら null。
 *
 * @param {{ name: string, type: string, size: number }} file
 * @return {string|null}
 */
export function logoFileProblem(file) {
  if (!logoMimeType(file)) return 'ロゴには PNG か SVG の画像を選んでください。';
  if (file.size > MAX_LOGO_BYTES) {
    return `ロゴの画像が大きすぎます（${MAX_LOGO_BYTES / 1024}KB まで）。`;
  }
  return null;
}

/**
 * ファイルを data: URL にする（種類は logoMimeType で決めたもの）。
 *
 * @param {Blob & { name: string, type: string }} file
 * @return {Promise<string>}
 */
export async function logoDataUrl(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  // String.fromCharCode に一度に渡せる数には限りがあるので、刻んで渡す。
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${logoMimeType(file)};base64,${btoa(binary)}`;
}

function element(doc, tag, props = {}) {
  return Object.assign(doc.createElement(tag), props);
}

/** 設定画面を組み立てて <body> に足す（1 度だけ）。 */
function buildDialog(doc) {
  const dialog = element(doc, 'dialog', { id: 'siteSettingsDialog', className: 'app-dialog' });
  dialog.setAttribute('aria-labelledby', 'siteSettingsTitle');

  const heading = element(doc, 'h3', { id: 'siteSettingsTitle', textContent: 'サイトの設定' });

  const titleLabel = element(doc, 'label', { htmlFor: 'siteTitleInput', textContent: 'ポータルの名前' });
  const titleInput = element(doc, 'input', {
    type: 'text',
    id: 'siteTitleInput',
    maxLength: MAX_TITLE_LENGTH,
    placeholder: DEFAULT_PORTAL_TITLE,
    autocomplete: 'off',
  });
  const titleHint = element(doc, 'p', {
    className: 'hint',
    textContent: `ヘッダーとトップページのタブに出ます。空にすると「${DEFAULT_PORTAL_TITLE}」になります。`,
  });

  const logoLabel = element(doc, 'label', { id: 'siteLogoLabel', textContent: 'ロゴ' });
  const logoRow = element(doc, 'div', { className: 'logo-row' });
  logoRow.setAttribute('role', 'group');
  logoRow.setAttribute('aria-labelledby', 'siteLogoLabel');
  const preview = element(doc, 'span', { className: 'site-logo', id: 'siteLogoPreview' });
  const logoState = element(doc, 'span', { className: 'unset', id: 'siteLogoState' });
  const chooseBtn = element(doc, 'button', {
    type: 'button',
    id: 'siteLogoChooseBtn',
    className: 'secondary',
    textContent: '画像を選ぶ',
  });
  const removeBtn = element(doc, 'button', {
    type: 'button',
    id: 'siteLogoRemoveBtn',
    className: 'secondary danger',
    textContent: '外す',
  });
  const fileInput = element(doc, 'input', {
    type: 'file',
    id: 'siteLogoInput',
    accept: 'image/png,image/svg+xml,.png,.svg',
    hidden: true,
  });
  logoRow.append(preview, logoState, chooseBtn, removeBtn, fileInput);
  const logoHint = element(doc, 'p', {
    className: 'hint',
    textContent: `PNG か SVG（${MAX_LOGO_BYTES / 1024}KB まで）。ヘッダーの名前の左に、縦横比を保って小さく出ます。`,
  });

  const message = element(doc, 'p', { className: 'dialog-error', id: 'siteSettingsMessage' });
  message.setAttribute('role', 'alert');

  const actions = element(doc, 'div', { className: 'dialog-actions' });
  const saveBtn = element(doc, 'button', { type: 'button', id: 'siteSettingsSaveBtn', textContent: '保存' });
  const cancelBtn = element(doc, 'button', {
    type: 'button',
    id: 'siteSettingsCancelBtn',
    className: 'secondary',
    textContent: 'キャンセル',
  });
  actions.append(saveBtn, cancelBtn);

  dialog.append(heading, titleLabel, titleInput, titleHint, logoLabel, logoRow, logoHint, message, actions);
  doc.body.append(dialog);

  // 編集中のロゴ（data: URL か null）。保存するまではヘッダーに出さない。
  let logo = null;
  let busy = false;

  const showLogo = () => {
    if (logo) {
      const img = element(doc, 'img', { alt: 'ロゴの見本' });
      img.src = logo;
      preview.replaceChildren(img);
    } else {
      preview.replaceChildren();
    }
    logoState.textContent = logo ? '' : '未設定';
    removeBtn.disabled = busy || !logo;
  };
  const setBusy = (value) => {
    busy = value;
    for (const control of [titleInput, chooseBtn, saveBtn]) control.disabled = value;
    showLogo();
  };
  const showError = (text) => {
    message.textContent = text;
  };

  chooseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = ''; // 同じファイルを選び直しても change が起きるように。
    if (!file) return;
    const problem = logoFileProblem(file);
    if (problem) {
      showError(problem);
      return;
    }
    showError('');
    logo = await logoDataUrl(file);
    showLogo();
  });
  removeBtn.addEventListener('click', () => {
    logo = null;
    showLogo();
  });
  cancelBtn.addEventListener('click', () => dialog.close());
  saveBtn.addEventListener('click', async () => {
    setBusy(true);
    showError('');
    try {
      const site = normalizeSite(
        await apiSendJson('/api/site', 'PUT', { title: titleInput.value.trim(), logo })
      );
      writeCachedSite(site);
      applySite(site, doc);
      dialog.close();
    } catch (error) {
      showError(error.message);
    } finally {
      setBusy(false);
    }
  });

  /** 今の設定を入れ直して開く。 */
  dialog.edit = (site) => {
    titleInput.value = site.title;
    logo = site.logo;
    showError('');
    setBusy(false);
  };
  dialog.setBusy = setBusy;
  dialog.showError = showError;
  return dialog;
}

/**
 * 設定画面を開く。開いてから今の設定を読み直して入れる（ほかの人が変えた
 * 直後でも、古い値の上から保存してしまわないように）。
 */
export async function openSiteSettings(doc = document) {
  const dialog = doc.getElementById('siteSettingsDialog') || buildDialog(doc);
  dialog.edit({ title: '', logo: null });
  dialog.setBusy(true);
  dialog.showModal();
  try {
    dialog.edit(await loadSite(doc));
    // 開いた時点では入力欄を止めていて、焦点が下のボタンへ行っているため。
    doc.getElementById('siteTitleInput').focus();
  } catch {
    dialog.showError('今の設定を読み込めませんでした。閉じて、もう一度開いてください。');
  }
}
