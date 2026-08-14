// @vitest-environment jsdom
//
// ページ共通の部品（ヘッダー・サインインゲート・PDF ツールのファイル操作）。
// これらは既存のコード（auth.js・save-dialogs.js・各ツールの main.js）が
// id で探すマークアップを 1 か所にまとめたものなので、その id と初期状態が
// 変わっていないことを固定する。

import { beforeEach, describe, expect, it } from 'vitest';
import '../src/components/index.js';
import {
  finishPageLoading,
  setPageLoadingLabel,
  showApp,
} from '../src/components/loading.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('portal-header', () => {
  it('ポータル名とアカウント欄（初めは隠す）を出す', () => {
    document.body.innerHTML =
      '<portal-header class="portal-header" portal-name="社内ポータル"></portal-header>';

    expect(document.querySelector('.title').textContent).toBe('社内ポータル');
    // トップページ自身ではリンクにしない。
    expect(document.querySelector('.title a')).toBeNull();
    expect(document.getElementById('accountArea').hidden).toBe(true);
    expect(document.getElementById('accountEmail')).not.toBeNull();
    expect(document.getElementById('signOutBtn').textContent).toBe('サインアウト');
  });

  it('home 属性を付けるとトップページへのリンクになる', () => {
    document.body.innerHTML = '<portal-header portal-name="社内ポータル" home></portal-header>';

    const link = document.querySelector('.title a');
    expect(link.getAttribute('href')).toBe('/');
    expect(link.textContent).toBe('社内ポータル');
  });

  it('読み込み直しても中身が二重にならない', () => {
    document.body.innerHTML = '<portal-header portal-name="社内ポータル"></portal-header>';
    const header = document.querySelector('portal-header');
    document.body.appendChild(header); // 付け直し（connectedCallback がもう一度走る）

    expect(document.querySelectorAll('#accountArea')).toHaveLength(1);
  });
});

describe('portal-loading', () => {
  it('HTML に書いた文言をそのまま使う（JS で作り直さない）', () => {
    document.body.innerHTML =
      '<portal-loading id="pageLoading" class="page-loading">サインインを確認しています…</portal-loading>';

    const loading = document.getElementById('pageLoading');
    expect(loading.textContent).toBe('サインインを確認しています…');
    // 回る輪は CSS の擬似要素で描くので、中に印は作らない。
    expect(loading.children).toHaveLength(0);
    // 待ち終わりが読み上げに伝わるようにする。
    expect(loading.getAttribute('role')).toBe('status');
  });

  it('文言を書かずに置いたときだけ既定の文言を入れる', () => {
    document.body.innerHTML = '<portal-loading class="page-loading"></portal-loading>';

    expect(document.querySelector('portal-loading').textContent).toBe('読み込んでいます…');
  });

  it('待っているものが変わったら、文言だけ差し替える', () => {
    document.body.innerHTML =
      '<portal-loading id="pageLoading" class="page-loading">サインインを確認しています…</portal-loading>';

    setPageLoadingLabel('計算の準備をしています…');

    const loading = document.getElementById('pageLoading');
    expect(loading.textContent).toBe('計算の準備をしています…');
    // 差し替えても表示は消えない（待ちは続いている）。
    expect(loading.isConnected).toBe(true);
  });

  it('finishPageLoading で消える（サインイン画面を出すとき）', () => {
    document.body.innerHTML =
      '<portal-loading id="pageLoading" class="page-loading">…</portal-loading>';

    finishPageLoading();

    expect(document.getElementById('pageLoading')).toBeNull();
    // 表示が無いページ（見本ページなど）で呼んでも何も起きない。
    expect(() => finishPageLoading()).not.toThrow();
    expect(() => setPageLoadingLabel('…')).not.toThrow();
  });

  it('done() でも消える（要素から直に終わらせる）', () => {
    document.body.innerHTML =
      '<portal-loading id="pageLoading" class="page-loading">…</portal-loading>';

    document.getElementById('pageLoading').done();

    expect(document.getElementById('pageLoading')).toBeNull();
  });

  it('showApp で画面が出て、読み込み中が消える（入力できるようになった時点）', () => {
    document.body.innerHTML =
      '<portal-loading id="pageLoading" class="page-loading">…</portal-loading>' +
      '<div id="app" class="container" hidden></div>';

    showApp();

    expect(document.getElementById('app').hidden).toBe(false);
    expect(document.getElementById('pageLoading')).toBeNull();
  });
});

describe('portal-auth-gate', () => {
  it('案内文と Clerk のマウント先を出す', () => {
    document.body.innerHTML =
      '<portal-auth-gate id="authGate" class="auth-gate" hidden></portal-auth-gate>';

    const gate = document.getElementById('authGate');
    expect(gate.hidden).toBe(true);
    expect(gate.querySelector('.note').textContent).toContain('Google アカウント');
    expect(gate.querySelector('.clerk-mount')).not.toBeNull();
  });

  it('サインイン画面が現れるまで、マウント先に読み込み中を出しておく', () => {
    document.body.innerHTML =
      '<portal-auth-gate id="authGate" class="auth-gate" hidden></portal-auth-gate>';

    const loading = document.querySelector('.clerk-mount portal-loading');
    expect(loading).not.toBeNull();
    expect(loading.textContent).toContain('サインイン画面');
  });
});

describe('portal-edit-bar / portal-save-bar / portal-save-dialogs', () => {
  it('ファイル操作の欄を出す（pdf-file-ops.js が触る id）', () => {
    document.body.innerHTML = '<portal-edit-bar class="edit-bar"></portal-edit-bar>';

    expect(document.getElementById('sourceName').textContent).toBe('なし（新規作成）');
    expect(document.getElementById('sourceNote').hidden).toBe(true);
    ['newBtn', 'loadBtn', 'uploadBtn'].forEach((id) => {
      expect(document.getElementById(id).type).toBe('button');
    });
    const upload = document.getElementById('uploadInput');
    expect(upload.type).toBe('file');
    expect(upload.accept).toBe('application/pdf,.pdf');
    expect(upload.hidden).toBe(true);
  });

  it('保存欄は disabled 属性を付けると押せない状態から始まる', () => {
    document.body.innerHTML =
      '<portal-save-bar class="save-bar"></portal-save-bar>' +
      '<portal-save-bar id="locked" class="save-bar" disabled></portal-save-bar>';

    const bars = document.querySelectorAll('portal-save-bar');
    expect(bars[0].querySelector('#submitBtn').disabled).toBe(false);
    expect(bars[1].querySelector('#submitBtn').disabled).toBe(true);
    expect(bars[1].querySelector('#saveAsBtn').disabled).toBe(true);
  });

  it('2 つのダイアログを出す（save-dialogs.js が触る id）', () => {
    document.body.innerHTML =
      '<portal-save-dialogs name-placeholder="構造計算安全証明書.pdf"></portal-save-dialogs>';

    expect(document.getElementById('unsavedMessage')).not.toBeNull();
    const choices = document.querySelectorAll('#unsavedDialog [data-choice]');
    expect([...choices].map((b) => b.dataset.choice)).toEqual([
      'save',
      'discard',
      'cancel',
    ]);

    expect(document.getElementById('saveAsTitle').textContent).toBe('別名で保存');
    expect(document.getElementById('saveAsName').placeholder).toBe(
      '構造計算安全証明書.pdf'
    );
    expect(document.getElementById('saveAsFolderName').textContent).toBe('未選択');
    // 名前と保存先が決まるまで保存できない（save-dialogs.js が有効にする）。
    expect(document.getElementById('saveAsConfirmBtn').disabled).toBe(true);
  });
});
