// @vitest-environment jsdom
//
// 画面 ↔ データの往復と、計算実装が返した表示用の値の描画。
// 数値の丸めや単位は計算実装（core/、wasm）の文字列をそのまま出す
// （画面と計算書 PDF で桁がずれないこと）を、ここで固定する。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyPattern,
  applyWall,
  readPattern,
  readWall,
  renderMaterialOptions,
  renderPatternBar,
  renderPresetOptions,
  renderResult,
  renderWallBar,
  renderWallResult,
  showPanelArea,
} from '../src/timber-panel-shear-calculator/form-dom.js';

// tools/timber-panel-shear-calculator/index.html の、この関数群が触る部分。
const MARKUP = `
  <form id="calcForm">
    <select id="presetSelect"><option value="">選択すると…</option></select>
    <input type="text" id="patternName">
    <input type="number" id="patternWidth">
    <input type="number" id="patternHeight">
    <span id="panelArea">-</span>
    <label><input type="radio" name="nailMode" value="grid" checked></label>
    <label><input type="radio" name="nailMode" value="coords"></label>
    <div id="gridInputs">
      <input type="text" id="gridX">
      <input type="text" id="gridY">
    </div>
    <div id="coordsInputs" hidden><textarea id="coords"></textarea></div>
    <span id="patternPosition"></span>
    <button type="button" id="prevBtn"></button>
    <button type="button" id="nextBtn"></button>
    <button type="button" id="removePatternBtn"></button>
    <div id="patternTabs"></div>
    <p id="resultNote"></p>
    <div id="resultError" hidden></div>
    <div id="summary"></div>
    <table><tbody id="stepsBody"></tbody></table>
    <svg id="diagram"></svg>
  </form>
`;

const PATTERN = {
  patternId: 'p1',
  patternName: 'グレー本の計算例',
  width: 910,
  height: 610,
  mode: 'grid',
  gridX: '10, 455, 900',
  gridY: '10, 155, 305, 455, 600',
  coords: '',
};

// 計算実装（wasm）が返す形（数値は文字列として組み立て済み）。
const REPORT = {
  ok: true,
  patternId: 'p1',
  nails: [
    { x: 10, y: 10 },
    { x: 455, y: 305 },
    { x: 900, y: 600 },
  ],
  result: { x0: 455, y0: 305 },
  diagram: {
    minX: 0,
    maxX: 910,
    minY: 0,
    maxY: 610,
    xTicks: [
      { value: 10, label: '10' },
      { value: 455, label: '455' },
      { value: 900, label: '900' },
    ],
    yTicks: [
      { value: 10, label: '10' },
      { value: 305, label: '305' },
      { value: 600, label: '600' },
    ],
    axis: { x0: 455, y0: 305, xLabel: 'x0 = 455.0', yLabel: 'y0 = 305.0' },
  },
  summary: [
    { key: 'Ixy', unit: 'mm²/mm²', value: '0.888868' },
    { key: 'Zxy', unit: 'mm/mm²', value: '0.00358851' },
    { key: 'Cxy', unit: '', value: '1.26155' },
  ],
  steps: [
    { label: '釘本数 n', eq: '', value: '15' },
    { label: 'Cxy', eq: '(3.2.5)', value: '1.26155' },
  ],
};

beforeEach(() => {
  document.body.innerHTML = MARKUP;
});

describe('applyPattern / readPattern', () => {
  it('入力欄へ写した内容をそのまま読み戻せる', () => {
    applyPattern(document, PATTERN);

    // patternId は画面が持たないので、読み取りの対象外。
    const { patternId, ...editable } = PATTERN;
    expect(readPattern(document)).toEqual(editable);
  });

  it('入力方式に応じて格子／座標の欄を出し分ける', () => {
    applyPattern(document, PATTERN);
    expect(document.getElementById('gridInputs').hidden).toBe(false);
    expect(document.getElementById('coordsInputs').hidden).toBe(true);

    applyPattern(document, { ...PATTERN, mode: 'coords', coords: '10, 10' });
    expect(document.getElementById('gridInputs').hidden).toBe(true);
    expect(document.getElementById('coordsInputs').hidden).toBe(false);
    expect(readPattern(document).mode).toBe('coords');
  });

  it('面積の目安を幅 × 高さから出す', () => {
    applyPattern(document, PATTERN);
    expect(document.getElementById('panelArea').textContent).toBe('555,100 mm²');

    document.getElementById('patternWidth').value = '';
    showPanelArea(document);
    expect(document.getElementById('panelArea').textContent).toBe('-');
  });
});

