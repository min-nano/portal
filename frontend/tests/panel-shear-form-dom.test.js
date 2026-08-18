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
  renderPanelResults,
  renderWallBar,
  renderWallPanels,
  renderWallResult,
  showNailNotes,
  showPanelArea,
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
      <div id="wallFrameMembers"></div>
      <p id="wallFrameEmpty" hidden></p>
      <div id="wallPanels"></div>
      <div id="wallError" hidden></div>
      <div id="wallSummary"></div>
      <div id="wallLayout" hidden>
        <svg id="wallLayoutDiagram" hidden></svg>
        <p id="wallLayoutNote" hidden></p>
        <table><thead id="wallLayoutHead"></thead><tbody id="wallLayoutBody"></tbody></table>
      </div>
      <table><thead id="wallFrameHead"></thead><tbody id="wallFrameBody"></tbody></table>
      <table><thead id="wallSpecHead"></thead><tbody id="wallSpecBody"></tbody></table>
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
    id: '910x610-s455-n150-hi',
    label: '910×610 横置（間柱・根太 @455 / 釘 @150）',
    sizeLabel: '910×610',
    orientation: '横置',
    width: 910,
    height: 610,
    studPitch: 455,
    nailPitch: 150,
    nailCount: 23,
  },
  {
    id: '910x610-s455-n100-hi',
    label: '910×610 横置（間柱・根太 @455 / 釘 @100）',
    sizeLabel: '910×610',
    orientation: '横置',
    width: 910,
    height: 610,
    studPitch: 455,
    nailPitch: 100,
    nailCount: 31,
  },
  {
    id: '910x1820-s455-n150-hi',
    label: '1820×910 縦置（間柱・根太 @455 / 釘 @150）',
    sizeLabel: '1820×910',
    orientation: '縦置',
    width: 910,
    height: 1820,
    studPitch: 455,
    nailPitch: 150,
    nailCount: 38,
  },
];

// 面材と釘の組合せ（表 3.3.1）・面材の規格（表 3.3.2）も、面材 1 枚ごとの
// 入力欄が使う一覧（1 枚の壁でも面材ごとに選べる）。
const MATERIALS = [
  { id: 'plywood12-n65', label: '構造用合板 12mm + 鉄丸釘 N-65' },
  { id: 'mdf9-cn50', label: '構造用 MDF 9mm + 太め鉄丸釘(CN 釘)50' },
];

const GRADES = [
  { id: 'plywood-jas1', label: '構造用合板 JAS 1 級' },
  { id: 'mdf', label: '構造用 MDF JIS A 5905' },
];

const OPTIONS = { presets: PRESETS, materials: MATERIALS, grades: GRADES };

// 面材と釘の仕様は面材ごとの入力（グレー本 3.3(3) の計算例の組合せ）。
const SPEC = {
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
};

// 面材は「壁の中で占める領域」。寸法も釘配列もここから決まる。
const PANEL = {
  panelId: 'pn1',
  panelName: '下段',
  ...SPEC,
  side: 'front',
  left: 0,
  bottom: 0,
  right: 910,
  top: 610,
  nailPitch: 150,
  edgeDistance: 10,
  grain: '',
};

