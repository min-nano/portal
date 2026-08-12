// 画面（DOM）とデータの往復、および計算結果・釘配列図の描画。
//
// 壁の項目は固定なので、その入力欄は tools/…/index.html に直接置いてある。
// 壁を構成する面材は枚数が変わるため、1 枚ぶんの入力欄（寸法・割り付け・
// へりあき）と、その面材の釘配列諸定数の結果はここで組み立てる。
//
// 数値の丸めや単位は計算実装（core/、wasm）が組み立てた文字列をそのまま出す。
// 計算書 PDF も同じ文字列を刷るので、画面と計算書で桁がずれない。

// 面材 1 枚ぶんの入力欄は、折り畳めるセクション（<portal-section>）で作る。
import '../components/collapsible-section.js';
import { buildDiagram } from './diagram.js';
import { panelLabel, panelMode, wallLabel } from './form-logic.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 繊維方向の選択肢（せん断座屈の a・b をどちらの辺に取るか）。 */
const GRAIN_CHOICES = [
  { value: '', text: '長辺方向' },
  { value: 'height', text: '高さ方向' },
  { value: 'width', text: '幅方向' },
];

/** 釘配列の入力方式。 */
const MODE_CHOICES = [
  { value: 'layout', text: '割り付け（型・ピッチ・へりあきから作る）' },
  { value: 'grid', text: '格子（X と Y の座標リストの全組合せ）' },
  { value: 'coords', text: '座標を直接入力' },
];

function element(root, id) {
  return root.getElementById ? root.getElementById(id) : root.querySelector(`#${id}`);
}

/** 面材 1 枚分の入力欄の中から、名前で 1 つ取り出す。 */
function field(panelNode, name) {
  return panelNode.querySelector(`[data-panel-field="${name}"]`);
}

/** 入力欄を数値として読む（未入力は 0）。 */
function numberOf(node) {
  return Number(node.value) || 0;
}

/** 入力欄を数値として読む（未入力は空文字のまま持ち帰る）。 */
function optionalNumberOf(node) {
  const value = node.value.trim();
  return value === '' ? '' : Number(value);
}

// --- 壁 ---------------------------------------------------------------------

/** 壁の入力欄を読み取る（wallId は画面が持たない）。 */
export function readWall(root) {
  const number = (id) => optionalNumberOf(element(root, id));
  return {
    wallName: element(root, 'wallName').value.trim(),
    height: Number(element(root, 'wallHeight').value) || 0,
    width: Number(element(root, 'wallWidth').value) || 0,
    materialId: element(root, 'materialSelect').value,
    thickness: number('wallThickness'),
    shearModulus: number('wallShearModulus'),
    k: number('wallK'),
    deltaV: number('wallDeltaV'),
    deltaU: number('wallDeltaU'),
    deltaPv: number('wallDeltaPv'),
    gradeId: element(root, 'gradeSelect').value,
    tauMax: number('wallTauMax'),
    e1: number('wallE1'),
    e2: number('wallE2'),
    hasIntermediateStud: element(root, 'wallHasStud').checked,
    panels: readPanels(root),
  };
}

/** 壁を構成する面材の入力欄を、並び順のまま読み取る。 */
export function readPanels(root) {
  return Array.from(root.querySelectorAll('[data-panel-index]')).map((node) => {
    const checked = node.querySelector('input[data-panel-mode]:checked');
    return {
      panelId: node.getAttribute('data-panel-id'),
      panelName: field(node, 'panelName').value.trim(),
      width: numberOf(field(node, 'width')),
      height: numberOf(field(node, 'height')),
      mode: panelMode(checked && checked.value),
      arrangement: field(node, 'arrangement').value,
      studPitch: numberOf(field(node, 'studPitch')),
      nailPitch: numberOf(field(node, 'nailPitch')),
      edgeDistance: numberOf(field(node, 'edgeDistance')),
      gridX: field(node, 'gridX').value.trim(),
      gridY: field(node, 'gridY').value.trim(),
      coords: field(node, 'coords').value.trim(),
      grain: field(node, 'grain').value,
    };
  });
}

