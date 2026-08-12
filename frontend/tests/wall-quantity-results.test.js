// @vitest-environment jsdom
//
// 必要壁量ツールの「出力結果」。
//
// 計算そのものは Rust → wasm（core/src/wall_quantity.rs）が持っていて、
// 画面はその結果を並べるだけ。ここでは
//
//   1. 本物の .wasm を読み込んで、フォームの入力からグレー本ならぬ配布物の
//      入力例と同じ値が返ること（サーバと同じ計算が画面でもできること）
//   2. 返ってきた節・表・升目が、そのとおりに描かれること
//   3. 保存時の突き合わせ（画面が送る材料と、警告の文言）
//
// を確かめる。.wasm はコミットしていないので、手元で初めて動かすときは
// 先に core/build.sh を実行すること。

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { instantiateCore } from '../src/core.js';
import { buildResults } from '../src/wall-quantity-calculator/form-dom.js';
import {
  resultCells,
  verificationFromHeaders,
  verificationOf,
  verificationWarning,
} from '../src/wall-quantity-calculator/form-logic.js';

// jsdom の中では import.meta.url がファイルの URL にならないので、
// vitest の作業ディレクトリ（frontend/）から辿る。
const WASM_PATH = resolve(process.cwd(), '../backend/app/wasm/nail_array_core.wasm');

/** 配布物の「表計算ツール入力例」シートと同じ入力（2 階建て・多雪区域）。 */
const EXAMPLE = {
  building: 'two_story',
  usage: 'performance',
  toggles: { use_column_1: true, use_column_2: true, use_column_3: true },
  values: {
    height_2f: '3',
    height_1f: '3',
    ridge_minus_eaves: '0.5',
    seismic_zone: '0.9',
    base_shear: '0.2',
    heavy_snow: 'あり(多雪区域)',
    snow_depth: '100',
    snow_unit_load: '30',
    floor_area_2f: '60',
    floor_area_1f: '60',
    eaves: '0.5',
    roof_pitch: '4',
    roof_spec: 'スレート屋根',
    wall_spec: 'サイディング',
    solar: 'あり(200)\n（部位面積あたり）',
    ceiling_insulation: '100\n（初期値・天井）',
    wall_insulation: '70（初期値）',
    // 2-2 の柱材（①だけ選び、②③は未選択、④は大臣認定で未入力）。
    'c2_2f_①_jas': 'JAS目視等級区分構造用製材',
    'c2_2f_①_species': 'すぎ',
    'c2_2f_①_grade': '二級',
    'c2_1f_①_jas': 'JAS目視等級区分構造用製材',
    'c2_1f_①_species': 'すぎ',
    'c2_1f_①_grade': '二級',
  },
};

let core = null;

beforeAll(async () => {
  let bytes;
  try {
    bytes = await readFile(WASM_PATH);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(
      '計算実装（wasm）がありません。リポジトリ直下で core/build.sh を' +
        '実行してから、もう一度テストしてください（要 rustup）。'
    );
  }
  core = await instantiateCore(bytes);
});

function compute(data) {
  return core.call({ op: 'wallQuantity', data }).result;
}

describe('画面での計算', () => {
  it('配布物の入力例と同じ必要壁量を出す', () => {
    const cells = resultCells(compute(EXAMPLE));

    expect(cells['lw.1f.grade1']).toBe('44');
    expect(cells['lw.2f.grade1']).toBe('25');
    expect(cells['lw.1f.grade2']).toBe('64');
    expect(cells['lw.2f.grade3']).toBe('53');
  });

  it('配布物の入力例と同じ柱の小径を出す', () => {
    const cells = resultCells(compute(EXAMPLE));

    // 2-1（すぎ・無等級材を前提にした早見）。
    expect(cells['column1.2f.size']).toBe('84');
    expect(cells['column1.1f.ratio']).toBe('１/27.4');
    // 2-2（すぎ 二級 Fc = 20.4）。
    expect(cells['column2.2f.1.fc']).toBe('20.4');
    expect(cells['column2.2f.1.size']).toBe('81');
    // 選んでいない行は、配布物と同じく「該当なし」。
    expect(cells['column2.2f.2.fc']).toBe('該当なし');
  });

  it('入力が足りないうちは、配布物と同じく空欄で返る', () => {
    const cells = resultCells(
      compute({ building: 'one_story', usage: 'standard', values: {} })
    );

    expect(cells['lw.1f.grade1']).toBe('');
    // 基準法のときは耐震等級の行そのものが無い。
    expect(cells['lw.1f.grade2']).toBeUndefined();
  });

  it('用途を選んでいなければ、直せる案内を投げる', () => {
    expect(() => compute({ building: 'one_story', usage: '', values: {} })).toThrow(
      /設計の用途/
    );
  });
});