// 計算実装（wasm）が配る一覧の形（グレー本 表 3.2.1）。
const PRESETS = [
  {
    id: '910x610-s455-n150-kawa',
    sizeLabel: '910×610',
    orientation: '横置',
    arrangementLabel: '川型',
    arrangementNote: '面材の左右の端と間柱に釘を打つ',
    studPitch: 455,
    nailPitch: 150,
    nailCount: 15,
  },
  {
    id: '910x610-s455-n150-hi',
    sizeLabel: '910×610',
    orientation: '横置',
    arrangementLabel: '日型',
    arrangementNote: '川型に加えて、上下端の横架材にも釘を打つ',
    studPitch: 455,
    nailPitch: 150,
    nailCount: 23,
  },
  {
    id: '910x610-s455-n100-kawa',
    sizeLabel: '910×610',
    orientation: '横置',
    arrangementLabel: '川型',
    arrangementNote: '面材の左右の端と間柱に釘を打つ',
    studPitch: 455,
    nailPitch: 100,
    nailCount: 21,
  },
];

describe('renderPresetOptions', () => {
  it('面材寸法とピッチごとにまとめ、型を選べるようにする', () => {
    renderPresetOptions(document, PRESETS);

    const groups = [...document.querySelectorAll('#presetSelect optgroup')];
    expect(groups.map((g) => g.label)).toEqual([
      '910×610 横置（間柱・根太 @455 / 釘 @150）',
      '910×610 横置（間柱・根太 @455 / 釘 @100）',
    ]);
    expect([...groups[0].children].map((o) => o.textContent)).toEqual([
      '川型（釘 15 本）',
      '日型（釘 23 本）',
    ]);
    expect(groups[0].children[0].value).toBe('910x610-s455-n150-kawa');
  });

  it('「選択すると…」の 1 行は残し、描き直しても増やさない', () => {
    renderPresetOptions(document, PRESETS);
    renderPresetOptions(document, PRESETS);

    const select = document.getElementById('presetSelect');
    expect(select.options[0].value).toBe('');
    expect(select.options).toHaveLength(1 + PRESETS.length);
  });
});

describe('renderPatternBar', () => {
  it('現在位置とタブを描き、端では送りボタンを止める', () => {
    const patterns = [{ patternName: '南面' }, { patternName: '' }];

    renderPatternBar(document, patterns, 0, () => {});

    expect(document.getElementById('patternPosition').textContent).toBe(
      'パターン 1 / 2'
    );
    expect(document.getElementById('prevBtn').disabled).toBe(true);
    expect(document.getElementById('nextBtn').disabled).toBe(false);
    expect(document.getElementById('removePatternBtn').disabled).toBe(false);

    const tabs = [...document.querySelectorAll('#patternTabs .tab')];
    expect(tabs.map((t) => t.textContent)).toEqual(['南面', 'パターン2']);
    expect(tabs[0].className).toContain('current');
  });

  it('パターンが 1 つなら削除できない', () => {
    renderPatternBar(document, [{ patternName: '南面' }], 0, () => {});

    expect(document.getElementById('removePatternBtn').disabled).toBe(true);
  });

  it('タブを押すと、その位置が呼び出し側へ伝わる', () => {
    const selected = [];
    renderPatternBar(document, [{}, {}], 0, (index) => selected.push(index));

    document.querySelectorAll('#patternTabs .tab')[1].click();

    expect(selected).toEqual([1]);
  });
});

