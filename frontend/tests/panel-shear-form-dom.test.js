// @vitest-environment jsdom
//
// 画面 ↔ データの往復と、計算実装が返した表示用の値の描画。
// 数値の丸めや単位は計算実装（core/、wasm）の文字列をそのまま出す
// （画面と計算書 PDF で桁がずれないこと）を、ここで固定する。
//
// 入力の単位は壁 1 枚で、釘配列（グレー本 3.2）はその壁を構成する面材ごとの
// 入力として中に入る。面材は枚数が変わるので、その入力欄と結果の器は
// form-dom.js が組み立てる。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyWall,
  readPanels,
  readWall,
  renderGradeOptions,
  renderMaterialOptions,
  renderPanelResults,
  renderWallBar,
  renderWallPanels,
  renderWallResult,
  showNailNote,
  showPanelArea,
  syncNailModeVisibility,
} from '../src/timber-panel-shear-calculator/form-dom.js';

// tools/timber-panel-shear-calculator/index.html の、この関数群が触る部分。
const MARKUP = `
  <form id="calcForm">
    <span id="wallPosition"></span>
    <button type="button" id="wallPrevBtn"></button>
    <button type="button" id="wallNextBtn"></button>
    <button type="button" id="removeWallBtn"></button>
    <div id="wallTabs"></div>
    <p id="wallEmptyNote"></p>
    <div id="wallEditor">
      <input type="text" id="wallName">
      <input type="number" id="wallHeight">
      <input type="number" id="wallWidth">
      <select id="materialSelect">
        <option value="">選択すると…</option>
        <option value="plywood12-n65">構造用合板 12mm + 鉄丸釘 N-65</option>
      </select>
      <p id="materialNote"></p>
      <input type="number" id="wallThickness">
      <input type="number" id="wallShearModulus">
      <input type="number" id="wallK">
      <input type="number" id="wallDeltaV">
      <input type="number" id="wallDeltaU">
      <input type="number" id="wallDeltaPv">
      <select id="gradeSelect">
        <option value="">選択すると…</option>
        <option value="plywood-jas1">構造用合板 JAS 1 級</option>
      </select>
      <input type="number" id="wallTauMax">
      <input type="number" id="wallE1">
      <input type="number" id="wallE2">
      <input type="checkbox" id="wallHasStud" checked>
      <div id="wallPanels"></div>
      <div id="wallError" hidden></div>
      <div id="wallSummary"></div>
      <table><thead id="wallPanelHead"></thead><tbody id="wallPanelBody"></tbody></table>
      <table><tbody id="wallStepsBody"></tbody></table>
      <table><thead id="wallBucklingHead"></thead><tbody id="wallBucklingBody"></tbody></table>
      <table><tbody id="wallChecksBody"></tbody></table>
    </div>
  </form>
`;

// 計算実装（wasm）が配る一覧の形（グレー本 表 3.2.1 と、割り付けの型）。
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

const ARRANGEMENTS = [
  { id: 'kawa', label: '川型', note: '面材の左右の端と間柱に釘を打つ' },
  { id: 'yama', label: '山型', note: '川型に加えて、下端の横架材にも釘を打つ' },
  { id: 'ro', label: 'ロ型', note: '面材の四周だけに釘を打つ' },
  { id: 'hi', label: '日型', note: '川型に加えて、上下端の横架材にも釘を打つ' },
];

const OPTIONS = { presets: PRESETS, arrangements: ARRANGEMENTS };

const PANEL = {
  panelId: 'pn1',
  panelName: '下段',
  width: 910,
  height: 610,
  mode: 'layout',
  arrangement: 'kawa',
  studPitch: 455,
  nailPitch: 150,
  edgeDistance: 10,
  gridX: '',
  gridY: '',
  coords: '',
  grain: '',
};

const WALL = {
  wallId: 'w1',
  wallName: 'グレー本 3.3 の計算例',
  height: 3000,
  width: 910,
  materialId: 'plywood12-n65',
  thickness: 12,
  shearModulus: 0.4,
  k: 0.483,
  deltaV: 2.3,
  deltaU: 17,
  deltaPv: 1.13,
  gradeId: 'plywood-jas1',
  tauMax: 3.6,
  e1: 3500,
  e2: 5500,
  hasIntermediateStud: true,
  panels: [
    { ...PANEL },
    { ...PANEL, panelId: 'pn2', panelName: '上段', mode: 'coords', coords: '10, 10\n455, 305', grain: 'width' },
  ],
};

