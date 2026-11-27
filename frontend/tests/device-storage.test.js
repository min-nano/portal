// @vitest-environment jsdom
//
// この端末の保存場所（device-storage.js）。サイトのデータを禁止したブラウザでは
// localStorage を読んだだけで SecurityError になるので、そのときは null を返す。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceStorage } from '../src/device-storage.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deviceStorage', () => {
  it('ふだんは localStorage を返す', () => {
    expect(deviceStorage()).toBe(globalThis.localStorage);
  });

  it('読んだだけで例外になるブラウザでは、null を返す（例外を外へ出さない）', () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    expect(deviceStorage()).toBeNull();
  });

  it('localStorage の無い環境でも、null を返す', () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockReturnValue(undefined);

    expect(deviceStorage()).toBeNull();
  });
});
