// @vitest-environment jsdom
//
// 公式 Google Picker の呼び出し。Google 側のスクリプト（gapi / Picker）は
// 偽物に差し替え、こちらが渡す設定（開発者キー・代理トークン・絞り込む
// MIME タイプ）と、選択・キャンセルの結果の扱いを確認する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// api.js は Clerk を読み込むため、丸ごと差し替える（API の応答を注入する）。
const apiGet = vi.fn();
vi.mock('../src/api.js', () => ({ apiGet: (path) => apiGet(path) }));

const CONFIG = { configured: true, apiKey: 'AIzaSyTest', appId: '1234567890' };
const TOKEN = { token: 'ya29.test', expiresIn: 3600 };

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// 設定とトークンは別のエンドポイントから来る。既定はどちらも正常な応答。
function respondWith({ config = CONFIG, token = TOKEN } = {}) {
  apiGet.mockImplementation((path) => {
    if (path === '/api/picker/config') return Promise.resolve(config);
    if (path === '/api/picker/token') return Promise.resolve(token);
    throw new Error(`想定外のリクエスト: ${path}`);
  });
}

// 偽の Picker。ビルダーに渡された値と、作られたビューの設定を記録する。
function installGoogleFakes({ respond }) {
  const recorded = { builder: {}, views: [], disposed: 0 };

  class FakeDocsView {
    constructor(viewId) {
      this.viewId = viewId;
      recorded.views.push(this);
    }
    setIncludeFolders(v) { this.includeFolders = v; return this; }
    setSelectFolderEnabled(v) { this.selectFolderEnabled = v; return this; }
    setMode(v) { this.mode = v; return this; }
    setMimeTypes(v) { this.mimeTypes = v; return this; }
    setEnableDrives(v) { this.enableDrives = v; return this; }
  }

  class FakePickerBuilder {
    setDeveloperKey(v) { recorded.builder.developerKey = v; return this; }
    setOAuthToken(v) { (recorded.builder.oauthTokens ||= []).push(v); return this; }
    setAppId(v) { recorded.builder.appId = v; return this; }
    setLocale(v) { recorded.builder.locale = v; return this; }
    setTitle(v) { recorded.builder.title = v; return this; }
    setSize(width, height) { recorded.builder.size = { width, height }; return this; }
    addView(view) { (recorded.builder.views ||= []).push(view); return this; }
    setCallback(fn) { this.callback = fn; return this; }
    build() {
      const callback = this.callback;
      return {
        setVisible: () => {
          // 実際の Picker と同じく、表示のあとで利用者の操作が返ってくる。
          setTimeout(() => callback(respond()), 0);
        },
        dispose: () => {
          recorded.disposed += 1;
        },
      };
    }
  }

  globalThis.gapi = { load: (name, options) => options.callback() };
  globalThis.google = {
    picker: {
      DocsView: FakeDocsView,
      PickerBuilder: FakePickerBuilder,
      ViewId: { DOCS: 'all', FOLDERS: 'folders' },
      DocsViewMode: { LIST: 'list' },
      Action: { PICKED: 'picked', CANCEL: 'cancel', ERROR: 'error' },
    },
  };
  return recorded;
}

const PICKED = () => ({
  action: 'picked',
  docs: [{ id: 'file-1', name: '雛形.xlsx', mimeType: XLSX_MIME, url: 'https://drive/x' }],
});

async function loadModule() {
  // モジュール内に設定とトークンをキャッシュするので、毎回読み込み直す。
  vi.resetModules();
  return import('../src/google-picker.js');
}

// 表示領域の広さ。jsdom の既定は 1024x768。
function setViewport(width, height) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

// 実際のページと同じ viewport の指定を置く。
const VIEWPORT = 'width=device-width, initial-scale=1';

function viewportMeta() {
  return document.querySelector('meta[name="viewport"]');
}

beforeEach(() => {
  apiGet.mockReset();
  respondWith();
  setViewport(1024, 768);
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
  document.body.style.paddingRight = '';
  document.head.innerHTML = `<meta name="viewport" content="${VIEWPORT}">`;
});

afterEach(() => {
  delete globalThis.gapi;
  delete globalThis.google;
});

