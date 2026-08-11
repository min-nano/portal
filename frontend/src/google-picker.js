// 公式の Google Picker（Google Drive のファイル選択 UI）。
//
// 以前は「名前の一部を入力 → バックエンドが Drive を検索 → 候補を一覧」と
// いう自前のダイアログを Picker の代わりに使っていたが、フォルダをたどる・
// 最近使った項目から選ぶ・共有ドライブを見るといった操作ができず、正確な
// ファイル名を覚えている人しか使えなかった。Google 公式の Picker に置き換え、
// Drive 本体と同じ操作感で選べるようにする。
//
// Picker は選択画面を描くために Drive を読むアクセストークンを要求する。
// これは /api/picker/token から受け取る、実行ユーザー本人の読み取り専用
// （drive.readonly）の代理トークン。ブラウザ側で OAuth の同意を取る方式
// （Google Identity Services）を使わないのは、それだと画面の URL を OAuth
// クライアントの「承認済みの JavaScript 生成元」へ登録する必要があり、URL が
// 毎回変わる PR プレビューで動かせないため（この欄はワイルドカードが使えず、
// 追加するための API も無い）。
//
// 選んだファイルの読み書きは、これまで通りバックエンドが代理権限で行う。
// このトークンは選択画面を出すためだけのもので、本人が既に Drive で見られる
// 範囲を超えない（権限モデルは変わらない）。

import { apiGet } from './api.js';

const GAPI_SRC = 'https://apis.google.com/js/api.js';

// トークンの有効期限にはこれだけ余裕を持たせる（Picker を開いている最中に
// 切れて、選んだ瞬間に失敗する、という状況を避ける）。
const EXPIRY_MARGIN_MS = 60 * 1000;

const NOT_CONFIGURED =
  'Google Picker が未設定です。バックエンド（Cloud Run）に ' +
  'GOOGLE_PICKER_API_KEY を設定してください（README「Google Picker」参照）。';

let configPromise = null;
let apiPromise = null;
let token = null; // { value, expiresAt }

/** 同じ src の <script> は一度だけ読み込む。 */
const scriptPromises = new Map();

function loadScript(src) {
  if (!scriptPromises.has(src)) {
    scriptPromises.set(
      src,
      new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => {
          // 失敗したままキャッシュすると、通信が復帰しても二度と読めない。
          scriptPromises.delete(src);
          reject(new Error('Google のスクリプトを読み込めませんでした: ' + src));
        };
        document.head.appendChild(script);
      })
    );
  }
  return scriptPromises.get(src);
}

/** 失敗した読み込みはキャッシュせず、次のクリックでやり直せるようにする。 */
function retryable(promise, reset) {
  return promise.catch((error) => {
    reset();
    throw error;
  });
}

function pickerConfig() {
  if (!configPromise) {
    configPromise = retryable(apiGet('/api/picker/config'), () => {
      configPromise = null;
    });
  }
  return configPromise;
}

async function loadPickerApi() {
  if (!window.gapi) await loadScript(GAPI_SRC);
  await new Promise((resolve, reject) => {
    window.gapi.load('picker', {
      callback: resolve,
      onerror: () => reject(new Error('Google Picker を読み込めませんでした。')),
    });
  });
}

function pickerApi() {
  if (!apiPromise) {
    apiPromise = retryable(loadPickerApi(), () => {
      apiPromise = null;
    });
  }
  return apiPromise;
}

/**
 * 設定と Google のスクリプトを先に用意しておく。
 *
 * Picker の JavaScript はそれなりに大きく、ボタンを押してから読み始めると
 * 待たされる。画面を表示した時点で取りに行っておく。失敗しても画面には
 * 出さない（実際に選ぼうとしたときに、そのときの理由を出す）。
 */
export function preloadPicker() {
  pickerConfig().catch(() => {});
  pickerApi().catch(() => {});
}

async function accessToken() {
  // 一度受け取ったトークンは期限まで使い回す（雛形と保存先を続けて設定する
  // ようなときに、そのつど発行しない）。
  if (!token || token.expiresAt <= Date.now()) {
    const issued = await apiGet('/api/picker/token');
    const lifetime = (Number(issued.expiresIn) || 0) * 1000;
    token = {
      value: issued.token,
      // 期限が短い・分からないときは使い回さず、次回また取りに行く。
      expiresAt: Date.now() + Math.max(0, lifetime - EXPIRY_MARGIN_MS),
    };
  }
  return token.value;
}

// マイドライブ側と共有ドライブ側で、同じ絞り込みのビューを 1 つずつ用意する
// （Picker は setEnableDrives(true) にすると共有ドライブ「だけ」を表示する）。
function buildView(api, { mimeTypes, selectFolder }, sharedDrives) {
  const view = new api.DocsView(
    selectFolder ? api.ViewId.FOLDERS : api.ViewId.DOCS
  )
    .setIncludeFolders(true)
    .setMode(api.DocsViewMode.LIST);
  if (selectFolder) view.setSelectFolderEnabled(true);
  if (mimeTypes) view.setMimeTypes(mimeTypes);
  if (sharedDrives) view.setEnableDrives(true);
  return view;
}

function selectedFile(data) {
  const doc = (data.docs || [])[0];
  if (!doc) return null;
  return { id: doc.id, name: doc.name, mimeType: doc.mimeType };
}

function showPicker(config, oauthToken, options) {
  const api = window.google.picker;
  return new Promise((resolve, reject) => {
    let instance = null;
    // 選択・キャンセルのたびに DOM ごと片付ける（開き直すたびに前回の
    // Picker が残らないように）。
    const close = () => {
      if (instance) instance.dispose();
    };
    const builder = new api.PickerBuilder()
      .setDeveloperKey(config.apiKey)
      .setOAuthToken(oauthToken)
      .setLocale('ja')
      .setTitle(options.title || '')
      .addView(buildView(api, options, false))
      .addView(buildView(api, options, true))
      .setCallback((data) => {
        if (data.action === api.Action.PICKED) {
          close();
          resolve(selectedFile(data));
        } else if (data.action === api.Action.CANCEL) {
          close();
          resolve(null);
        } else if (data.action === api.Action.ERROR) {
          // トークンが失効しているなど、取り直せば直ることがある。
          token = null;
          close();
          reject(new Error('Google Picker でエラーが発生しました。'));
        }
      });
    // アプリ ID は drive.file スコープで必須のもの。設定されていれば渡す。
    if (config.appId) builder.setAppId(config.appId);
    instance = builder.build();
    instance.setVisible(true);
  });
}

/**
 * 公式 Picker を開き、選ばれたファイルを返す。
 *
 * @param {object} options
 * @param {string} options.title ダイアログの見出し。
 * @param {string} [options.mimeTypes] 選択できる種類（カンマ区切り）。
 * @param {boolean} [options.selectFolder] フォルダを選ばせる。
 * @returns {Promise<{id: string, name: string, mimeType: string} | null>}
 *   キャンセルされた場合は null。
 */
export async function pickFile(options = {}) {
  const config = await pickerConfig();
  if (!config.configured) throw new Error(NOT_CONFIGURED);
  await pickerApi();
  const oauthToken = await accessToken();
  return showPicker(config, oauthToken, options);
}