describe('renderResult', () => {
  it('計算実装が組み立てた文字列をそのまま並べる', () => {
    renderResult(document, REPORT, PATTERN);

    const boxes = [...document.querySelectorAll('.result-box')];
    expect(boxes.map((b) => b.querySelector('.key').textContent)).toEqual([
      'Ixy [mm²/mm²]',
      'Zxy [mm/mm²]',
      'Cxy',
    ]);
    expect(boxes.map((b) => b.querySelector('.value').textContent)).toEqual([
      '0.888868',
      '0.00358851',
      '1.26155',
    ]);

    const rows = [...document.querySelectorAll('#stepsBody tr')];
    expect(rows).toHaveLength(2);
    expect(rows[1].querySelector('.step-eq').textContent).toBe('(3.2.5)');
    expect(rows[1].querySelector('.step-value').textContent).toBe('1.26155');

    expect(document.getElementById('resultError').hidden).toBe(true);
    expect(document.getElementById('resultNote').hidden).toBe(true);
  });

  it('釘配列図を描く（釘の数だけ点が並ぶ）', () => {
    renderResult(document, REPORT, PATTERN);

    const diagram = document.getElementById('diagram');
    // SVG 要素には hidden プロパティが無いので、属性で出し分ける。
    expect(diagram.hasAttribute('hidden')).toBe(false);
    expect(diagram.querySelectorAll('circle')).toHaveLength(3);
    // 中立軸（x0 / y0）の破線。
    expect(diagram.querySelectorAll('line[stroke-dasharray]')).toHaveLength(2);
  });

  it('計算できないパターンは理由を出し、結果と図を空にする', () => {
    renderResult(document, REPORT, PATTERN);
    renderResult(
      document,
      { ok: false, patternId: 'p1', error: '釘座標のリストが空です。' },
      PATTERN
    );

    expect(document.getElementById('resultError').hidden).toBe(false);
    expect(document.getElementById('resultError').textContent).toBe(
      '釘座標のリストが空です。'
    );
    expect(document.querySelectorAll('.result-box')).toHaveLength(0);
    expect(document.getElementById('diagram').hasAttribute('hidden')).toBe(true);
  });

  it('まだ計算していないときは案内だけを出す', () => {
    renderResult(document, null, PATTERN);

    expect(document.getElementById('resultNote').hidden).toBe(false);
    expect(document.getElementById('resultError').hidden).toBe(true);
    expect(document.getElementById('diagram').hasAttribute('hidden')).toBe(true);
  });
});

// --- 壁（グレー本 3.3） -----------------------------------------------------

// tools/timber-panel-shear-calculator/index.html の、壁の節が持つ入力欄。
const WALL_MARKUP = `
  <form id="wallForm">
    <span id="wallPosition"></span>
    <button type="button" id="wallPrevBtn"></button>
    <button type="button" id="wallNextBtn"></button>
    <button type="button" id="removeWallBtn"></button>
    <div id="wallTabs"></div>
    <p id="wallEmptyNote"></p>
    <div id="wallEditor" hidden>
      <input type="text" id="wallName">
      <input type="number" id="wallHeight">
      <input type="number" id="wallWidth">
      <select id="materialSelect"><option value="">選択すると…</option></select>
      <input type="number" id="wallThickness">
      <input type="number" id="wallShearModulus">
      <input type="number" id="wallK">
      <input type="number" id="wallDeltaV">
      <input type="number" id="wallDeltaU">
      <input type="number" id="wallDeltaPv">
      <div id="wallPanels"></div>
      <div id="wallError" hidden></div>
      <div id="wallSummary"></div>
      <table><thead id="wallPanelHead"></thead><tbody id="wallPanelBody"></tbody></table>
      <table><tbody id="wallStepsBody"></tbody></table>
      <table><tbody id="wallChecksBody"></tbody></table>
    </div>
  </form>
`;

const WALL = {
  wallId: 'w1',
  wallName: 'グレー本 3.3 の計算例',
  height: 3000,
  width: 910,
  materialId: '',
  thickness: 12,
  shearModulus: 0.4,
  k: 0.483,
  deltaV: 2.3,
  deltaU: 17,
  deltaPv: 1.13,
  panels: [{ patternId: 'p1' }, { patternId: 'p2' }],
};

const CHOICES = [
  { patternId: 'p1', label: '下側の面材' },
  { patternId: 'p2', label: '上側の面材' },
];