/** 壁の内容を入力欄へ写す。wall が null なら編集欄そのものを隠す。 */
export function applyWall(root, wall, options) {
  element(root, 'wallEditor').hidden = !wall;
  element(root, 'wallEmptyNote').hidden = Boolean(wall);
  if (!wall) return;

  element(root, 'wallName').value = wall.wallName || '';
  element(root, 'wallHeight').value = wall.height || '';
  element(root, 'wallWidth').value = wall.width || '';
  element(root, 'materialSelect').value = wall.materialId || '';
  element(root, 'gradeSelect').value = wall.gradeId || '';
  element(root, 'wallHasStud').checked = wall.hasIntermediateStud !== false;
  [
    ['wallThickness', 'thickness'],
    ['wallShearModulus', 'shearModulus'],
    ['wallK', 'k'],
    ['wallDeltaV', 'deltaV'],
    ['wallDeltaU', 'deltaU'],
    ['wallDeltaPv', 'deltaPv'],
    ['wallTauMax', 'tauMax'],
    ['wallE1', 'e1'],
    ['wallE2', 'e2'],
  ].forEach(([id, key]) => {
    element(root, id).value = wall[key] === '' || wall[key] === undefined ? '' : wall[key];
  });
  renderWallPanels(root, wall.panels, options);
}

/**
 * グレー本 表 3.3.1 の面材と釘の組合せを、選べる一覧にする。
 * 一覧は計算実装（wasm）が配るものをそのまま並べる。
 */
export function renderMaterialOptions(root, materials) {
  fillSelect(element(root, 'materialSelect'), materials);
}

/**
 * グレー本 表 3.3.2 の面材の規格を、選べる一覧にする。
 * せん断破壊・せん断座屈の検定に使う τmax・E1・E2 がここで決まる。
 */
export function renderGradeOptions(root, grades) {
  fillSelect(element(root, 'gradeSelect'), grades);
}

/** 選んだ釘の呼び径を、へりあきを決める手がかりとして案内に出す。 */
export function showNailNote(root, note) {
  const box = element(root, 'materialNote');
  box.textContent = note
    ? note
    : '表にない組合せは、グレー本 4.5 の試験で求めた k・ΔPv・δv・δu を' +
      '直接入力してください。読み込んだあとに編集できます。';
}

/** { id, label } の一覧を select へ並べ直す（先頭の案内だけ残す）。 */
function fillSelect(select, entries) {
  const document_ = select.ownerDocument;
  while (select.options.length > 1) select.remove(1);
  entries.forEach((entry) => {
    const option = document_.createElement('option');
    option.value = entry.id;
    option.textContent = entry.label;
    select.appendChild(option);
  });
}

/** 壁のタブと現在位置を描き直す。 */
export function renderWallBar(root, walls, currentIndex, onSelect) {
  element(root, 'wallPosition').textContent = walls.length
    ? `壁 ${currentIndex + 1} / ${walls.length}`
    : '壁 0 / 0';
  element(root, 'wallPrevBtn').disabled = currentIndex <= 0;
  element(root, 'wallNextBtn').disabled = currentIndex >= walls.length - 1;
  element(root, 'removeWallBtn').disabled = walls.length <= 1;

  const tabs = element(root, 'wallTabs');
  tabs.innerHTML = '';
  walls.forEach((wall, index) => {
    const button = tabs.ownerDocument.createElement('button');
    button.type = 'button';
    button.textContent = wallLabel(wall, index);
    button.className = index === currentIndex ? 'tab current' : 'tab';
    button.addEventListener('click', () => onSelect(index));
    tabs.appendChild(button);
  });
}

// --- 壁を構成する面材（釘配列: グレー本 3.2） -------------------------------

function labelled(document_, text, control) {
  const label = document_.createElement('label');
  label.append(document_.createTextNode(text), control);
  return label;
}

