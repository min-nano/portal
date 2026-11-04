// @vitest-environment jsdom
//
// 雛形を Drive に置くツールの画面（main.js）の、タイトル横の雛形のファイル名。
//
// 実際のページのマークアップ（page.html / overlay.html）の上でツールの準備
// （page-start.js が呼ぶ prepare）を通し、雛形の設定の状態に合わせて
// ファイル名のボタンが押せる / 押せないになること、押したら雛形のプレビュー
// （GET <ツールの API>/template/preview）を開くようにつないであることを固定する。
// プレビューそのものは template-preview.test.js が見る。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prepare: null,
  routes: {},
  connectTemplatePreview: vi.fn(),
}));

vi.mock('../src/page-start.js', () => ({
  startPage: ({ prepare }) => {
    mocks.prepare = prepare;
  },
}));
vi.mock('../src/api.js', () => ({
  apiGet: async (path) => {
    const route = mocks.routes[path];
    if (route instanceof Error) throw route;
    return route;
  },
  apiPostFile: vi.fn(),
  apiPostForBlob: vi.fn(),
  apiSendJson: vi.fn(),
}));
vi.mock('../src/drive-picker.js', () => ({ pickFile: vi.fn() }));
vi.mock('../src/template-preview.js', () => ({
  connectTemplatePreview: (...args) => mocks.connectTemplatePreview(...args),
}));

// 証明書ツールの画面の組み立てに使う定義（項目は無くてよい）。
const EMPTY_CERT_CONFIG = { text_fields: [], choice_groups: [], sections: [] };
// 傾斜測定の報告フォームの定義（計測点は無くてよい）。
const EMPTY_REPORT_CONFIG = { measurement_groups: [], validation: {}, max_rooms: 3 };

const TOOLS = [
  {
    name: '現況検査レポート作成ツール',
    dir: 'excel-report-formatter',
    api: '/api/tools/excel-report-formatter',
    config: EMPTY_REPORT_CONFIG,
  },
  {
    name: '構造計算安全証明書 作成ツール',
    dir: 'structural-cert-formatter',
    api: '/api/tools/structural-cert-formatter',
    config: EMPTY_CERT_CONFIG,
  },
];

function markup(dir, file) {
  try {
    return readFileSync(resolve(`src/${dir}/${file}`), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return ''; // overlay.html の無いツール
    throw error;
  }
}

/** ツールのページを組み立て、main.js を読み込んで準備（prepare）を通す。 */
async function openTool(tool, templateStatus) {
  vi.resetModules();
  document.body.innerHTML = markup(tool.dir, 'page.html') + markup(tool.dir, 'overlay.html');
  mocks.routes = {
    [`${tool.api}/config`]: tool.config,
    [`${tool.api}/template`]: templateStatus,
  };
  await import('../src/components/index.js');
  await import(`../src/${tool.dir}/main.js`);
  await mocks.prepare();
  return document.getElementById('templateName');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepare = null;
});

describe.each(TOOLS)('$name の雛形のファイル名', (tool) => {
  it('読み込み中は「確認中...」のまま押せない', () => {
    document.body.innerHTML = markup(tool.dir, 'page.html');
    const button = document.getElementById('templateName');

    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent).toBe('確認中...');
    expect(button.disabled).toBe(true);
  });

  it('設定済みなら押せ、押すと雛形のプレビューを開く', async () => {
    const button = await openTool(tool, { configured: true, fileName: '雛形 2026' });

    expect(button.textContent).toBe('雛形 2026');
    expect(button.className).toBe('name');
    expect(button.disabled).toBe(false);
    expect(button.title).toBe('雛形 2026（押すと中身を表示します）');
    expect(mocks.connectTemplatePreview).toHaveBeenCalledWith(button, `${tool.api}/template/preview`);
  });

  it('未設定なら押せない', async () => {
    const button = await openTool(tool, { configured: false, fileName: '' });

    expect(button.textContent).toBe('未設定');
    expect(button.className).toBe('unset');
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('未設定');
  });

  it('設定を読めなければ押せず、理由は画面下に出す', async () => {
    const button = await openTool(tool, new Error('サーバーエラーが発生しました (HTTP 500)。'));

    expect(button.textContent).toBe('取得できません');
    expect(button.disabled).toBe(true);
    expect(document.getElementById('message').innerText).toBe('サーバーエラーが発生しました (HTTP 500)。');
  });
});
