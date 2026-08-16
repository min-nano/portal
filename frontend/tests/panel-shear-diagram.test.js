import { describe, expect, it } from 'vitest';
import {
  buildDiagram,
  buildWallDiagram,
} from '../src/timber-panel-shear-calculator/diagram.js';

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

// 壁内の面材配列（計算実装が返す wallDiagram）。幅 910・階高 3000 の壁の
// 表面に 910×1820 と 910×910 を積み、裏面にも 910×1820 を張った両面張り。
const WALL_DIAGRAM = {
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
      area: 2484300,
      panels: [
        {
          label: '下段', x: 0, y: 0, width: 910, height: 1820,
          sizeLabel: '910 × 1,820 mm', note: '', ok: true,
        },
        {
          label: '上段', x: 0, y: 1820, width: 910, height: 910,
          sizeLabel: '910 × 910 mm', note: '', ok: true,
        },
      ],
    },
    {
      id: 'back',
      label: '裏面',
      count: 1,
      area: 1656200,
      panels: [
        {
          label: '裏 下段', x: 0, y: 0, width: 910, height: 1820,
          sizeLabel: '910 × 1,820 mm', note: '', ok: true,
        },
      ],
    },
  ],
  unplaced: [],
};

describe('buildWallDiagram', () => {
  it('配置が無ければ図も描かない', () => {
    expect(buildWallDiagram(null)).toBeNull();
    expect(buildWallDiagram({ ...WALL_DIAGRAM, sides: [] })).toBeNull();
    expect(buildWallDiagram({ ...WALL_DIAGRAM, wallWidth: 0 })).toBeNull();
  });

  it('原点が壁の左下に見えるよう y を反転する', () => {
    const diagram = buildWallDiagram(WALL_DIAGRAM);

    const [lower, upper] = diagram.sides[0].panels;
    // SVG の y は下向きなので、上の段ほど y が小さい。
    expect(upper.y).toBeLessThan(lower.y);
    // 下段の下端は壁の下端に接する。
    expect(lower.y + lower.height).toBeCloseTo(
      diagram.sides[0].frame.y + diagram.sides[0].frame.height
    );
  });

  it('両面張りは、表と裏を同じ縮尺で横に並べる', () => {
    const diagram = buildWallDiagram(WALL_DIAGRAM);

    expect(diagram.sides.map((side) => side.label)).toEqual([
      '表面（2 枚）',
      '裏面（1 枚）',
    ]);
    // 裏面は表面の右側にあり、どちらも SVG の中に収まる。
    expect(diagram.sides[1].frame.x).toBeGreaterThan(
      diagram.sides[0].frame.x + diagram.sides[0].frame.width
    );
    expect(diagram.sides[1].frame.x + diagram.sides[1].frame.width)
      .toBeLessThanOrEqual(diagram.svgWidth);
    // 同じ寸法の面材が、面によって違う大きさに見えないこと。
    expect(diagram.sides[1].panels[0].height)
      .toBeCloseTo(diagram.sides[0].panels[0].height);
  });

  it('壁からはみ出す面材も切り取らずに収める', () => {
    const diagram = buildWallDiagram({
      ...WALL_DIAGRAM,
      maxY: 3410,
      sides: [
        {
          ...WALL_DIAGRAM.sides[0],
          panels: [
            {
              ...WALL_DIAGRAM.sides[0].panels[1],
              y: 2500, note: 'はみ出し', ok: false,
            },
          ],
        },
      ],
    });

    const [overhang] = diagram.sides[0].panels;
    expect(overhang.ok).toBe(false);
    expect(overhang.note).toBe('はみ出し');
    // 壁枠の上端より外に描かれるが、SVG の中には収まっている。
    expect(overhang.y).toBeLessThan(diagram.sides[0].frame.y);
    expect(overhang.y).toBeGreaterThanOrEqual(0);
  });

  it('壁の寸法を、図に添える文字として返す', () => {
    const diagram = buildWallDiagram(WALL_DIAGRAM);

    expect(diagram.sides[0].widthLabel).toBe('W = 910 mm');
    expect(diagram.sides[0].heightLabel).toBe('H = 3,000 mm');
  });

  it('図に描けない面材（位置が未指定）を持ち帰る', () => {
    const diagram = buildWallDiagram({ ...WALL_DIAGRAM, unplaced: ['面材3'] });

    expect(diagram.unplaced).toEqual(['面材3']);
  });
});
