// @vitest-environment jsdom
//
// デザインシステムの見本ページ（/design/）の入口。
//
// 見本ページは「実物と同じ CSS を読み込んで部品を並べるだけ」で、独自の
// 画面ロジックはほとんど持たない。ここで固定するのは、その数少ない 2 つ
// （明暗テーマの切り替えと、判定の升目の切り替え）が、実際の画面と同じ
// 仕組みの上で動いていること。
//
//   - テーマは <html data-theme> で固定する（端末の設定に戻せる）
//   - 判定は升目の印（verdict ok / ng）を入れ替える。結果の帯の色は
//     この印から CSS が決めるので、見本でも同じ印を動かす

import { beforeAll, describe, expect, it } from 'vitest';

const PAGE = `
  <button type="button" id="themeBtn"></button>
  <button type="button" id="verdictBtn"></button>
  <table>
    <tbody>
      <tr>
        <td class="check-value" id="demoVerdictValue">Pa = 5.88 kN/m ≦ 13.72 kN/m</td>
        <td class="step-value verdict ok" id="demoVerdict">OK</td>
      </tr>
    </tbody>
  </table>
`;

function themeButton() {
  return document.getElementById('themeBtn');
}

function verdictCell() {
  return document.getElementById('demoVerdict');
}

beforeAll(async () => {
  document.body.innerHTML = PAGE;
  // 入口は読み込んだ時点で組み立てるので、先に見本ページの中身を置いておく。
  await import('../src/design-system/main.js');
});

describe('テーマの切り替え', () => {
  it('初めは端末の設定に従う（data-theme を付けない）', () => {
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(themeButton().textContent).toBe('テーマ: 端末の設定');
  });

  it('押すたびに 端末の設定 → 明るい → 暗い と一巡する', () => {
    themeButton().click();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(themeButton().textContent).toBe('テーマ: 明るい');

    themeButton().click();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(themeButton().textContent).toBe('テーマ: 暗い');

    themeButton().click();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(themeButton().textContent).toBe('テーマ: 端末の設定');
  });
});

describe('判定の切り替え', () => {
  it('升目の印（verdict ok / ng）と、その根拠の文言が入れ替わる', () => {
    expect(verdictCell().className).toContain('ok');

    document.getElementById('verdictBtn').click();
    expect(verdictCell().className).toContain('ng');
    expect(verdictCell().className).not.toContain('ok');
    expect(verdictCell().textContent).toBe('NG');
    // 判定と根拠は食い違わない（NG のときは適用範囲を外れた値になる）。
    expect(document.getElementById('demoVerdictValue').textContent).toContain('>');

    document.getElementById('verdictBtn').click();
    expect(verdictCell().className).toContain('ok');
    expect(verdictCell().textContent).toBe('OK');
    expect(document.getElementById('demoVerdictValue').textContent).toContain('≦');
  });
});