function input(document_, name, value, attributes) {
  const node = document_.createElement('input');
  node.setAttribute('data-panel-field', name);
  Object.entries(attributes || {}).forEach(([key, attribute]) => {
    node.setAttribute(key, String(attribute));
  });
  node.value = value === '' || value === undefined || value === null ? '' : value;
  return node;
}

function select(document_, name, value, choices) {
  const node = document_.createElement('select');
  node.setAttribute('data-panel-field', name);
  choices.forEach((choice) => {
    const option = document_.createElement('option');
    option.value = choice.value;
    option.textContent = choice.text;
    option.title = choice.note || '';
    node.appendChild(option);
  });
  node.value = choices.some((choice) => choice.value === value) ? value : choices[0].value;
  return node;
}

/**
 * グレー本 表 3.2.1 の釘配列を、選べる一覧にする。
 *
 * 選ぶと、その面材の割り付けの欄（寸法・型・ピッチ・へりあき）へ入る。
 * 面材寸法とピッチが同じものを 1 つのまとまりにして、その中を型で選ぶ。
 */
function presetSelect(document_, index, presets) {
  const node = document_.createElement('select');
  node.setAttribute('data-panel-preset', String(index));
  const empty = document_.createElement('option');
  empty.value = '';
  empty.textContent = '標準的な釘配列（表 3.2.1）から読み込む';
  node.appendChild(empty);

  let group = null;
  let groupLabel = '';
  (presets || []).forEach((preset) => {
    const label =
      `${preset.sizeLabel} ${preset.orientation}` +
      `（間柱・根太 @${preset.studPitch} / 釘 @${preset.nailPitch}）`;
    if (label !== groupLabel) {
      groupLabel = label;
      group = document_.createElement('optgroup');
      group.label = label;
      node.appendChild(group);
    }
    const option = document_.createElement('option');
    option.value = preset.id;
    option.textContent = `${preset.arrangementLabel}（釘 ${preset.nailCount} 本）`;
    option.title = preset.arrangementNote;
    group.appendChild(option);
  });
  return node;
}

/**
 * 面材 1 枚分の入力欄と、その面材の計算結果の器を組み立てる。
 *
 * 枚数が増えると縦に長くなるので、面材ごとに折り畳めるようにする
 * （見出しの行には面材名と削除ボタンだけが残る）。
 */