// 計算実装（wasm）が返す形（数値は文字列として組み立て済み）。
const PANEL_REPORT = {
  ok: true,
  panelId: 'pn1',
  panelName: '下段',
  nails: [
    { x: 10, y: 10 },
    { x: 455, y: 305 },
    { x: 900, y: 600 },
  ],
  result: { x0: 455, y0: 305 },
  diagram: {
    panelWidth: 910,
    panelHeight: 610,
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

const WALL_REPORT = {
  ok: true,
  wallId: 'w1',
  wallName: 'グレー本 3.3 の計算例',
  panelReports: [
    PANEL_REPORT,
    { ok: false, panelId: 'pn2', panelName: '上段', error: '釘座標が入力されていません。' },
  ],
  panelColumns: ['面材', 'Aw [mm²]', 'μ'],
  panels: [
    { label: '下段', cells: ['1,656,200', '5.25012'] },
    { label: '上段', cells: ['828,100', '5.60468'] },
  ],
  summary: [
    { key: 'K', unit: 'kN/rad', value: '1,258.14' },
    { key: 'Pa', unit: 'kN', value: '8.38761' },
    { key: 'ΔPa', unit: 'kN/m', value: '9.21715' },
  ],
  steps: [{ label: '許容せん断耐力 Pa', eq: '(3.3.1)', value: '8.38761 kN' }],
  bucklingColumns: ['面材', 'τN [N/mm²]', '判定'],
  buckling: [
    { label: '下段', ok: true, cells: ['1.37631', 'OK'] },
    { label: '上段', ok: true, cells: ['1.39882', 'OK'] },
  ],
  checks: [
    { label: 'Pa を決めた項', value: '変形角 1/150 時のモーメント K0/150', ok: true },
    { label: '適用範囲 3.3(1)①', value: 'ΔPa = 9.21715 kN/m ≦ 13.7200 kN/m', ok: true },
  ],
};

beforeEach(() => {
  document.body.innerHTML = MARKUP;
});

describe('applyWall / readWall', () => {
  it('入力欄へ写した内容を、面材ごとそのまま読み戻せる', () => {
    applyWall(document, WALL, OPTIONS);

    expect(document.getElementById('wallEditor').hidden).toBe(false);
    expect(document.getElementById('wallEmptyNote').hidden).toBe(true);
    // wallId は画面が持たないので、読み戻しでは付かない。
    const { wallId, ...rest } = WALL;
    expect(readWall(document)).toEqual(rest);
  });

  it('壁が 1 枚も無ければ、編集欄を隠して案内だけを出す', () => {
    applyWall(document, null, OPTIONS);

    expect(document.getElementById('wallEditor').hidden).toBe(true);
    expect(document.getElementById('wallEmptyNote').hidden).toBe(false);
  });

  it('未入力の数値は空のまま読み戻す（0 と区別する）', () => {
    applyWall(document, { ...WALL, k: '', deltaPv: '' }, OPTIONS);

    const wall = readWall(document);
    expect(wall.k).toBe('');
    expect(wall.deltaPv).toBe('');
    expect(wall.thickness).toBe(12);
  });
});

describe('renderWallPanels', () => {
  it('面材 1 枚ごとに、寸法・割り付け・へりあきの入力欄を出す', () => {
    renderWallPanels(document, WALL.panels, OPTIONS);

    const panels = document.querySelectorAll('[data-panel-index]');
    expect(panels).toHaveLength(2);
    expect(panels[0].getAttribute('data-panel-id')).toBe('pn1');

    const value = (node, name) =>
      node.querySelector(`[data-panel-field="${name}"]`).value;
    expect(value(panels[0], 'panelName')).toBe('下段');
    expect(value(panels[0], 'width')).toBe('910');
    expect(value(panels[0], 'arrangement')).toBe('kawa');
    expect(value(panels[0], 'nailPitch')).toBe('150');
    expect(value(panels[0], 'edgeDistance')).toBe('10');
    expect(value(panels[1], 'grain')).toBe('width');
  });

  it('割り付けの型は、計算実装が配る一覧から選ぶ', () => {
    renderWallPanels(document, [PANEL], OPTIONS);

    const select = document.querySelector('[data-panel-field="arrangement"]');
    expect([...select.options].map((option) => option.textContent)).toEqual([
      '川型',
      '山型',
      'ロ型',
      '日型',
    ]);
  });

  it('標準的な釘配列（表 3.2.1）は、寸法とピッチごとにまとめて選べる', () => {
    renderWallPanels(document, [PANEL], OPTIONS);

    const select = document.querySelector('[data-panel-preset]');
    const groups = [...select.querySelectorAll('optgroup')];
    expect(groups.map((group) => group.label)).toEqual([
      '910×610 横置（間柱・根太 @455 / 釘 @150）',
      '910×610 横置（間柱・根太 @455 / 釘 @100）',
    ]);
    expect([...groups[0].children].map((option) => option.textContent)).toEqual([
      '川型（釘 15 本）',
      '日型（釘 23 本）',
    ]);
    // 先頭は「読み込む」の 1 行。選ぶまでは何も起きない。
    expect(select.options[0].value).toBe('');
  });

  it('入力方式に応じて、割り付け／格子／座標の欄を出し分ける', () => {
    renderWallPanels(document, WALL.panels, OPTIONS);

    const section = (index, name) =>
      document.querySelectorAll('[data-panel-index]')[index].querySelector(
        `[data-panel-section="${name}"]`
      );
    expect(section(0, 'layout').hidden).toBe(false);
    expect(section(0, 'grid').hidden).toBe(true);
    expect(section(0, 'coords').hidden).toBe(true);
    // 2 枚目は座標を直接入力している。
    expect(section(1, 'layout').hidden).toBe(true);
    expect(section(1, 'coords').hidden).toBe(false);

    // 方式を切り替えると、出す欄も入れ替わる。
    const radios = document
      .querySelectorAll('[data-panel-index]')[0]
      .querySelectorAll('input[data-panel-mode]');
    radios[1].checked = true;
    syncNailModeVisibility(document);
    expect(section(0, 'layout').hidden).toBe(true);
    expect(section(0, 'grid').hidden).toBe(false);
    expect(readPanels(document)[0].mode).toBe('grid');
  });

  it('面積の目安を幅 × 高さから出す', () => {
    renderWallPanels(document, [PANEL], OPTIONS);
    expect(document.querySelector('[data-panel-area]').textContent).toBe('555,100 mm²');

    document.querySelector('[data-panel-field="width"]').value = '';
    showPanelArea(document);
    expect(document.querySelector('[data-panel-area]').textContent).toBe('-');
  });

  it('折り畳んだ面材は、描き直しても畳んだままにする', () => {
    renderWallPanels(document, WALL.panels, OPTIONS);
    document.querySelectorAll('[data-panel-index]')[0].open = false;

    // 面材を 1 枚足したときの描き直し。畳んでおいた面材は開かず、
    // これから入力する面材だけが開いた状態で増える。
    const added = { ...PANEL, panelId: 'pn3', panelName: '' };
    renderWallPanels(document, [...WALL.panels, added], OPTIONS);

    const panels = document.querySelectorAll('[data-panel-index]');
    expect(panels[0].open).toBe(false);
    expect(panels[1].open).toBe(true);
    expect(panels[2].open).toBe(true);
  });

  it('面材を減らしても、残った面材の折り畳みはそのまま', () => {
    renderWallPanels(document, WALL.panels, OPTIONS);
    document.querySelectorAll('[data-panel-index]')[1].open = false;

    renderWallPanels(document, [WALL.panels[1]], OPTIONS);

    expect(document.querySelector('[data-panel-index]').open).toBe(false);
  });

  it('描き直しても入力欄が積み上がらない', () => {
    renderWallPanels(document, WALL.panels, OPTIONS);
    renderWallPanels(document, WALL.panels, OPTIONS);

    expect(document.querySelectorAll('[data-panel-index]')).toHaveLength(2);
  });

  it('面材ごとに削除ボタンを添える（枚数が変わる欄なので位置で受ける）', () => {
    renderWallPanels(document, WALL.panels, OPTIONS);

    const buttons = document.querySelectorAll('[data-remove-wall-panel]');
    expect([...buttons].map((button) => button.getAttribute('data-remove-wall-panel')))
      .toEqual(['0', '1']);
  });

  it('面材 1 枚ごとに折り畳める（面材名と削除ボタンは開閉の行に残す）', () => {
    renderWallPanels(document, WALL.panels, OPTIONS);

    const panel = document.querySelector('[data-panel-index]');
    expect(panel.tagName.toLowerCase()).toBe('portal-section');
    expect(panel.open).toBe(true);
    expect(panel.querySelector('[slot="title"]').textContent).toBe('下段');
    expect(panel.querySelector('[data-remove-wall-panel]').slot).toBe('actions');

    // 折り畳んでも入力欄は残る（読み戻す内容は変わらない）。
    panel.open = false;
    expect(readPanels(document)[0].width).toBe(910);
  });
});

describe('renderPanelResults', () => {
  it('面材ごとの釘配列諸定数を、その入力欄の下に描く', () => {
    renderWallPanels(document, WALL.panels, OPTIONS);
    renderPanelResults(document, WALL_REPORT.panelReports);

    const first = document.querySelectorAll('[data-panel-index]')[0];
    const boxes = [...first.querySelectorAll('.result-box')];
    expect(boxes.map((box) => box.querySelector('.key').textContent)).toEqual([
      'Ixy [mm²/mm²]',
      'Zxy [mm/mm²]',
      'Cxy',
    ]);
    expect(boxes.map((box) => box.querySelector('.value').textContent)).toEqual([
      '0.888868',
      '0.00358851',
      '1.26155',
    ]);

    const rows = [...first.querySelectorAll('[data-panel-steps] tr')];
    expect(rows).toHaveLength(2);
    expect(rows[1].querySelector('.step-eq').textContent).toBe('(3.2.5)');
    expect(first.querySelector('[data-panel-error]').hidden).toBe(true);
  });

  it('釘配列図を描く（釘の数だけ点が並ぶ）', () => {
    renderWallPanels(document, WALL.panels, OPTIONS);
    renderPanelResults(document, WALL_REPORT.panelReports);

    const diagram = document.querySelector('[data-panel-diagram]');
    // SVG 要素には hidden プロパティが無いので、属性で出し分ける。
    expect(diagram.hasAttribute('hidden')).toBe(false);
    expect(diagram.querySelectorAll('circle')).toHaveLength(3);
    // 中立軸（x0 / y0）の破線。
    expect(diagram.querySelectorAll('line[stroke-dasharray]')).toHaveLength(2);
  });

  it('計算できない面材は理由を出し、結果と図を空にする', () => {
    renderWallPanels(document, WALL.panels, OPTIONS);
    renderPanelResults(document, WALL_REPORT.panelReports);

    const second = document.querySelectorAll('[data-panel-index]')[1];
    const error = second.querySelector('[data-panel-error]');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('釘座標が入力されていません。');
    expect(second.querySelectorAll('.result-box')).toHaveLength(0);
    expect(second.querySelector('[data-panel-diagram]').hasAttribute('hidden')).toBe(true);
  });

  it('まだ計算していないときは、結果の欄を空のままにする', () => {
    renderWallPanels(document, WALL.panels, OPTIONS);
    renderPanelResults(document, null);

    const first = document.querySelectorAll('[data-panel-index]')[0];
    expect(first.querySelector('[data-panel-error]').hidden).toBe(true);
    expect(first.querySelectorAll('.result-box')).toHaveLength(0);
    expect(first.querySelector('[data-panel-diagram]').hasAttribute('hidden')).toBe(true);
  });
});

describe('renderGradeOptions / renderMaterialOptions', () => {
  it('グレー本 表 3.3.2 の規格を選べるようにする', () => {
    renderGradeOptions(document, [
      { id: 'plywood-jas1', label: '構造用合板 JAS 1 級' },
      { id: 'mdf', label: '構造用 MDF JIS A 5905' },
    ]);

    const select = document.getElementById('gradeSelect');
    expect(select.options).toHaveLength(3); // 先頭の案内 + 2 件
    expect(select.options[1].value).toBe('plywood-jas1');
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

  it('選んだ釘の呼び径を、へりあきの手がかりとして案内に出す', () => {
    showNailNote(document, '選んだ釘は 鉄丸釘 N-65（呼び径 φ3.05 mm）です。');
    expect(document.getElementById('materialNote').textContent).toContain('φ3.05 mm');

    // まだ選んでいないときは、もとの案内へ戻す。
    showNailNote(document, '');
    expect(document.getElementById('materialNote').textContent).toContain('4.5 の試験');
  });
});

describe('renderWallBar', () => {
  it('現在位置とタブを描き、端では送りボタンを止める', () => {
    const chosen = [];
    renderWallBar(document, [WALL, { wallName: '' }], 0, (index) => chosen.push(index));

    expect(document.getElementById('wallPosition').textContent).toBe('壁 1 / 2');
    expect(document.getElementById('wallPrevBtn').disabled).toBe(true);
    expect(document.getElementById('wallNextBtn').disabled).toBe(false);
    expect(document.getElementById('removeWallBtn').disabled).toBe(false);

    const tabs = document.getElementById('wallTabs').children;
    expect([...tabs].map((tab) => tab.textContent)).toEqual([
      'グレー本 3.3 の計算例',
      '壁2',
    ]);
    expect(tabs[0].className).toBe('tab current');
    tabs[1].click();
    expect(chosen).toEqual([1]);
  });

  it('壁が 1 枚なら削除できない（0 枚の物件を作らせない）', () => {
    renderWallBar(document, [WALL], 0, () => {});

    expect(document.getElementById('removeWallBtn').disabled).toBe(true);
  });
});

describe('renderWallResult', () => {
  it('剛性・許容せん断耐力と、面材ごとの値・途中経過・判定を並べる', () => {
    renderWallPanels(document, WALL.panels, OPTIONS);
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
    // せん断破壊・せん断座屈の検定も、面材ごとの表で出す。
    expect(document.querySelectorAll('#wallBucklingHead th')).toHaveLength(3);
    expect(document.querySelectorAll('#wallBucklingBody tr')).toHaveLength(2);
    expect(document.querySelectorAll('#wallChecksBody tr')).toHaveLength(2);
  });

  it('面材ごとの釘配列諸定数も、同じ 1 回で描く', () => {
    renderWallPanels(document, WALL.panels, OPTIONS);
    renderWallResult(document, WALL_REPORT);

    const first = document.querySelectorAll('[data-panel-index]')[0];
    expect(first.querySelectorAll('.result-box')).toHaveLength(3);
    expect(first.querySelector('[data-panel-diagram]').hasAttribute('hidden')).toBe(false);
  });

  it('適用範囲を外れた壁は NG と出す', () => {
    const checks = [{ label: '適用範囲', value: 'ΔPa > 13.7200 kN/m', ok: false }];
    renderWallResult(document, { ...WALL_REPORT, checks });

    const cell = document.querySelector('#wallChecksBody tr').children[2];
    expect(cell.textContent).toBe('NG');
    expect(cell.className).toContain('ng');
  });

  it('計算できない壁は理由だけを出す（面材の結果は出せるところまで出す）', () => {
    renderWallPanels(document, WALL.panels, OPTIONS);
    renderWallResult(document, {
      ok: false,
      wallId: 'w1',
      error: '壁を構成する面材がありません。',
      panelReports: [PANEL_REPORT],
    });

    expect(document.getElementById('wallError').hidden).toBe(false);
    expect(document.getElementById('wallError').textContent).toContain('面材がありません');
    expect(document.querySelectorAll('#wallSummary .result-box')).toHaveLength(0);
    // 面材ごとの釘配列諸定数は、そのまま見ながら直せる。
    const first = document.querySelectorAll('[data-panel-index]')[0];
    expect(first.querySelectorAll('.result-box')).toHaveLength(3);
  });

  it('壁を選んでいなければ、結果の欄を空にする', () => {
    renderWallPanels(document, WALL.panels, OPTIONS);
    renderWallResult(document, WALL_REPORT);
    renderWallResult(document, null);

    expect(document.getElementById('wallError').hidden).toBe(true);
    expect(document.querySelectorAll('#wallSummary .result-box')).toHaveLength(0);
    expect(document.querySelectorAll('#wallPanelBody tr')).toHaveLength(0);
    expect(document.querySelectorAll('#wallBucklingBody tr')).toHaveLength(0);
    expect(document.querySelectorAll('.panel-result .result-box')).toHaveLength(0);
  });
});