const WALL = {
  wallId: 'w1',
  wallName: 'グレー本 3.3 の計算例',
  height: 3000,
  width: 910,
  // 軸組材は 1 本ずつ自由な位置に入れる（釘の縦列も縁端距離もここから）。
  frame: [
    { direction: 'vertical', label: '柱', position: 0, width: 105 },
    { direction: 'vertical', label: '間柱', position: 455, width: 45 },
    { direction: 'vertical', label: '柱', position: 910, width: 105 },
    { direction: 'horizontal', label: '横架材', position: 0, width: 105 },
    { direction: 'horizontal', label: '横架材', position: 3000, width: 105 },
  ],
  panels: [
    { ...PANEL },
    {
      ...PANEL,
      panelId: 'pn2',
      panelName: '上段',
      grain: 'width',
      bottom: 610,
      top: 1220,
    },
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
  frameColumns: ['軸組材', '向き', '材心の位置 [mm]', '見付け幅 [mm]'],
  frame: [
    { label: '柱', cells: ['縦材', 'X = 0', '105'] },
    { label: '間柱', cells: ['縦材', 'X = 455', '45'] },
  ],
  specColumns: ['面材', 't [mm]', 'ΔPv [kN]'],
  specs: [
    { label: '下段', cells: ['12', '1.13'] },
    { label: '上段', cells: ['9', '0.93'] },
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
  // 壁内の面材配列（位置を入れた壁にだけ付く）。
  wallDiagram: {
    wallWidth: 910,
    wallHeight: 3000,
    minX: 0,
    minY: 0,
    maxX: 910,
    maxY: 3000,
    sides: [
      {
        id: 'front',
        label: '表面',
        count: 2,
        area: 1_110_200,
        panels: [
          {
            label: '下段', x: 0, y: 0, width: 910, height: 610,
            sizeLabel: '910 × 610 mm', note: '', ok: true,
          },
          {
            label: '上段', x: 0, y: 610, width: 910, height: 610,
            sizeLabel: '910 × 610 mm', note: '', ok: true,
          },
        ],
      },
    ],
    unplaced: [],
  },
  layoutColumns: ['面材', '張る面', '寸法 W × H', '左下 (X, Y) [mm]', '面積 Aw [mm²]', '配置'],
  layout: [
    { label: '下段', ok: true, cells: ['表面', '910 × 610 mm', '(0, 0)', '555,100', 'OK'] },
    { label: '上段', ok: true, cells: ['表面', '910 × 610 mm', '(0, 610)', '555,100', 'OK'] },
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
    applyWall(
      document,
      { ...WALL, panels: [{ ...PANEL, k: '', deltaPv: '' }] },
      OPTIONS
    );

    const panel = readWall(document).panels[0];
    expect(panel.k).toBe('');
    expect(panel.deltaPv).toBe('');
    expect(panel.thickness).toBe(12);
  });

  it('面材の張る面・占有領域を読み戻せる', () => {
    applyWall(
      document,
      {
        ...WALL,
        panels: [{ ...PANEL, side: 'back', left: 455, right: 1365 }],
      },
      OPTIONS
    );

    const wall = readWall(document);
    expect(wall.panels[0].side).toBe('back');
    expect(wall.panels[0].left).toBe(455);
    expect(wall.panels[0].right).toBe(1365);
  });

  it('軸組材は 1 本 = 1 行で出し、そのまま読み戻せる', () => {
    applyWall(
      document,
      {
        ...WALL,
        frame: [
          { direction: 'vertical', label: '柱', position: 0, width: 120 },
          // 等間隔でない位置（開口の脇に寄せた縦材）も入れられる。
          { direction: 'vertical', label: '間柱', position: 600, width: 45 },
          { direction: 'horizontal', label: 'まぐさ', position: 2000, width: 105 },
        ],
      },
      OPTIONS
    );

    const rows = document.querySelectorAll('[data-member-index]');
    expect(rows).toHaveLength(3);
    expect(rows[1].querySelector('[data-member-field="label"]').value).toBe('間柱');
    expect(rows[1].querySelector('[data-member-field="position"]').value).toBe('600');
    expect(document.getElementById('wallFrameEmpty').hidden).toBe(true);

    expect(readWall(document).frame).toEqual([
      { direction: 'vertical', label: '柱', position: 0, width: 120 },
      { direction: 'vertical', label: '間柱', position: 600, width: 45 },
      { direction: 'horizontal', label: 'まぐさ', position: 2000, width: 105 },
    ]);
  });

  it('軸組材が 1 本も無ければ、入れ方を案内する', () => {
    applyWall(document, { ...WALL, frame: [] }, OPTIONS);

    expect(document.querySelectorAll('[data-member-index]')).toHaveLength(0);
    expect(document.getElementById('wallFrameEmpty').hidden).toBe(false);
    expect(readWall(document).frame).toEqual([]);
  });
});