function buildPanelEditor(document_, panel, index, options) {
  const box = document_.createElement('portal-section');
  box.className = 'wall-panel';
  box.setAttribute('data-panel-index', String(index));
  box.setAttribute('data-panel-id', panel.panelId || '');

  const title = document_.createElement('strong');
  title.slot = 'title';
  title.textContent = panelLabel(panel, index);
  const remove = document_.createElement('button');
  remove.type = 'button';
  remove.slot = 'actions';
  remove.className = 'secondary';
  remove.textContent = 'この面材を削除';
  remove.setAttribute('data-remove-wall-panel', String(index));
  box.append(title, remove);

  box.appendChild(
    labelled(document_, '面材名', input(document_, 'panelName', panel.panelName, {
      type: 'text',
      placeholder: '南面 下段 など',
    }))
  );
  box.appendChild(presetSelect(document_, index, options && options.presets));

  const size = document_.createElement('div');
  size.className = 'panel-size';
  size.append(
    labelled(document_, '幅 W [mm]', input(document_, 'width', panel.width, {
      type: 'number',
      inputmode: 'numeric',
    })),
    labelled(document_, '高さ H [mm]', input(document_, 'height', panel.height, {
      type: 'number',
      inputmode: 'numeric',
    })),
    labelled(document_, '繊維方向', select(document_, 'grain', panel.grain || '', GRAIN_CHOICES))
  );
  const area = document_.createElement('div');
  area.className = 'area';
  const areaLabel = document_.createElement('span');
  areaLabel.className = 'label';
  areaLabel.textContent = '面積 Aw';
  const areaValue = document_.createElement('span');
  areaValue.setAttribute('data-panel-area', String(index));
  areaValue.textContent = '-';
  area.append(areaLabel, areaValue);
  size.appendChild(area);
  box.appendChild(size);

  // 釘配列の入力方式（割り付け / 格子 / 座標）。
  const choices = document_.createElement('fieldset');
  choices.className = 'cert-choices';
  const legend = document_.createElement('legend');
  legend.textContent = '釘配列の入力方法';
  choices.appendChild(legend);
  MODE_CHOICES.forEach((choice) => {
    const option = document_.createElement('input');
    option.type = 'radio';
    option.name = `nailMode-${index}`;
    option.value = choice.value;
    option.checked = panelMode(panel.mode) === choice.value;
    option.setAttribute('data-panel-mode', String(index));
    const label = document_.createElement('label');
    label.className = 'choice-option';
    label.append(option, document_.createTextNode(choice.text));
    choices.appendChild(label);
  });
  box.appendChild(choices);

  // 割り付け（既定）。へりあきは面材・釘の種類に合わせてここで調整する。
  const layout = document_.createElement('div');
  layout.setAttribute('data-panel-section', 'layout');
  const arrangementChoices = (options && options.arrangements ? options.arrangements : []).map(
    (arrangement) => ({
      value: arrangement.id,
      text: arrangement.label,
      note: arrangement.note,
    })
  );
  layout.appendChild(
    labelled(
      document_,
      '配列の型',
      select(document_, 'arrangement', panel.arrangement, arrangementChoices.length
        ? arrangementChoices
        : [{ value: 'hi', text: '日型' }])
    )
  );
  const pitches = document_.createElement('div');
  pitches.className = 'panel-size';
  pitches.append(
    labelled(document_, '間柱・根太ピッチ [mm]', input(document_, 'studPitch', panel.studPitch, {
      type: 'number',
      inputmode: 'numeric',
    })),
    labelled(document_, '釘ピッチ [mm]', input(document_, 'nailPitch', panel.nailPitch, {
      type: 'number',
      inputmode: 'numeric',
    })),
    labelled(document_, 'へりあき [mm]', input(document_, 'edgeDistance', panel.edgeDistance, {
      type: 'number',
      inputmode: 'decimal',
      step: 'any',
    }))
  );
  layout.appendChild(pitches);
  const layoutNote = document_.createElement('p');
  layoutNote.className = 'hint';
  layoutNote.textContent =
    'へりあきは面材の縁から釘の中心までの距離です。適用範囲 3.3(1)④ により、' +
    '10 mm 以上かつ選んだ釘の呼び径の 5 倍以上にしてください（面材と釘を選ぶと、' +
    '足りない面材はその値まで引き上げます）。' +
    '面材の長辺方向に走る間柱の釘列は、釘配列諸定数に含めません（3.3(1)⑧）。';
  layout.appendChild(layoutNote);
  box.appendChild(layout);

  const grid = document_.createElement('div');
  grid.setAttribute('data-panel-section', 'grid');
  grid.append(
    labelled(document_, 'X 座標のリスト [mm]（カンマ区切り）',
      input(document_, 'gridX', panel.gridX, { type: 'text', placeholder: '10, 455, 900' })),
    labelled(document_, 'Y 座標のリスト [mm]（カンマ区切り）',
      input(document_, 'gridY', panel.gridY, { type: 'text', placeholder: '10, 155, 305' }))
  );
  box.appendChild(grid);

  const coords = document_.createElement('div');
  coords.setAttribute('data-panel-section', 'coords');
  const coordsInput = document_.createElement('textarea');
  coordsInput.setAttribute('data-panel-field', 'coords');
  coordsInput.setAttribute('rows', '6');
  coordsInput.value = panel.coords || '';
  coords.appendChild(
    labelled(document_, '釘座標「x, y」を 1 行に 1 本ずつ [mm]', coordsInput)
  );
  box.appendChild(coords);

  // この面材の釘配列諸定数（グレー本 3.2）の結果。
  const result = document_.createElement('div');
  result.className = 'panel-result';
  const error = document_.createElement('div');
  error.className = 'result-error';
  error.setAttribute('data-panel-error', String(index));
  error.hidden = true;
  const summary = document_.createElement('div');
  summary.className = 'result-summary';
  summary.setAttribute('data-panel-summary', String(index));
  const steps = document_.createElement('table');
  steps.className = 'steps-table';
  const body = document_.createElement('tbody');
  body.setAttribute('data-panel-steps', String(index));
  steps.appendChild(body);
  const diagram = document_.createElementNS(SVG_NS, 'svg');
  diagram.setAttribute('data-panel-diagram', String(index));
  diagram.setAttribute('role', 'img');
  diagram.setAttribute('aria-label', '釘配列図');
  diagram.setAttribute('hidden', '');
  result.append(error, summary, steps, diagram);
  box.appendChild(result);

  return box;
}