describe('buildResults', () => {
  it('節ごとに表を作り、升目に key を持たせる', () => {
    const root = buildResults(document, compute(EXAMPLE));

    const sections = root.querySelectorAll('[data-result-section]');
    expect([...sections].map((s) => s.dataset.resultSection)).toEqual([
      'wall_quantity',
      'column_1',
      'column_2',
      'column_3',
    ]);
    const cell = root.querySelector('[data-result-key="lw.1f.grade1"]');
    expect(cell.textContent).toBe('44');
    // 1階・2階の列と、等級 1〜3 の行。
    const table = cell.closest('table');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(
      ['', '1階', '2階']
    );
    expect([...table.querySelectorAll('tbody th')].map((th) => th.textContent)).toEqual(
      ['等級1', '等級2', '等級3']
    );
  });

  it('空欄は「—」にして、埋まっている升目と見分けられるようにする', () => {
    const root = buildResults(document, compute(EXAMPLE));

    // ④（大臣認定）は基準強度を入れていないので空欄。
    const empty = root.querySelector('[data-result-key="column2.2f.4.size"]');
    expect(empty.textContent).toBe('—');
    expect(empty.classList.contains('empty')).toBe(true);
    const filled = root.querySelector('[data-result-key="column2.2f.1.size"]');
    expect(filled.classList.contains('empty')).toBe(false);
  });

  it('使わない算定方法は、表の代わりに案内を出す', () => {
    const root = buildResults(document, compute({ ...EXAMPLE, toggles: {} }));

    const section = root.querySelector('[data-result-section="column_1"]');
    expect(section.querySelector('table')).toBe(null);
    expect(section.textContent).toContain('チェック');
  });

  it('結果が無ければ空のまま', () => {
    expect(buildResults(document, null).children.length).toBe(0);
  });
});

describe('保存時の突き合わせ', () => {
  it('画面が出していた値を、そのまま送る材料にする', () => {
    const result = compute(EXAMPLE);

    const claim = verificationOf('2.0.0', result);

    expect(claim.coreVersion).toBe('2.0.0');
    expect(claim.cells['lw.1f.grade1']).toBe('44');
  });

  it('食い違いが無ければ警告を出さない', () => {
    expect(verificationWarning({ checked: true, ok: true })).toBe('');
    expect(verificationWarning({ checked: false, ok: true })).toBe('');
    expect(verificationWarning(null)).toBe('');
  });

  it('食い違った升目を挙げる', () => {
    const warning = verificationWarning({
      checked: true,
      ok: false,
      coreVersion: { client: '2.0.0', server: '2.0.0' },
      differences: [{ key: 'lw.1f.grade1', client: '1', server: '44' }],
      omittedDifferences: 3,
    });

    expect(warning).toContain('lw.1f.grade1');
    expect(warning).toContain('画面 1');
    expect(warning).toContain('サーバー 44');
    expect(warning).toContain('ほか 3 件');
  });

  it('計算実装の版が違えば、読み込み直すよう促す', () => {
    const warning = verificationWarning({
      checked: true,
      ok: false,
      coreVersion: { client: '1.0.0', server: '2.0.0' },
      differences: [],
    });

    expect(warning).toContain('再読み込み');
  });

  it('応答ヘッダから突き合わせ結果を読む', () => {
    const headers = new Headers({
      'X-Wall-Quantity-Verification': '{"checked":true,"ok":true}',
    });

    expect(verificationFromHeaders(headers)).toEqual({ checked: true, ok: true });
    expect(verificationFromHeaders(new Headers())).toBe(null);
    expect(
      verificationFromHeaders(new Headers({ 'X-Wall-Quantity-Verification': '{' }))
    ).toBe(null);
  });
});
