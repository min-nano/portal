import { describe, expect, it } from 'vitest';
import { buildDiagram } from '../src/timber-panel-shear-calculator/diagram.js';

// 釘が面材からはみ出した配列（幅 610 に対して X が 890 まである）。
// 入力の打ち間違いでも図が壊れないことを確かめるための、意図的な例。
const NAILS = [
  { x: 0, y: 0 },
  { x: 0, y: 590 },
  { x: 445, y: 295 },
  { x: 890, y: 0 },
];

// 計算実装（wasm）が返す diagram。面材の寸法も範囲も目盛の文字も計算実装が
// 決める（計算書 PDF も同じものを読む）。
const DIAGRAM = {
  panelWidth: 610,
  panelHeight: 910,
  minX: 0,
  maxX: 890,
  minY: 0,
  maxY: 910,
  xTicks: [
    { value: 0, label: '0' },
    { value: 445, label: '445' },
    { value: 890, label: '890' },
  ],
  yTicks: [
    { value: 0, label: '0' },
    { value: 295, label: '295' },
    { value: 590, label: '590' },
  ],
  axis: { x0: 445, y0: 295, xLabel: 'x0 = 445.0', yLabel: 'y0 = 295.0' },
};

describe('buildDiagram', () => {
  it('描けない入力では null を返す', () => {
    expect(buildDiagram([], DIAGRAM)).toBeNull();
    expect(buildDiagram(NAILS, { ...DIAGRAM, panelWidth: 0 })).toBeNull();
    expect(buildDiagram(NAILS, { ...DIAGRAM, panelHeight: 0 })).toBeNull();
  });

  it('原点が左下に見えるよう y を反転する', () => {
    const diagram = buildDiagram(NAILS, DIAGRAM);

    const bottom = diagram.points.find((p) => p.y === 0);
    const top = diagram.points.find((p) => p.y === 590);
    // SVG の y は下向きなので、上にある釘ほど cy が小さい。
    expect(top.cy).toBeLessThan(bottom.cy);
  });

  it('面材からはみ出す釘も切り取らずに収める', () => {
    const diagram = buildDiagram(NAILS, DIAGRAM);

    const overhang = diagram.points.find((p) => p.x === 890);
    // 面材枠の右端より外に描かれるが、SVG の中には収まっている。
    expect(overhang.cx).toBeGreaterThan(diagram.frame.x + diagram.frame.width);
    expect(overhang.cx).toBeLessThanOrEqual(diagram.svgWidth);
  });

  it('目盛は計算実装が決めた値と文字を、画面の座標へ写しただけ', () => {
    const diagram = buildDiagram(NAILS, DIAGRAM);

    expect(diagram.xTicks.map((t) => t.label)).toEqual(['0', '445', '890']);
    expect(diagram.yTicks.map((t) => t.label)).toEqual(['0', '295', '590']);
    // 目盛の位置は釘の位置と同じ座標系。
    const onAxis = diagram.points.find((p) => p.x === 445);
    expect(diagram.xTicks[1].position).toBeCloseTo(onAxis.cx);
  });

  it('弾性中立軸の位置を釘と同じ座標系で返す', () => {
    const diagram = buildDiagram(NAILS, DIAGRAM);

    const onAxis = diagram.points.find((p) => p.x === 445 && p.y === 295);
    expect(diagram.axes.x).toBeCloseTo(onAxis.cx);
    expect(diagram.axes.y).toBeCloseTo(onAxis.cy);
    // 添える文字も計算実装のもの（計算書 PDF と同じ）。
    expect(diagram.axes.xLabel).toBe('x0 = 445.0');
  });

  it('計算結果がまだ無ければ図も描かない', () => {
    expect(buildDiagram(NAILS, null)).toBeNull();
  });
});