/** 今、画面に出ている面材のうち、折り畳んであるものの面材 ID。 */
function collapsedPanelIds(container) {
  const ids = new Set();
  container.querySelectorAll('[data-panel-index]').forEach((node) => {
    const id = node.getAttribute('data-panel-id');
    if (id && node.hasAttribute('collapsed')) ids.add(id);
  });
  return ids;
}

/**
 * 壁を構成する面材の入力欄を描き直す。
 *
 * 入力のたびには呼ばない（打鍵のたびに value を入れ直すとカーソルが飛ぶ）。
 * 面材の枚数が変わったとき・別の壁へ移ったとき・一覧から読み込んだときだけ
 * 組み立て直し、ふだんは結果の欄（renderPanelResults）だけを描き替える。
 *
 * 折り畳んである面材は、描き直しても畳んだままにする（面材を 1 枚足した
 * だけで、畳んでおいた面材まで開いてしまわないように）。今までに無かった
 * 面材＝これから入力する面材なので、開いた状態で出す。
 */
export function renderWallPanels(root, panels, options) {
  const container = element(root, 'wallPanels');
  const document_ = container.ownerDocument;
  const collapsed = collapsedPanelIds(container);
  container.innerHTML = '';
  (panels || []).forEach((panel, index) => {
    const node = buildPanelEditor(document_, panel, index, options);
    if (collapsed.has(panel.panelId)) node.setAttribute('collapsed', '');
    container.appendChild(node);
  });
  syncNailModeVisibility(root);
  showPanelArea(root);
}

/** 面材ごとに、選ばれている入力方式に応じて入力欄を出し分ける。 */
export function syncNailModeVisibility(root) {
  root.querySelectorAll('[data-panel-index]').forEach((node) => {
    const checked = node.querySelector('input[data-panel-mode]:checked');
    const mode = panelMode(checked && checked.value);
    node.querySelectorAll('[data-panel-section]').forEach((section) => {
      section.hidden = section.getAttribute('data-panel-section') !== mode;
    });
  });
}

/**
 * 面材面積の目安を、面材ごとの入力欄の横に出す。
 *
 * 正となる面積は計算結果（と計算書）に載る計算実装の値。ここは幅 × 高さを
 * その場で掛けただけの入力補助で、桁を間違えたときにすぐ気付けるようにする。
 */
export function showPanelArea(root) {
  root.querySelectorAll('[data-panel-index]').forEach((node) => {
    const area = numberOf(field(node, 'width')) * numberOf(field(node, 'height'));
    const box = node.querySelector('[data-panel-area]');
    box.textContent = area > 0 ? `${Math.round(area).toLocaleString('ja-JP')} mm²` : '-';
  });
}

/** 結果の枠（Ixy [mm²/mm²] のような見出しと値）を並べる。 */
function fillSummary(node, items) {
  const document_ = node.ownerDocument;
  node.innerHTML = '';
  items.forEach((item) => {
    const box = document_.createElement('div');
    box.className = 'result-box';
    const label = document_.createElement('span');
    label.className = 'key';
    label.textContent = item.unit ? `${item.key} [${item.unit}]` : item.key;
    const value = document_.createElement('strong');
    value.className = 'value';
    value.textContent = item.value;
    box.append(label, value);
    node.appendChild(box);
  });
}

