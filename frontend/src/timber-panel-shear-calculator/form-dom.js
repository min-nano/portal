// 画面（DOM）とデータの往復、および計算結果・釘配列図の描画。
//
// 項目が固定のフォームなので、入力欄は tools/…/index.html に直接置いてある。
// ここが受け持つのは「今のパターンを入力欄へ写す／入力欄から読み取る」と
// 「計算実装が返した表示用の値を並べる」こと。数値の丸めや単位は計算実装
// （core/、wasm）が組み立てた文字列をそのまま出す。計算書 PDF も同じ文字列を
// 刷るので、画面と計算書で桁がずれない。

import { buildDiagram } from './diagram.js';
import { patternLabel } from './form-logic.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function element(root, id) {
  return root.getElementById ? root.getElementById(id) : root.querySelector(`#${id}`);
}

/** 入力欄から今のパターンの内容を読み取る（patternId は画面が持たない）。 */
export function readPattern(root) {
  const checked = root.querySelector('input[name="nailMode"]:checked');
  return {
    patternName: element(root, 'patternName').value.trim(),
    width: Number(element(root, 'patternWidth').value) || 0,
    height: Number(element(root, 'patternHeight').value) || 0,
    mode: checked && checked.value === 'coords' ? 'coords' : 'grid',
    gridX: element(root, 'gridX').value.trim(),
    gridY: element(root, 'gridY').value.trim(),
    coords: element(root, 'coords').value.trim(),
  };
}

/** パターンの内容を入力欄へ写す。 */
export function applyPattern(root, pattern) {
  element(root, 'patternName').value = pattern.patternName || '';
  element(root, 'patternWidth').value = pattern.width || '';
  element(root, 'patternHeight').value = pattern.height || '';
  element(root, 'gridX').value = pattern.gridX || '';
  element(root, 'gridY').value = pattern.gridY || '';
  element(root, 'coords').value = pattern.coords || '';
  root.querySelectorAll('input[name="nailMode"]').forEach((radio) => {
    radio.checked = radio.value === pattern.mode;
  });
  syncNailModeVisibility(root);
  showPanelArea(root);
}

/** 選ばれている入力方式に応じて、格子／座標の入力欄を出し分ける。 */
export function syncNailModeVisibility(root) {
  const checked = root.querySelector('input[name="nailMode"]:checked');
  const coords = checked && checked.value === 'coords';
  element(root, 'gridInputs').hidden = coords;
  element(root, 'coordsInputs').hidden = !coords;
}

/**
 * 面材面積の目安を入力欄の横に出す。
 *
 * 正となる面積は計算結果（と計算書）に載るサーバ側の値。ここは幅 × 高さを
 * その場で掛けただけの入力補助で、桁を間違えたときにすぐ気付けるようにする。
 */
export function showPanelArea(root) {
  const width = Number(element(root, 'patternWidth').value) || 0;
  const height = Number(element(root, 'patternHeight').value) || 0;
  const area = width * height;
  element(root, 'panelArea').textContent = area > 0
    ? `${Math.round(area).toLocaleString('ja-JP')} mm²`
    : '-';
}

/** パターンのタブと現在位置を描き直す。 */
export function renderPatternBar(root, patterns, currentIndex, onSelect) {
  element(root, 'patternPosition').textContent =
    `パターン ${currentIndex + 1} / ${patterns.length}`;
  element(root, 'prevBtn').disabled = currentIndex === 0;
  element(root, 'nextBtn').disabled = currentIndex >= patterns.length - 1;
  element(root, 'removePatternBtn').disabled = patterns.length <= 1;

  const tabs = element(root, 'patternTabs');
  tabs.innerHTML = '';
  patterns.forEach((pattern, index) => {
    const button = tabs.ownerDocument.createElement('button');
    button.type = 'button';
    button.textContent = patternLabel(pattern, index);
    button.className = index === currentIndex ? 'tab current' : 'tab';
    button.addEventListener('click', () => onSelect(index));
    tabs.appendChild(button);
  });
}

/**
 * 計算結果を描く。report が null（入力が足りない）なら案内だけを出す。
 * report.ok が false なら、その理由を出して結果は空にする。
 */
export function renderResult(root, report, pattern) {
  const errorBox = element(root, 'resultError');
  const summary = element(root, 'summary');
  const steps = element(root, 'stepsBody');
  const document_ = summary.ownerDocument;

  summary.innerHTML = '';
  steps.innerHTML = '';

  if (!report || !report.ok) {
    errorBox.hidden = !report;
    errorBox.textContent = report ? report.error : '';
    element(root, 'resultNote').hidden = Boolean(report);
    renderDiagram(element(root, 'diagram'), null);
    return;
  }
  errorBox.hidden = true;
  element(root, 'resultNote').hidden = true;

  report.summary.forEach((item) => {
    const box = document_.createElement('div');
    box.className = 'result-box';
    const label = document_.createElement('span');
    label.className = 'key';
    label.textContent = item.unit ? `${item.key} [${item.unit}]` : item.key;
    const value = document_.createElement('strong');
    value.className = 'value';
    value.textContent = item.value;
    box.append(label, value);
    summary.appendChild(box);
  });

  report.steps.forEach((row) => {
    const tr = document_.createElement('tr');
    [
      { text: row.label, className: 'step-label' },
      { text: row.eq, className: 'step-eq' },
      { text: row.value, className: 'step-value' },
    ].forEach((cell) => {
      const td = document_.createElement('td');
      td.className = cell.className;
      td.textContent = cell.text;
      tr.appendChild(td);
    });
    steps.appendChild(tr);
  });

  renderDiagram(
    element(root, 'diagram'),
    buildDiagram(report.nails, pattern.width, pattern.height, report.diagram)
  );
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
