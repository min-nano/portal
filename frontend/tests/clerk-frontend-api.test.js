// Publishable Key からフロントエンド API のホスト名を取り出す処理のテスト。
//
// ここで取り出したホスト名は、ビルド時に HTML の <head> へ preconnect として
// 書き出される（vite.config.js）。書き出す先なので、
//
//   - 開発（pk_test_）と本番（pk_live_）の両方から取り出せること
//   - 鍵が無い・壊れている・ホスト名として読めないときは null を返し、
//     preconnect を入れないだけで済むこと
//
// の 2 つを固定する。

import { describe, expect, it } from 'vitest';
import { clerkFrontendApiHost } from '../src/clerk-frontend-api.js';

/** ホスト名から Publishable Key を組み立てる（Clerk と同じ規則）。 */
function key(prefix, host) {
  return prefix + Buffer.from(`${host}$`, 'utf8').toString('base64').replace(/=+$/, '');
}

describe('clerkFrontendApiHost', () => {
  it('開発インスタンスの鍵からホスト名を取り出す', () => {
    expect(clerkFrontendApiHost(key('pk_test_', 'sample-app-12.clerk.accounts.dev'))).toBe(
      'sample-app-12.clerk.accounts.dev'
    );
  });

  it('本番インスタンスの鍵からホスト名を取り出す', () => {
    expect(clerkFrontendApiHost(key('pk_live_', 'clerk.portal.example.com'))).toBe(
      'clerk.portal.example.com'
    );
  });

  it('前後の空白は無視する', () => {
    expect(clerkFrontendApiHost(`  ${key('pk_live_', 'clerk.example.com')}  `)).toBe(
      'clerk.example.com'
    );
  });

  it('鍵が無ければ null（preconnect を入れない）', () => {
    expect(clerkFrontendApiHost(undefined)).toBeNull();
    expect(clerkFrontendApiHost('')).toBeNull();
  });

  it('接頭辞が違うものは受け付けない', () => {
    expect(clerkFrontendApiHost(key('sk_live_', 'clerk.example.com'))).toBeNull();
  });

  it('base64 として読めないものは null', () => {
    expect(clerkFrontendApiHost('pk_live_????')).toBeNull();
  });

  it('末尾の $ が無いものは Publishable Key ではない', () => {
    expect(
      clerkFrontendApiHost('pk_live_' + Buffer.from('clerk.example.com').toString('base64'))
    ).toBeNull();
  });

  it('ホスト名として読めないものは書き出さない', () => {
    // ドットが無い / 引用符や空白が混ざっている（HTML に出す値なので通さない）。
    expect(clerkFrontendApiHost(key('pk_live_', 'localhost'))).toBeNull();
    expect(clerkFrontendApiHost(key('pk_live_', 'clerk.example.com"><script'))).toBeNull();
    expect(clerkFrontendApiHost(key('pk_live_', 'clerk example.com'))).toBeNull();
  });
});
