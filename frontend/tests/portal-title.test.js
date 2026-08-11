// ポータル表示名（VITE_PORTAL_TITLE）の解決とエスケープのテスト。
//
// 未設定でもビルドが壊れず既定値になること、記号を含む名前でも HTML を
// 壊さないことを保証する。

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORTAL_TITLE,
  escapeHtml,
  resolvePortalTitle,
} from '../src/portal-title.js';

describe('resolvePortalTitle', () => {
  it('設定されていればその値を使う', () => {
    expect(resolvePortalTitle('○○建築設計事務所 ポータル')).toBe(
      '○○建築設計事務所 ポータル'
    );
  });

  it('前後の空白は落とす', () => {
    expect(resolvePortalTitle('  設計ポータル  ')).toBe('設計ポータル');
  });

  it('未設定・空文字・空白のみなら既定値', () => {
    expect(resolvePortalTitle(undefined)).toBe(DEFAULT_PORTAL_TITLE);
    expect(resolvePortalTitle('')).toBe(DEFAULT_PORTAL_TITLE);
    expect(resolvePortalTitle('   ')).toBe(DEFAULT_PORTAL_TITLE);
  });
});

describe('escapeHtml', () => {
  it('HTML の特殊文字をエスケープする', () => {
    expect(escapeHtml('A & B <span> "x" \'y\'')).toBe(
      'A &amp; B &lt;span&gt; &quot;x&quot; &#39;y&#39;'
    );
  });

  it('通常の表示名はそのまま', () => {
    expect(escapeHtml(DEFAULT_PORTAL_TITLE)).toBe(DEFAULT_PORTAL_TITLE);
  });
});