describe('pickFile', () => {
  it('選ばれたファイルの id・名前・種類を返す', async () => {
    installGoogleFakes({ respond: PICKED });
    const { pickFile } = await loadModule();

    const file = await pickFile({ title: '雛形を選択', mimeTypes: XLSX_MIME });

    expect(file).toEqual({
      id: 'file-1',
      name: '雛形.xlsx',
      mimeType: XLSX_MIME,
    });
  });

  it('キャンセルされたら null を返す（呼び出し側は何もしない）', async () => {
    installGoogleFakes({ respond: () => ({ action: 'cancel' }) });
    const { pickFile } = await loadModule();

    expect(await pickFile({ title: '雛形を選択' })).toBeNull();
  });

  it('バックエンドの設定と、代理発行されたトークンを Picker へ渡す', async () => {
    const recorded = installGoogleFakes({ respond: PICKED });
    const { pickFile } = await loadModule();

    await pickFile({ title: '雛形を選択', mimeTypes: XLSX_MIME });

    expect(apiGet).toHaveBeenCalledWith('/api/picker/config');
    expect(apiGet).toHaveBeenCalledWith('/api/picker/token');
    expect(recorded.builder.developerKey).toBe(CONFIG.apiKey);
    expect(recorded.builder.appId).toBe(CONFIG.appId);
    expect(recorded.builder.oauthTokens).toEqual([TOKEN.token]);
    expect(recorded.builder.title).toBe('雛形を選択');
  });

  it('アプリ ID が未設定なら Picker に渡さない', async () => {
    const recorded = installGoogleFakes({ respond: PICKED });
    respondWith({ config: { ...CONFIG, appId: '' } });
    const { pickFile } = await loadModule();

    await pickFile({ title: '雛形を選択' });

    expect(recorded.builder.appId).toBeUndefined();
  });

  it('マイドライブと共有ドライブの両方を、同じ絞り込みで表示する', async () => {
    const recorded = installGoogleFakes({ respond: PICKED });
    const { pickFile } = await loadModule();

    await pickFile({ title: '雛形を選択', mimeTypes: XLSX_MIME });

    const [myDrive, sharedDrives] = recorded.builder.views;
    expect(recorded.builder.views).toHaveLength(2);
    expect(myDrive.viewId).toBe('all');
    expect(myDrive.mimeTypes).toBe(XLSX_MIME);
    expect(myDrive.enableDrives).toBeUndefined();
    // 共有ドライブは setEnableDrives(true) の専用ビューでしか出ない。
    expect(sharedDrives.enableDrives).toBe(true);
    expect(sharedDrives.mimeTypes).toBe(XLSX_MIME);
  });

  it('フォルダを選ばせるときはフォルダのビューにする', async () => {
    const recorded = installGoogleFakes({
      respond: () => ({
        action: 'picked',
        docs: [{ id: 'folder-1', name: '証明書', mimeType: 'application/vnd.google-apps.folder' }],
      }),
    });
    const { pickFile } = await loadModule();

    const folder = await pickFile({ title: '保存先を選択', selectFolder: true });

    expect(folder.id).toBe('folder-1');
    recorded.builder.views.forEach((view) => {
      expect(view.viewId).toBe('folders');
      expect(view.selectFolderEnabled).toBe(true);
    });
  });

  it('一度受け取ったトークンは次の選択でも使い回す', async () => {
    installGoogleFakes({ respond: PICKED });
    const { pickFile } = await loadModule();

    await pickFile({ title: '雛形を選択' });
    await pickFile({ title: '保存先を選択', selectFolder: true });

    const tokenCalls = apiGet.mock.calls.filter(
      ([path]) => path === '/api/picker/token'
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it('期限の分からないトークンは使い回さない', async () => {
    installGoogleFakes({ respond: PICKED });
    respondWith({ token: { token: 'ya29.test', expiresIn: 0 } });
    const { pickFile } = await loadModule();

    await pickFile({ title: '雛形を選択' });
    await pickFile({ title: '保存先を選択' });

    const tokenCalls = apiGet.mock.calls.filter(
      ([path]) => path === '/api/picker/token'
    );
    expect(tokenCalls).toHaveLength(2);
  });

  it('Picker がエラーを返したら、次の選択でトークンを取り直す', async () => {
    installGoogleFakes({ respond: () => ({ action: 'error' }) });
    const { pickFile } = await loadModule();

    await expect(pickFile({ title: '雛形を選択' })).rejects.toThrow(/Picker/);
    await expect(pickFile({ title: '雛形を選択' })).rejects.toThrow(/Picker/);

    const tokenCalls = apiGet.mock.calls.filter(
      ([path]) => path === '/api/picker/token'
    );
    expect(tokenCalls).toHaveLength(2);
  });

  it('選択のあとに Picker を片付ける', async () => {
    const recorded = installGoogleFakes({ respond: PICKED });
    const { pickFile } = await loadModule();

    await pickFile({ title: '雛形を選択' });

    expect(recorded.disposed).toBe(1);
  });

  it('表示領域に収まる大きさで開く（画面からはみ出させない）', async () => {
    const recorded = installGoogleFakes({ respond: PICKED });
    setViewport(500, 600);
    const { pickFile } = await loadModule();

    await pickFile({ title: '雛形を選択' });

    expect(recorded.builder.size.width).toBeLessThanOrEqual(500);
    expect(recorded.builder.size.height).toBeLessThanOrEqual(600);
  });

  it('広い画面では大きくしすぎない', async () => {
    const recorded = installGoogleFakes({ respond: PICKED });
    setViewport(2560, 1440);
    const { pickFile } = await loadModule();

    await pickFile({ title: '雛形を選択' });

    expect(recorded.builder.size).toEqual({ width: 1051, height: 650 });
  });

  it('開いている間はページを固定し、閉じたら元に戻す', async () => {
    let whileOpen = null;
    installGoogleFakes({
      respond: () => {
        whileOpen = document.body.style.overflow;
        return PICKED();
      },
    });
    document.body.style.overflow = 'auto';
    const { pickFile } = await loadModule();

    await pickFile({ title: '雛形を選択' });

    expect(whileOpen).toBe('hidden');
    expect(document.body.style.overflow).toBe('auto');
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('エラーで閉じたときもページの固定を解く', async () => {
    installGoogleFakes({ respond: () => ({ action: 'error' }) });
    const { pickFile } = await loadModule();

    await expect(pickFile({ title: '雛形を選択' })).rejects.toThrow(/Picker/);

    expect(document.body.style.overflow).toBe('');
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('Picker を開けなかったときもページの固定を解く', async () => {
    installGoogleFakes({ respond: PICKED });
    globalThis.google.picker.PickerBuilder.prototype.build = () => {
      throw new Error('build に失敗');
    };
    const { pickFile } = await loadModule();

    await expect(pickFile({ title: '雛形を選択' })).rejects.toThrow(/build/);

    expect(document.body.style.overflow).toBe('');
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('開いている間は自動ズームを止め、閉じたら元に戻す', async () => {
    let whileOpen = null;
    installGoogleFakes({
      respond: () => {
        whileOpen = viewportMeta().getAttribute('content');
        return PICKED();
      },
    });
    const { pickFile } = await loadModule();

    await pickFile({ title: '雛形を選択' });

    // iOS が検索窓へのフォーカスで勝手に拡大するのを止める指定。
    expect(whileOpen).toBe(`${VIEWPORT}, maximum-scale=1`);
    expect(viewportMeta().getAttribute('content')).toBe(VIEWPORT);
  });

  it('もともとの maximum-scale は重ねずに置き換える', async () => {
    let whileOpen = null;
    installGoogleFakes({
      respond: () => {
        whileOpen = viewportMeta().getAttribute('content');
        return PICKED();
      },
    });
    viewportMeta().setAttribute(
      'content',
      'width=device-width, initial-scale=1, maximum-scale=5'
    );
    const { pickFile } = await loadModule();

    await pickFile({ title: '雛形を選択' });

    expect(whileOpen).toBe('width=device-width, initial-scale=1, maximum-scale=1');
    expect(viewportMeta().getAttribute('content')).toBe(
      'width=device-width, initial-scale=1, maximum-scale=5'
    );
  });

  it('エラーで閉じたときも自動ズームの抑止を解く', async () => {
    installGoogleFakes({ respond: () => ({ action: 'error' }) });
    const { pickFile } = await loadModule();

    await expect(pickFile({ title: '雛形を選択' })).rejects.toThrow(/Picker/);

    expect(viewportMeta().getAttribute('content')).toBe(VIEWPORT);
  });

  it('viewport の指定が無いページでも開ける', async () => {
    installGoogleFakes({ respond: PICKED });
    document.head.innerHTML = '';
    const { pickFile } = await loadModule();

    expect(await pickFile({ title: '雛形を選択' })).not.toBeNull();
  });

  it('未設定なら、設定すべき環境変数を示して失敗する', async () => {
    installGoogleFakes({ respond: PICKED });
    respondWith({ config: { configured: false, apiKey: '', appId: '' } });
    const { pickFile } = await loadModule();

    await expect(pickFile({ title: '雛形を選択' })).rejects.toThrow(
      /GOOGLE_PICKER_API_KEY/
    );
  });

  it('トークンの発行に失敗したら、その理由をそのまま伝える', async () => {
    installGoogleFakes({ respond: PICKED });
    apiGet.mockImplementation((path) => {
      if (path === '/api/picker/config') return Promise.resolve(CONFIG);
      return Promise.reject(
        new Error('Google Drive のアクセストークンを取得できませんでした。')
      );
    });
    const { pickFile } = await loadModule();

    await expect(pickFile({ title: '雛形を選択' })).rejects.toThrow(
      /アクセストークンを取得できませんでした/
    );
  });

  it('設定の取得に失敗しても、次のクリックでやり直せる', async () => {
    installGoogleFakes({ respond: PICKED });
    const failing = new Error('サーバーエラーが発生しました (HTTP 500)。');
    apiGet.mockImplementationOnce(() => Promise.reject(failing));
    const { pickFile } = await loadModule();

    await expect(pickFile({ title: '雛形を選択' })).rejects.toThrow(/HTTP 500/);

    expect(await pickFile({ title: '雛形を選択' })).not.toBeNull();
  });
});
