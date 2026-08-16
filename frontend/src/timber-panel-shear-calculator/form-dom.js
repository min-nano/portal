// 画面（DOM）とデータの往復、および計算結果・釘配列図の描画。
//
// 壁の項目は固定なので、その入力欄は tools/…/index.html に直接置いてある。
// 壁を構成する面材は枚数が変わるため、1 枚ぶんの入力欄（面材と釘の仕様・
// 寸法・割り付け・へりあき）と、その面材の釘配列諸定数の結果はここで
// 組み立てる。面材と釘の仕様が面材ごとの入力なのは、1 枚の壁でも面材ごとに
// 違う仕様を張り分けることがあるため（上半分は N50、下半分は CN50 など）。
//
// 数値の丸めや単位は計算実装（core/、wasm）が組み立てた文字列をそのまま出す。
// 計算書 PDF も同じ文字列を刷るので、画面と計算書で桁がずれない。

// 面材 1 枚ぶんの入力欄は、折り畳めるセクション（<portal-section>）で作る。
import '../components/collapsible-section.js';
import { buildDiagram, buildWallDiagram } from './diagram.js';
import { panelLabel, panelMode, wallLabel } from './form-logic.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 繊維方向の選択肢（せん断座屈の a・b をどちらの辺に取るか）。 */
const GRAIN_CHOICES = [
  { value: '', text: '長辺方向' },
  { value: 'height', text: '高さ方向' },
  { value: 'width', text: '幅方向' },
];

/** 面材と釘をまだ選んでいない面材に出す案内。 */
const DEFAULT_NAIL_NOTE =
  '表にない組合せは、グレー本 4.5 の試験で求めた k・ΔPv・δv・δu を' +
  '直接入力してください。読み込んだあとに編集できます。';

/** 面材を張る面（両面張りの壁を、配列図で描き分けるための選択）。 */
const SIDE_CHOICES = [
  { value: 'front', text: '表面' },
  { value: 'back', text: '裏面' },
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
  return {
    wallName: element(root, 'wallName').value.trim(),
    height: Number(element(root, 'wallHeight').value) || 0,
    width: Number(element(root, 'wallWidth').value) || 0,
    hasIntermediateStud: element(root, 'wallHasStud').checked,
    panels: readPanels(root),
  };
}

