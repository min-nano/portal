// 画面のファイル名の整形が、サーバの整形と 1 文字も違わないことを縛る。
//
// 計算（wasm）と違って、ファイル名の規則はサーバと画面に 1 つずつ実装がある
// （backend/app/portal_sdk.py と src/pdf-file-ops.js）。ずれると、保存
// ダイアログに出した名前と実際に Drive へ保存される名前が食い違うので、
// 同じ入力に同じ答えを返すことを共有の表で確かめる。
//
// 表はサーバ側のテストと同じ 1 枚（backend/tests/file_name_cases.json）を
// 読む。片方の実装だけを直したときは、両方のテストが落ちる。

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildFileName,
  ensurePdfExtension,
  sanitizeFileName,
} from '../src/pdf-file-ops.js';

const shared = JSON.parse(
  readFileSync(
    new URL('../../backend/tests/file_name_cases.json', import.meta.url),
    'utf8'
  )
);

describe('ファイル名の規則（サーバと共通）', () => {
  it.each(shared.cases)('$given', ({ given, sanitized, withExtension }) => {
    expect(sanitizeFileName(given)).toBe(sanitized);
    expect(ensurePdfExtension(given, shared.default)).toBe(withExtension);
  });
});

describe('雛形からの組み立て（サーバと共通）', () => {
  it.each(shared.templates)('$template', ({ template, values, expected }) => {
    expect(buildFileName(template, values, shared.default)).toBe(expected);
  });
});
