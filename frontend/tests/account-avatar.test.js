// ヘッダーのアバターに出す画像の選び方（Clerk のユーザーから）。

import { describe, expect, it } from 'vitest';
import { avatarUrl } from '../src/account-avatar.js';

describe('avatarUrl', () => {
  it('本人の写真があればそれを使う', () => {
    expect(
      avatarUrl({
        hasImage: true,
        imageUrl: 'https://img.example/own.png',
        externalAccounts: [{ provider: 'google', imageUrl: 'https://img.example/google.png' }],
      })
    ).toBe('https://img.example/own.png');
  });

  it('Clerk の既定のアイコンは使わず、Google アカウントの写真を使う', () => {
    expect(
      avatarUrl({
        hasImage: false,
        imageUrl: 'https://img.example/default.png',
        externalAccounts: [
          { provider: 'github', imageUrl: 'https://img.example/github.png' },
          { provider: 'google', imageUrl: 'https://img.example/google.png' },
        ],
      })
    ).toBe('https://img.example/google.png');
  });

  it('Google が無ければ、ほかの外部アカウントの写真を使う', () => {
    expect(
      avatarUrl({
        hasImage: false,
        imageUrl: 'https://img.example/default.png',
        externalAccounts: [
          { provider: 'google', imageUrl: '' },
          { provider: 'github', imageUrl: 'https://img.example/github.png' },
        ],
      })
    ).toBe('https://img.example/github.png');
  });

  it('どこにも写真が無ければ undefined（頭文字を出す）', () => {
    expect(avatarUrl({ hasImage: false, imageUrl: 'https://img.example/default.png' })).toBeUndefined();
    expect(
      avatarUrl({ hasImage: false, externalAccounts: [{ provider: 'google', imageUrl: '' }] })
    ).toBeUndefined();
  });
});
