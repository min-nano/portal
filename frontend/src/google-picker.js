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

// Picker の既定の大きさ（Google 側の既定値と同じ）。表示領域がこれより
// 狭いときは、余白 PICKER_MARGIN_PX を残して縮める。
const PICKER_MAX_WIDTH_PX = 1051;
const PICKER_MAX_HEIGHT_PX = 650;
const PICKER_MIN_SIDE_PX = 320;
const PICKER_MARGIN_PX = 24;

/**
 * 表示領域に収まるダイアログの大きさ。
 *
 * Picker は指定しないとウィンドウより大きな箱を作ることがあり、画面の
 * 中央に置いても端がはみ出して、閉じるボタンや一覧の一部が押せなくなる。
 */
function pickerSize() {
  const fit = (available, max) =>
    Math.max(PICKER_MIN_SIDE_PX, Math.min(max, available - PICKER_MARGIN_PX));
  return {
    width: fit(window.innerWidth || PICKER_MAX_WIDTH_PX, PICKER_MAX_WIDTH_PX),
    height: fit(window.innerHeight || PICKER_MAX_HEIGHT_PX, PICKER_MAX_HEIGHT_PX),
  };
}

/**
 * Picker を開いている間、後ろのページを動かないようにする。
 *
 * Picker は画面全体を覆うダイアログで、ホイールはその中の一覧に吸われる。
 * 後ろのページだけが動くと、閉じたときに元居た場所が分からなくなるため、
 * 開いている間は固定する。戻す関数を返す。
 */
function lockPageScroll() {
  const { documentElement: html, body } = document;
  const previous = { html: html.style.overflow, body: body.style.overflow };
  // スクロールバーが消えた分だけ内容が右にずれるので、その幅を埋める。
  const scrollbar = window.innerWidth - html.clientWidth;
  const previousPadding = body.style.paddingRight;
  html.style.overflow = 'hidden';
  body.style.overflow = 'hidden';
  if (scrollbar > 0) {
    const current = parseFloat(getComputedStyle(body).paddingRight) || 0;
    body.style.paddingRight = `${current + scrollbar}px`;
  }
  return () => {
    html.style.overflow = previous.html;
    body.style.overflow = previous.body;
    body.style.paddingRight = previousPadding;
  };
}

function selectedFile(data) {
  const doc = (data.docs || [])[0];
  if (!doc) return null;
  return { id: doc.id, name: doc.name, mimeType: doc.mimeType };
}

function showPicker(config, oauthToken, options) {
  const api = window.google.picker;
  const { width, height } = pickerSize();
  const unlockPageScroll = lockPageScroll();
  return new Promise((resolve, reject) => {
    let instance = null;
    // 選択・キャンセルのたびに DOM ごと片付ける（開き直すたびに前回の
    // Picker が残らないように）。ページのスクロールもここで戻す。
    const close = () => {
      unlockPageScroll();
      if (instance) instance.dispose();
    };
    const builder = new api.PickerBuilder()
      .setDeveloperKey(config.apiKey)
      .setOAuthToken(oauthToken)
      .setLocale('ja')
      .setTitle(options.title || '')
      .setSize(width, height)
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
    try {
      instance = builder.build();
      instance.setVisible(true);
    } catch (error) {
      // 開けなかったときにページを固定したままにしない。
      close();
      throw error;
    }
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