// 計算実装（wasm）が返す形（数値は文字列として組み立て済み）。
const WALL_REPORT = {
  ok: true,
  wallId: 'w1',
  wallName: 'グレー本 3.3 の計算例',
  panelColumns: ['面材（釘配列パターン）', 'Aw [mm²]', 'μ'],
  panels: [
    { label: '下側の面材', cells: ['1,656,200', '5.25012'] },
    { label: '上側の面材', cells: ['828,100', '5.60468'] },
  ],
  summary: [
    { key: 'K', unit: 'kN/rad', value: '1,258.14' },
    { key: 'Pa', unit: 'kN', value: '8.38761' },
    { key: 'ΔPa', unit: 'kN/m', value: '9.21715' },
  ],
  steps: [{ label: '許容せん断耐力 Pa', eq: '(3.3.1)', value: '8.38761 kN' }],
  checks: [
    { label: 'Pa を決めた項', value: '変形角 1/150 時のモーメント K0/150', ok: true },
    { label: '適用範囲 3.3(1)①', value: 'ΔPa = 9.21715 kN/m ≦ 13.7200 kN/m', ok: true },
  ],
};

describe('applyWall / readWall', () => {
  beforeEach(() => {
    document.body.innerHTML = WALL_MARKUP;
  });

  it('入力欄へ写した内容をそのまま読み戻せる', () => {
    applyWall(document, WALL, CHOICES);

    expect(document.getElementById('wallEditor').hidden).toBe(false);
    expect(document.getElementById('wallEmptyNote').hidden).toBe(true);
    // wallId は画面が持たないので、読み戻しでは付かない。
    const { wallId, ...rest } = WALL;
    expect(readWall(document)).toEqual(rest);
  });

  it('壁が 1 枚も無ければ、編集欄を隠して案内だけを出す', () => {
    applyWall(document, null, CHOICES);

    expect(document.getElementById('wallEditor').hidden).toBe(true);
    expect(document.getElementById('wallEmptyNote').hidden).toBe(false);
  });

  it('面材の行は、登録した釘配列パターンから選ぶ', () => {
    applyWall(document, WALL, CHOICES);

    const selects = document.querySelectorAll('select[data-wall-panel]');
    expect(selects).toHaveLength(2);
    // 先頭の「（選択してください）」＋パターンの数。
    expect(selects[0].options).toHaveLength(3);
    expect([...selects[0].options].map((o) => o.textContent)).toEqual([
      '（選択してください）',
      '下側の面材',
      '上側の面材',
    ]);
    expect(selects[1].value).toBe('p2');
  });

  it('消されたパターンを指していた面材は、未選択に戻す', () => {
    applyWall(document, WALL, [CHOICES[0]]);

    const selects = document.querySelectorAll('select[data-wall-panel]');
    expect(selects[0].value).toBe('p1');
    expect(selects[1].value).toBe('');
    // 行そのものは残す（消すと「＋ 面材を追加」で出した行が消えてしまう）。
    // 未選択の面材は、計算実装が読むときに落ちる。
    expect(readWall(document).panels).toEqual([
      { patternId: 'p1' },
      { patternId: '' },
    ]);
  });

  it('未入力の数値は空のまま読み戻す（0 と区別する）', () => {
    applyWall(document, { ...WALL, k: '', deltaPv: '' }, CHOICES);

    const wall = readWall(document);
    expect(wall.k).toBe('');
    expect(wall.deltaPv).toBe('');
    expect(wall.thickness).toBe(12);
  });
});

describe('renderMaterialOptions', () => {
  beforeEach(() => {
    document.body.innerHTML = WALL_MARKUP;
  });

  it('グレー本 表 3.3.1 の組合せを選べるようにする', () => {
    renderMaterialOptions(document, [
      { id: 'plywood12-n50', label: '構造用合板 12mm + 鉄丸釘 N-50' },
      { id: 'mdf9-cn50', label: '構造用 MDF 9mm + 太め鉄丸釘(CN 釘)50' },
    ]);

    const select = document.getElementById('materialSelect');
    expect(select.options).toHaveLength(3); // 先頭の案内 + 2 件
    expect(select.options[1].value).toBe('plywood12-n50');
    expect(select.options[2].textContent).toBe('構造用 MDF 9mm + 太め鉄丸釘(CN 釘)50');
  });

  it('描き直しても選択肢が積み上がらない', () => {
    const materials = [{ id: 'plywood12-n50', label: '構造用合板' }];
    renderMaterialOptions(document, materials);
    renderMaterialOptions(document, materials);

    expect(document.getElementById('materialSelect').options).toHaveLength(2);
  });
});

