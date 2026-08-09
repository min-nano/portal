// カスタムドメインへのリダイレクト判定のテスト。
//
// 本番の .web.app / .firebaseapp.com からはカスタムドメインへ寄せる一方、
// PR プレビュー・ローカル開発・カスタムドメイン自身では動かないことを保証する。

import { describe, expect, it } from 'vitest';
import { canonicalRedirectUrl } from '../src/canonical-host.js';

const CANONICAL = 'portal.example.com';

describe('canonicalRedirectUrl', () => {
  it('本番の .web.app からカスタムドメインへ寄せる', () => {
    expect(canonicalRedirectUrl('https://my-project.web.app/', CANONICAL)).toBe(
      'https://portal.example.com/'
    );
  });

  it('.firebaseapp.com からも寄せる', () => {
    expect(
      canonicalRedirectUrl('https://my-project.firebaseapp.com/', CANONICAL)
    ).toBe('https://portal.example.com/');
  });

  it('パス・クエリ・ハッシュを保持する', () => {
    expect(
      canonicalRedirectUrl(
        'https://my-project.web.app/tools/excel-report-formatter/?q=1#top',
        CANONICAL
      )
    ).toBe('https://portal.example.com/tools/excel-report-formatter/?q=1#top');
  });

  it('PR プレビューのホストは対象外（プレビューは本番と別環境として使う）', () => {
    expect(
      canonicalRedirectUrl('https://my-project--pr-2-1cxlmje2.web.app/', CANONICAL)
    ).toBeNull();
  });

  it('カスタムドメイン自身ではリダイレクトしない（ループ防止）', () => {
    expect(canonicalRedirectUrl('https://portal.example.com/', CANONICAL)).toBeNull();
  });

  it('ローカル開発ではリダイレクトしない', () => {
    expect(canonicalRedirectUrl('http://localhost:5173/', CANONICAL)).toBeNull();
  });

  it('カスタムドメイン未設定ならリダイレクトしない', () => {
    expect(canonicalRedirectUrl('https://my-project.web.app/', undefined)).toBeNull();
    expect(canonicalRedirectUrl('https://my-project.web.app/', '')).toBeNull();
    expect(canonicalRedirectUrl('https://my-project.web.app/', '   ')).toBeNull();
  });

  it('Firebase 既定ドメイン以外（別のカスタムドメインなど）は触らない', () => {
    expect(canonicalRedirectUrl('https://other.example.com/', CANONICAL)).toBeNull();
  });

  it('ホスト名の部分一致では誤判定しない', () => {
    // .web.app で終わらないので対象外。
    expect(canonicalRedirectUrl('https://web.app.example.com/', CANONICAL)).toBeNull();
  });
});