describe('renderWallPanels', () => {
  it('面材 1 枚ごとに、占有領域・釘ピッチ・へりあきの入力欄を出す', () => {
    renderWallPanels(document, WALL.panels, OPTIONS);

    const panels = document.querySelectorAll('[data-panel-index]');
    expect(panels).toHaveLength(2);
    expect(panels[0].getAttribute('data-panel-id')).toBe('pn1');

    const value = (node, name) =>
      node.querySelector(`[data-panel-field="${name}"]`).value;
    expect(value(panels[0], 'panelName')).toBe('下段');
    expect(value(panels[0], 'left')).toBe('0');
    expect(value(panels[0], 'bottom')).toBe('0');
    expect(value(panels[0], 'right')).toBe('910');
    expect(value(panels[0], 'top')).toBe('610');
    expect(value(panels[0], 'side')).toBe('front');
    expect(value(panels[0], 'nailPitch')).toBe('150');
    expect(value(panels[0], 'edgeDistance')).toBe('10');
    expect(value(panels[1], 'grain')).toBe('width');
    // 寸法も型も入力欄には無い（配置と壁の軸組から決まる）。
    expect(panels[0].querySelector('[data-panel-field="width"]')).toBeNull();
    expect(panels[0].querySelector('[data-panel-field="arrangement"]')).toBeNull();
  });

  it('途中経過の表は、横スクロールする器に入れる（画面ごと広げない）', () => {
    renderWallPanels(document, [PANEL], OPTIONS);

    const steps = document.querySelector('[data-panel-steps]').closest('table');
    expect(steps.parentElement.className).toBe('table-scroll');
  });

  it('標準的な組み合わせ（表 3.2.1）は、面材寸法ごとにまとめて選べる', () => {
    renderWallPanels(document, [PANEL], OPTIONS);

    const select = document.querySelector('[data-panel-preset]');
    const groups = [...select.querySelectorAll('optgroup')];
    // 配列の型は面材の位置で決まるので、選択肢はピッチの組み合わせだけ。
    expect(groups.map((group) => group.label)).toEqual([
      '910×610 横置',
      '1820×910 縦置',
    ]);
    expect([...groups[0].children].map((option) => option.textContent)).toEqual([
      '間柱・根太 @455 / 釘 @150（壁の左端に張ると釘 23 本）',
      '間柱・根太 @455 / 釘 @100（壁の左端に張ると釘 31 本）',
    ]);
    // 先頭は「読み込む」の 1 行。選ぶまでは何も起きない。
    expect(select.options[0].value).toBe('');
  });

  it('面材の寸法と面積を、占有領域から出す', () => {
    renderWallPanels(document, [PANEL], OPTIONS);
    expect(document.querySelector('[data-panel-area]').textContent).toBe(
      '910 × 610 mm ／ 555,100 mm²'
    );

    document.querySelector('[data-panel-field="right"]').value = '';
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
    expect(readPanels(document)[0].right).toBe(910);
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

describe('面材ごとの面材と釘（表 3.3.1 / 表 3.3.2）', () => {
  it('面材 1 枚ごとに、組合せと規格の一覧を出す', () => {
    renderWallPanels(document, [PANEL, { ...PANEL, panelId: 'pn2', materialId: '' }], OPTIONS);

    const panels = document.querySelectorAll('[data-panel-index]');
    const select = (node, name) => node.querySelector(`[data-panel-field="${name}"]`);
    expect(select(panels[0], 'materialId').options).toHaveLength(3); // 案内 + 2 件
    expect(select(panels[0], 'materialId').value).toBe('plywood12-n65');
    expect(select(panels[0], 'gradeId').value).toBe('plywood-jas1');
    // 面材ごとに違う組合せを選べる（選んでいない面材は先頭の案内のまま）。
    expect(select(panels[1], 'materialId').value).toBe('');
    expect(select(panels[1], 'gradeId').options[2].textContent).toBe(
      '構造用 MDF JIS A 5905'
    );
  });

  it('一覧に無い組合せでも、読み込んだ跡は消さない', () => {
    renderWallPanels(document, [{ ...PANEL, materialId: '新しい組合せ' }], OPTIONS);

    const select = document.querySelector('[data-panel-field="materialId"]');
    expect(select.value).toBe('新しい組合せ');
  });

  it('選んだ釘の呼び径を、へりあきの手がかりとして面材ごとに案内する', () => {
    renderWallPanels(document, [PANEL, { ...PANEL, panelId: 'pn2', materialId: '' }], OPTIONS);

    showNailNotes(document, (materialId) =>
      materialId ? '選んだ釘は 鉄丸釘 N-65（呼び径 φ3.05 mm）です。' : ''
    );

    const notes = [...document.querySelectorAll('[data-panel-note]')];
    expect(notes[0].textContent).toContain('φ3.05 mm');
    // まだ選んでいない面材には、もとの案内を出す。
    expect(notes[1].textContent).toContain('4.5 の試験');
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

    // 面材と釘は面材ごとの入力なので、どの面材がどの数値で計算されたのかを
    // 壁の結果にも表で並べる。
    expect(
      [...document.querySelectorAll('#wallSpecHead th')].map((th) => th.textContent)
    ).toEqual(WALL_REPORT.specColumns);
    const specRows = document.querySelectorAll('#wallSpecBody tr');
    expect(specRows).toHaveLength(2);
    expect(specRows[1].children[1].textContent).toBe('9');

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

  it('壁内の位置を入れた壁には、面材配列図と面材の一覧を出す', () => {
    renderWallPanels(document, WALL.panels, OPTIONS);
    renderWallResult(document, WALL_REPORT);

    expect(document.getElementById('wallLayout').hidden).toBe(false);
    const diagram = document.getElementById('wallLayoutDiagram');
    expect(diagram.hasAttribute('hidden')).toBe(false);
    // 壁の枠（面ごとに、塗りと線で 2 回）と、面材の枠。
    expect(diagram.querySelectorAll('rect')).toHaveLength(4);
    expect([...diagram.querySelectorAll('text')].map((t) => t.textContent))
      .toContain('表面（2 枚）');
    // 一覧は、壁の他の表と同じ組み方（見出し ＋ 面材ごとの行）。
    expect(
      [...document.querySelectorAll('#wallLayoutHead th')].map((th) => th.textContent)
    ).toEqual(WALL_REPORT.layoutColumns);
    expect(document.querySelectorAll('#wallLayoutBody tr')).toHaveLength(2);
    expect(document.getElementById('wallLayoutNote').hidden).toBe(true);
  });

  it('図に描けない面材があれば、その名前を添える', () => {
    const wallDiagram = { ...WALL_REPORT.wallDiagram, unplaced: ['上段'] };
    renderWallResult(document, { ...WALL_REPORT, wallDiagram });

    const note = document.getElementById('wallLayoutNote');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain('上段');
  });

  it('壁内の位置を入れていない壁では、面材配列図の節ごと出さない', () => {
    renderWallResult(document, { ...WALL_REPORT, wallDiagram: null, layout: [] });

    expect(document.getElementById('wallLayout').hidden).toBe(true);
    expect(document.getElementById('wallLayoutDiagram').hasAttribute('hidden')).toBe(true);
    expect(document.querySelectorAll('#wallLayoutBody tr')).toHaveLength(0);
  });

  it('はみ出した面材は、図の中で印を付けて出す', () => {
    const side = WALL_REPORT.wallDiagram.sides[0];
    const wallDiagram = {
      ...WALL_REPORT.wallDiagram,
      sides: [
        {
          ...side,
          panels: [{ ...side.panels[0], note: 'はみ出し', ok: false }],
        },
      ],
    };
    renderWallResult(document, { ...WALL_REPORT, wallDiagram });

    const labels = [...document.querySelectorAll('#wallLayoutDiagram text')]
      .map((text) => text.textContent);
    expect(labels).toContain('※ 下段');
    expect(
      document.querySelector('#wallLayoutDiagram title').textContent
    ).toContain('はみ出し');
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