describe('renderWallBar', () => {
  beforeEach(() => {
    document.body.innerHTML = WALL_MARKUP;
  });

  it('壁が無いときは 0 / 0 と出し、削除も送りもできない', () => {
    renderWallBar(document, [], 0, () => {});

    expect(document.getElementById('wallPosition').textContent).toBe('壁 0 / 0');
    expect(document.getElementById('removeWallBtn').disabled).toBe(true);
    expect(document.getElementById('wallPrevBtn').disabled).toBe(true);
    expect(document.getElementById('wallNextBtn').disabled).toBe(true);
    expect(document.getElementById('wallTabs').children).toHaveLength(0);
  });

  it('タブを並べ、押すと選ばれた位置を知らせる', () => {
    const chosen = [];
    renderWallBar(document, [WALL, { wallName: '' }], 0, (index) => chosen.push(index));

    const tabs = document.getElementById('wallTabs').children;
    expect([...tabs].map((tab) => tab.textContent)).toEqual([
      'グレー本 3.3 の計算例',
      '壁2',
    ]);
    expect(tabs[0].className).toBe('tab current');
    tabs[1].click();
    expect(chosen).toEqual([1]);
  });
});

describe('renderWallResult', () => {
  beforeEach(() => {
    document.body.innerHTML = WALL_MARKUP;
  });

  it('剛性・許容せん断耐力と、面材ごとの値・途中経過・判定を並べる', () => {
    renderWallResult(document, WALL_REPORT);

    expect(document.getElementById('wallError').hidden).toBe(true);
    const boxes = document.querySelectorAll('#wallSummary .result-box');
    expect([...boxes].map((box) => box.querySelector('.key').textContent)).toEqual([
      'K [kN/rad]',
      'Pa [kN]',
      'ΔPa [kN/m]',
    ]);
    expect(boxes[1].querySelector('.value').textContent).toBe('8.38761');

    // 面材ごとの表は、見出しと面材の数だけ行が並ぶ。
    const head = document.querySelectorAll('#wallPanelHead th');
    expect([...head].map((th) => th.textContent)).toEqual(WALL_REPORT.panelColumns);
    const rows = document.querySelectorAll('#wallPanelBody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].children[1].textContent).toBe('1,656,200');

    expect(document.querySelectorAll('#wallStepsBody tr')).toHaveLength(1);
    expect(document.querySelectorAll('#wallChecksBody tr')).toHaveLength(2);
  });

  it('適用範囲を外れた壁は NG と出す', () => {
    const checks = [{ label: '適用範囲', value: 'ΔPa > 13.7200 kN/m', ok: false }];
    renderWallResult(document, { ...WALL_REPORT, checks });

    const cell = document.querySelector('#wallChecksBody tr').children[2];
    expect(cell.textContent).toBe('NG');
    expect(cell.className).toContain('ng');
  });

  it('計算できない壁は理由だけを出す', () => {
    renderWallResult(document, {
      ok: false,
      wallId: 'w1',
      error: '壁を構成する面材がありません。',
    });

    expect(document.getElementById('wallError').hidden).toBe(false);
    expect(document.getElementById('wallError').textContent).toContain('面材がありません');
    expect(document.querySelectorAll('#wallSummary .result-box')).toHaveLength(0);
  });

  it('壁を選んでいなければ、結果の欄を空にする', () => {
    renderWallResult(document, WALL_REPORT);
    renderWallResult(document, null);

    expect(document.getElementById('wallError').hidden).toBe(true);
    expect(document.querySelectorAll('#wallSummary .result-box')).toHaveLength(0);
    expect(document.querySelectorAll('#wallPanelBody tr')).toHaveLength(0);
  });
});