/** 壁を構成する面材の入力欄を、並び順のまま読み取る。 */
export function readPanels(root) {
  return Array.from(root.querySelectorAll('[data-panel-index]')).map((node) => {
    const checked = node.querySelector('input[data-panel-mode]:checked');
    // 面材と釘の数値は、未入力を空文字のまま持ち帰る（0 を入れてしまうと
    // 「確かめないまま計算した」ように見えるため）。
    const spec = (name) => optionalNumberOf(field(node, name));
    return {
      panelId: node.getAttribute('data-panel-id'),
      panelName: field(node, 'panelName').value.trim(),
      materialId: field(node, 'materialId').value,
      thickness: spec('thickness'),
      shearModulus: spec('shearModulus'),
      k: spec('k'),
      deltaV: spec('deltaV'),
      deltaU: spec('deltaU'),
      deltaPv: spec('deltaPv'),
      gradeId: field(node, 'gradeId').value,
      tauMax: spec('tauMax'),
      e1: spec('e1'),
      e2: spec('e2'),
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
      side: field(node, 'side').value,
      // 壁内の位置は任意入力。0（壁の端）と「書いていない」を取り違えない
      // よう、未入力は空文字のまま持ち帰る。
      originX: optionalNumberOf(field(node, 'originX')),
      originY: optionalNumberOf(field(node, 'originY')),
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
  element(root, 'wallHasStud').checked = wall.hasIntermediateStud !== false;
  renderWallPanels(root, wall.panels, options);
}

/**
 * 面材ごとの案内（選んだ釘の呼び径と、そこから決まるへりあき）を出し直す。
 *
 * へりあきは釘の呼び径で決まる（適用範囲 3.3(1)④）ので、面材と釘を選んだ
 * 面材にはその値を、選んでいない面材には直接入力の案内を出す。
 */
export function showNailNotes(root, noteOf) {
  root.querySelectorAll('[data-panel-index]').forEach((node) => {
    const note = noteOf(field(node, 'materialId').value);
    node.querySelector('[data-panel-note]').textContent = note || DEFAULT_NAIL_NOTE;
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

/** 面材の中の小見出し（「面材と釘」「面材の配置と釘配列」）。 */
function subheading(document_, text, note) {
  const box = document_.createElement('div');
  box.className = 'panel-group';
  const title = document_.createElement('h4');
  title.textContent = text;
  box.appendChild(title);
  if (note) {
    const hint = document_.createElement('p');
    hint.className = 'hint';
    hint.textContent = note;
    box.appendChild(hint);
  }
  return box;
}

/** { id, label } の一覧を選べる select にする（先頭は読み込みの案内）。 */
function tableSelect(document_, name, value, entries, placeholder) {
  const choices = [{ value: '', text: placeholder }].concat(
    (entries || []).map((entry) => ({ value: entry.id, text: entry.label }))
  );
  // 読み込んだ組合せが一覧に無くても、その id は捨てない（保存した PDF を
  // 新しい版で開いたときに、選択の跡が消えないようにする）。
  if (value && !choices.some((choice) => choice.value === value)) {
    choices.push({ value, text: value });
  }
  return select(document_, name, value || '', choices);
}

/**
 * 面材 1 枚分の「面材と釘」の入力欄を組み立てる。
 *
 * 面材の種類・厚さと釘は面材ごとに決められる（1 枚の壁でも、上半分は N50、
 * 下半分は CN50 のように張り分けることがある）。表 3.3.1・表 3.3.2 の一覧
 * から読み込むと数値が入り、そのあと手で直せる。
 */
function buildPanelSpec(document_, panel, index, options) {
  const group = subheading(document_, '面材と釘（グレー本 表 3.3.1・表 3.3.2）');

  group.appendChild(
    labelled(
      document_,
      '面材と釘の組合せ（表 3.3.1）から読み込む',
      tableSelect(
        document_,
        'materialId',
        panel.materialId,
        options && options.materials,
        '選択すると、下の数値へ読み込みます'
      )
    )
  );
  const note = document_.createElement('p');
  note.className = 'hint';
  note.setAttribute('data-panel-note', String(index));
  note.textContent = DEFAULT_NAIL_NOTE;
  group.appendChild(note);

  const number = (name, text, value) =>
    labelled(document_, text, input(document_, name, value, {
      type: 'number',
      inputmode: 'decimal',
      step: 'any',
    }));
  const row = (...fields) => {
    const line = document_.createElement('div');
    line.className = 'panel-size';
    line.append(...fields);
    return line;
  };

  group.append(
    row(
      number('thickness', '面材の厚さ t [mm]', panel.thickness),
      number('shearModulus', 'せん断弾性係数 GB [kN/mm²]', panel.shearModulus)
    ),
    row(
      number('k', '釘の剛性 k [kN/mm]', panel.k),
      number('deltaPv', '降伏耐力 ΔPv [kN]', panel.deltaPv)
    ),
    row(
      number('deltaV', '降伏点変位 δv [mm]', panel.deltaV),
      number('deltaU', '終局変位 δu [mm]', panel.deltaU)
    )
  );

  group.appendChild(
    labelled(
      document_,
      '面材の規格（表 3.3.2）から読み込む',
      tableSelect(
        document_,
        'gradeId',
        panel.gradeId,
        options && options.grades,
        '選択すると、下の数値へ読み込みます'
      )
    )
  );
  const gradeNote = document_.createElement('p');
  gradeNote.className = 'hint';
  gradeNote.textContent =
    '面材のせん断破壊・せん断座屈の検定（式 3.3.8〜3.3.11）に使います。' +
    '上の組合せを選ぶと、既定の規格（構造用合板なら JAS 1 級）が入ります。' +
    'E1 は面材の繊維直交方向、E2 は繊維平行方向です。';
  group.appendChild(gradeNote);

  group.appendChild(
    row(
      number('tauMax', 'せん断強度 τmax [N/mm²]', panel.tauMax),
      number('e1', '曲げヤング係数 E1 [N/mm²]', panel.e1),
      number('e2', '曲げヤング係数 E2 [N/mm²]', panel.e2)
    )
  );
  return group;
}

/**
 * 面材 1 枚分の「壁のどこに張るか」の入力欄を組み立てる。
 *
 * 剛性・許容せん断耐力（3.3）は面材ごとの値の和なので、ここに入れる位置は
 * 計算そのものを変えない。計算書に「どう張る前提の計算か」を図で残し、
 * 配置と計算の食い違い（はみ出し・重なり・配置漏れ）を判定で拾うための欄。
 *
 * 任意入力なので、空のままなら今までどおり枚数だけで計算する（配列図も
 * 判定の行も出ない）。
 */
function buildPanelPlacement(document_, panel) {
  const group = subheading(
    document_,
    '壁内の位置（壁の面材配列図）',
    '壁の左下を原点として、この面材の左下の位置を入れます。' +
      '入れると計算書に壁の面材配列図が付き、はみ出し・重なり・書き忘れを判定します。' +
      '空のままなら、今までどおり枚数だけで計算します（図は出ません）。'
  );
  const line = document_.createElement('div');
  line.className = 'panel-size';
  line.append(
    labelled(document_, '張る面', select(document_, 'side', panel.side || 'front', SIDE_CHOICES)),
    labelled(document_, '左下の位置 X [mm]', input(document_, 'originX', panel.originX, {
      type: 'number',
      inputmode: 'numeric',
      step: 'any',
      placeholder: '未指定',
    })),
    labelled(document_, '左下の位置 Y [mm]', input(document_, 'originY', panel.originY, {
      type: 'number',
      inputmode: 'numeric',
      step: 'any',
      placeholder: '未指定',
    }))
  );
  group.appendChild(line);
  return group;
}

/**
 * 面材 1 枚分の入力欄と、その面材の計算結果の器を組み立てる。
 *
 * 1 枚の面材は「面材と釘の仕様 → 面材の配置と釘配列 → その面材の釘配列
 * 諸定数」の順に並べる（実際の設計でも、面材と釘を決めてから配置と釘の
 * 間隔で耐力を調整するため）。
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
  box.appendChild(buildPanelSpec(document_, panel, index, options));

  const placing = subheading(
    document_,
    '面材の配置と釘配列（グレー本 3.2）',
    'へりあきは、適用範囲 3.3(1)④ の「10 mm 以上かつ接合具径 d ×5 以上」を' +
      '満たす値を入れてください（上で面材と釘を選ぶと、足りなければその値まで' +
      '引き上げます）。'
  );
  box.appendChild(placing);
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

  box.appendChild(buildPanelPlacement(document_, panel));

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
    'へりあきは面材の縁から釘の中心までの距離です。' +
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
  // 途中経過の表は値が長い（「34,647,000 mm²」など）ので、狭い画面では
  // ページごと横に広げず、表の中だけを横スクロールさせる。
  const stepsBox = document_.createElement('div');
  stepsBox.className = 'table-scroll';
  stepsBox.appendChild(steps);
  const diagram = document_.createElementNS(SVG_NS, 'svg');
  diagram.setAttribute('data-panel-diagram', String(index));
  diagram.setAttribute('role', 'img');
  diagram.setAttribute('aria-label', '釘配列図');
  diagram.setAttribute('hidden', '');
  result.append(error, summary, stepsBox, diagram);
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
  const layoutBox = element(root, 'wallLayout');
  const layoutDiagram = element(root, 'wallLayoutDiagram');
  const layoutNote = element(root, 'wallLayoutNote');
  const layoutHead = element(root, 'wallLayoutHead');
  const layoutBody = element(root, 'wallLayoutBody');
  const specHead = element(root, 'wallSpecHead');
  const specBody = element(root, 'wallSpecBody');
  const head = element(root, 'wallPanelHead');
  const body = element(root, 'wallPanelBody');
  const steps = element(root, 'wallStepsBody');
  const bucklingHead = element(root, 'wallBucklingHead');
  const bucklingBody = element(root, 'wallBucklingBody');
  const checks = element(root, 'wallChecksBody');
  const document_ = summary.ownerDocument;

  // 面材ごとの釘配列諸定数は、壁の計算の一部として一緒に返る。
  renderPanelResults(root, report && report.panelReports);

  [summary, layoutHead, layoutBody, specHead, specBody, head, body, steps,
   bucklingHead, bucklingBody, checks]
    .forEach((node) => {
      node.innerHTML = '';
    });

  if (!report || !report.ok) {
    errorBox.hidden = !report;
    errorBox.textContent = report ? report.error : '';
    layoutBox.hidden = true;
    renderWallDiagram(layoutDiagram, null);
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

  // 壁内の面材配列。位置を入れていない壁では節ごと出さない（枚数だけで
  // 計算した、という今までどおりの計算書になる）。
  const wallDiagram = buildWallDiagram(report.wallDiagram);
  layoutBox.hidden = !wallDiagram;
  renderWallDiagram(layoutDiagram, wallDiagram);
  layoutNote.textContent =
    wallDiagram && wallDiagram.unplaced.length
      ? `壁内の位置を入れていない面材（${wallDiagram.unplaced.join('、')}）は、` +
        'この図に描けません。計算には枚数として入っています。'
      : '';
  layoutNote.hidden = !layoutNote.textContent;
  if (wallDiagram) {
    appendTable(layoutHead, layoutBody, report.layoutColumns, report.layout);
  }

  // 面材と釘は面材ごとの入力なので、どの面材がどの数値で計算されたのかを
  // 壁の結果にも並べる（張り分けた壁でも根拠がその場でそろう）。
  appendTable(specHead, specBody, report.specColumns, report.specs);
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
      // 判定の根拠は文章なので、式番号（step-eq）とは別に折り返させる。
      { text: check.value, className: 'check-value' },
      // verdict は「これは判定の升目である」という印。画面の見た目
      // （OK は緑・NG は赤・NG のある行は行ごと色を付ける）と、結果の節の
      // 見出しの帯の色（NG が 1 つでもあれば赤）が、この印から決まる。
      {
        text: check.ok ? 'OK' : 'NG',
        className: check.ok ? 'step-value verdict ok' : 'step-value verdict ng',
      },
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

/**
 * 壁の面材配列図を SVG へ描く（diagram が null なら空にする）。
 *
 * 壁の枠の中に、面材を張る位置どおりに並べる。はみ出している面材・同じ面で
 * 重なっている面材は、線を太くして名前に ※ を付ける（計算書 PDF は白黒で
 * 刷られるので、画面もそれと同じ見分け方にしておく）。
 */
export function renderWallDiagram(svg, diagram) {
  const document_ = svg.ownerDocument;
  svg.innerHTML = '';
  if (!diagram) {
    svg.setAttribute('hidden', '');
    return;
  }
  svg.removeAttribute('hidden');
  svg.setAttribute('viewBox', `0 0 ${diagram.svgWidth} ${diagram.svgHeight}`);
  svg.setAttribute('width', diagram.svgWidth);
  svg.setAttribute('height', diagram.svgHeight);

  diagram.sides.forEach((side) => {
    svg.appendChild(
      svgText(document_, side.captionX, 12, side.label, {
        'text-anchor': 'middle', fill: '#475569', 'font-size': 11,
      })
    );
    // 壁の枠。面材はこの中に納まっているのが正しい。
    const frame = (fill) =>
      svgNode(document_, 'rect', {
        x: side.frame.x, y: side.frame.y,
        width: side.frame.width, height: side.frame.height,
        fill, stroke: '#475569', 'stroke-width': 1.5,
      });
    svg.appendChild(frame('#f8fafc'));

    side.panels.forEach((panel) => {
      const rect = svgNode(document_, 'rect', {
        x: panel.x, y: panel.y, width: panel.width, height: panel.height,
        fill: panel.ok ? '#e2e8f0' : '#fee2e2',
        stroke: panel.ok ? '#94a3b8' : '#b91c1c',
        'stroke-width': panel.ok ? 1 : 2,
      });
      const title = document_.createElementNS(SVG_NS, 'title');
      title.textContent = panel.ok
        ? `${panel.label}（${panel.sizeLabel}）`
        : `${panel.label}（${panel.sizeLabel}）: ${panel.note}`;
      rect.appendChild(title);
      svg.appendChild(rect);

      const centerX = panel.x + panel.width / 2;
      const centerY = panel.y + panel.height / 2;
      svg.appendChild(
        svgText(document_, centerX, centerY - 1,
          panel.ok ? panel.label : `※ ${panel.label}`, {
            'text-anchor': 'middle', 'font-size': 10,
            fill: panel.ok ? '#0f172a' : '#b91c1c',
          })
      );
      svg.appendChild(
        svgText(document_, centerX, centerY + 11, panel.sizeLabel, {
          'text-anchor': 'middle', fill: '#64748b', 'font-size': 9,
        })
      );
    });

    // 壁の枠をもう一度、線だけ描く。はみ出した面材が壁の縁を塗り隠すと、
    // どこまでが壁なのかが分からなくなるため。
    svg.appendChild(frame('none'));

    // 壁の寸法（図の下と左に、数字だけを添える）。
    svg.appendChild(
      svgText(document_, side.frame.x + side.frame.width / 2,
        side.frame.y + side.frame.height + 14, side.widthLabel, {
          'text-anchor': 'middle', fill: '#94a3b8', 'font-size': 9,
        })
    );
    svg.appendChild(
      svgText(document_, side.frame.x - 6, side.frame.y + side.frame.height / 2,
        side.heightLabel, { 'text-anchor': 'end', fill: '#94a3b8', 'font-size': 9 })
    );
  });
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
