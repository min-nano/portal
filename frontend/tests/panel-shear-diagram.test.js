import { describe, expect, it } from 'vitest';
import { buildDiagram } from '../src/timber-panel-shear-calculator/diagram.js';

// グレー本 解説の計算例（図 3.2.2）。X の 890 は面材の幅 610 をはみ出す。
const NAILS = [
  { x: 0, y: 0 },
  { x: 0, y: 590 },
  { x: 445, y: 295 },
  { x: 890, y: 0 },
];
const RESULT = { x0: 445, y0: 295 };

describe('buildDiagram', () => {
  it('描けない入力では null を返す', () => {
    expect(buildDiagram([], 610, 910, RESULT)).toBeNull();
    expect(buildDiagram(NAILS, 0, 910, RESULT)).toBeNull();
    expect(buildDiagram(NAILS, 610, 0, RESULT)).toBeNull();
  });

  it('原点が左下に見えるよう y を反転する', () => {
    const diagram = buildDiagram(NAILS, 610, 910, RESULT);

    const bottom = diagram.points.find((p) => p.y === 0);
    const top = diagram.points.find((p) => p.y === 590);
    // SVG の y は下向きなので、上にある釘ほど cy が小さい。
    expect(top.cy).toBeLessThan(bottom.cy);
  });

  it('面材からはみ出す釘も切り取らずに収める', () => {
    const diagram = buildDiagram(NAILS, 610, 910, RESULT);

    const overhang = diagram.points.find((p) => p.x === 890);
    // 面材枠の右端より外に描かれるが、SVG の中には収まっている。
    expect(overhang.cx).toBeGreaterThan(diagram.frame.x + diagram.frame.width);
    expect(overhang.cx).toBeLessThanOrEqual(diagram.svgWidth);
  });

  it('目盛は重複を除いた昇順になる', () => {
    const diagram = buildDiagram(NAILS, 610, 910, RESULT);

    expect(diagram.xTicks.map((t) => t.value)).toEqual([0, 445, 890]);
    expect(diagram.yTicks.map((t) => t.value)).toEqual([0, 295, 590]);
  });

  it('弾性中立軸の位置を釘と同じ座標系で返す', () => {
    const diagram = buildDiagram(NAILS, 610, 910, RESULT);

    const onAxis = diagram.points.find((p) => p.x === 445 && p.y === 295);
    expect(diagram.axes.x).toBeCloseTo(onAxis.cx);
    expect(diagram.axes.y).toBeCloseTo(onAxis.cy);
  });

  it('計算結果がまだ無ければ中立軸を描かない', () => {
    expect(buildDiagram(NAILS, 610, 910, null).axes).toBeNull();
  });
});