function appendRow(body, cells) {
  const tr = body.ownerDocument.createElement('tr');
  cells.forEach(({ text, className }) => {
    const td = body.ownerDocument.createElement('td');
    td.className = className;
    td.textContent = text;
    tr.appendChild(td);
  });
  body.appendChild(tr);
  return tr;
}

/**
 * 面材ごとの釘配列諸定数（グレー本 3.2）を、それぞれの入力欄の下に描く。
 *
 * reports は壁の計算結果に入っている panelReports。計算できない面材は
 * ok: false で理由が入っているので、それをそのまま出す。
 */
export function renderPanelResults(root, reports) {
  root.querySelectorAll('[data-panel-index]').forEach((node, index) => {
    const report = (reports || [])[index] || null;
    const error = node.querySelector('[data-panel-error]');
    const summary = node.querySelector('[data-panel-summary]');
    const steps = node.querySelector('[data-panel-steps]');
    const diagram = node.querySelector('[data-panel-diagram]');

    summary.innerHTML = '';
    steps.innerHTML = '';

    if (!report || !report.ok) {
      error.hidden = !report;
      error.textContent = report ? report.error : '';
      renderDiagram(diagram, null);
      return;
    }
    error.hidden = true;

    fillSummary(summary, report.summary);
    report.steps.forEach((row) => {
      appendRow(steps, [
        { text: row.label, className: 'step-label' },
        { text: row.eq, className: 'step-eq' },
        { text: row.value, className: 'step-value' },
      ]);
    });
    renderDiagram(diagram, buildDiagram(report.nails, report.diagram));
  });
}

// --- 壁の計算結果（グレー本 3.3） -------------------------------------------

/** 壁の計算結果を描く。report が null なら結果の欄を空にする。 */
export function renderWallResult(root, report) {
  const errorBox = element(root, 'wallError');
  const summary = element(root, 'wallSummary');
  const head = element(root, 'wallPanelHead');
  const body = element(root, 'wallPanelBody');
  const steps = element(root, 'wallStepsBody');
  const bucklingHead = element(root, 'wallBucklingHead');
  const bucklingBody = element(root, 'wallBucklingBody');
  const checks = element(root, 'wallChecksBody');
  const document_ = summary.ownerDocument;

  // 面材ごとの釘配列諸定数は、壁の計算の一部として一緒に返る。
  renderPanelResults(root, report && report.panelReports);

  [summary, head, body, steps, bucklingHead, bucklingBody, checks].forEach((node) => {
    node.innerHTML = '';
  });

  if (!report || !report.ok) {
    errorBox.hidden = !report;
    errorBox.textContent = report ? report.error : '';
    return;
  }
  errorBox.hidden = true;

  fillSummary(summary, report.summary);

  const appendTable = (headNode, bodyNode, columns, rows) => {
    const headRow = document_.createElement('tr');
    columns.forEach((column, index) => {
      const th = document_.createElement('th');
      th.className = index === 0 ? 'step-label' : 'step-value';
      th.textContent = column;
      headRow.appendChild(th);
    });
    headNode.appendChild(headRow);

    rows.forEach((panel) => {
      appendRow(bodyNode, [
        { text: panel.label, className: 'step-label' },
        ...panel.cells.map((cell) => ({ text: cell, className: 'step-value' })),
      ]);
    });
  };

  appendTable(head, body, report.panelColumns, report.panels);
  appendTable(bucklingHead, bucklingBody, report.bucklingColumns, report.buckling);

  report.steps.forEach((row) => {
    appendRow(steps, [
      { text: row.label, className: 'step-label' },
      { text: row.eq, className: 'step-eq' },
      { text: row.value, className: 'step-value' },
    ]);
  });

  report.checks.forEach((check) => {
    appendRow(checks, [
      { text: check.label, className: 'step-label' },
      { text: check.value, className: 'step-eq' },
      { text: check.ok ? 'OK' : 'NG', className: check.ok ? 'step-value' : 'step-value ng' },
    ]);
  });
}

function svgNode(document_, name, attributes) {
  const node = document_.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => {
    node.setAttribute(key, String(value));
  });
  return node;
}

function svgText(document_, x, y, text, attributes) {
  const node = svgNode(document_, 'text', { x, y, 'font-size': 10, ...attributes });
  node.textContent = text;
  return node;
}

/** 釘配列図を SVG へ描く（diagram が null なら空にする）。 */
export function renderDiagram(svg, diagram) {
  const document_ = svg.ownerDocument;
  svg.innerHTML = '';
  // SVG 要素には HTMLElement の hidden プロパティが無いため、属性を直に付け外し
  // する（svg.hidden = … は代入できてしまうが、表示には反映されない）。
  if (diagram) {
    svg.removeAttribute('hidden');
  } else {
    svg.setAttribute('hidden', '');
    return;
  }

  svg.setAttribute('viewBox', `0 0 ${diagram.svgWidth} ${diagram.svgHeight}`);
  svg.setAttribute('width', diagram.svgWidth);
  svg.setAttribute('height', diagram.svgHeight);

  // 面材の枠。
  svg.appendChild(
    svgNode(document_, 'rect', {
      x: diagram.frame.x,
      y: diagram.frame.y,
      width: diagram.frame.width,
      height: diagram.frame.height,
      fill: '#f8fafc',
      stroke: '#94a3b8',
      'stroke-width': 1.5,
    })
  );

  // 弾性中立軸 x0 / y0。
  if (diagram.axes) {
    const dash = { 'stroke-dasharray': '5 3', 'stroke-width': 1 };
    svg.appendChild(
      svgNode(document_, 'line', {
        x1: diagram.axes.x, y1: diagram.frame.y,
        x2: diagram.axes.x, y2: diagram.frame.y + diagram.frame.height,
        stroke: '#6366f1', ...dash,
      })
    );
    svg.appendChild(
      svgNode(document_, 'line', {
        x1: diagram.frame.x, y1: diagram.axes.y,
        x2: diagram.frame.x + diagram.frame.width, y2: diagram.axes.y,
        stroke: '#10b981', ...dash,
      })
    );
    svg.appendChild(
      svgText(document_, diagram.axes.x, diagram.frame.y - 6, diagram.axes.xLabel,
        { 'text-anchor': 'middle', fill: '#6366f1', 'font-size': 10 })
    );
    svg.appendChild(
      svgText(document_, diagram.frame.x + diagram.frame.width + 4, diagram.axes.y + 4,
        diagram.axes.yLabel, { fill: '#059669', 'font-size': 10 })
    );
  }

  // 座標の目盛。
  diagram.xTicks.forEach((tick) => {
    svg.appendChild(
      svgNode(document_, 'line', {
        x1: tick.position, y1: diagram.axisBottom,
        x2: tick.position, y2: diagram.axisBottom + 4,
        stroke: '#cbd5e1', 'stroke-width': 1,
      })
    );
    svg.appendChild(
      svgText(document_, tick.position, diagram.axisBottom + 16, tick.label, {
        'text-anchor': 'middle', fill: '#94a3b8', 'font-size': 9,
      })
    );
  });
  diagram.yTicks.forEach((tick) => {
    svg.appendChild(
      svgNode(document_, 'line', {
        x1: diagram.axisLeft - 4, y1: tick.position,
        x2: diagram.axisLeft, y2: tick.position,
        stroke: '#cbd5e1', 'stroke-width': 1,
      })
    );
    svg.appendChild(
      svgText(document_, diagram.axisLeft - 7, tick.position + 3, tick.label, {
        'text-anchor': 'end', fill: '#94a3b8', 'font-size': 9,
      })
    );
  });

  // 釘。
  diagram.points.forEach((point) => {
    const circle = svgNode(document_, 'circle', {
      cx: point.cx, cy: point.cy, r: 4,
      fill: '#334155', stroke: '#fff', 'stroke-width': 1,
    });
    const title = document_.createElementNS(SVG_NS, 'title');
    title.textContent = `釘 ${point.index}: (${point.x}, ${point.y})`;
    circle.appendChild(title);
    svg.appendChild(circle);
  });
}
