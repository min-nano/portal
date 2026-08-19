// 画面が編集中に使う計算実装（wasm）のテスト。
//
// 読み込むのは、core/build.sh がビルドした **本物の .wasm**
// （backend/app/wasm/nail_array_core.wasm）。本番の画面はこれと同じバイト列を
// /api/tools/timber-panel-shear-calculator/core.wasm から受け取るので、ここで
// 通ることは「サーバと同じ計算が画面でもできる」ことの確認になる。
//
// .wasm はコミットしていない。手元で初めて動かすときは、先に core/build.sh を
// 実行すること（無ければ、その旨のエラーで落ちる）。
//
// 式ごとの検証は core/src/*.rs の `cargo test` にある。ここで確かめるのは、
// JavaScript から正しく呼べること（線形メモリの受け渡し）と、グレー本の
// 計算例が同じ数字で返ること。

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  instantiateCore,
  loadCore,
} from '../src/core.js';

const WASM_PATH = new URL(
  '../../backend/app/wasm/nail_array_core.wasm',
  import.meta.url
);

/** ビルド済みの .wasm を読む。無ければ、何をすればよいかを言って落ちる。 */
async function wasmBytes() {
  try {
    return await readFile(WASM_PATH);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(
      '計算実装（wasm）がありません。リポジトリ直下で core/build.sh を' +
        '実行してから、もう一度テストしてください（要 rustup）。'
    );
  }
}

// 壁の左下に張った 910 × 610 の面材（間柱 @455・釘 @150・へりあき 10 mm）。
// 面材は「壁の中で占める領域」なので、寸法も釘配列もこの領域と壁の間柱
// ピッチから決まる。表 3.2.1 の「910×610 横置・日型（@455 / 釘 @150）」に
// あたる配列になる。
const EXAMPLE_PANEL = {
  panelId: 'pn1',
  panelName: '下段',
  left: 0,
  bottom: 0,
  right: 910,
  top: 610,
  nailPitch: 150,
  edgeDistance: 10,
};

/** 面材を並べただけの壁（面材と釘の数値は入れない）。 */
function wallOf(...panels) {
  return { walls: [{ wallId: 'w1', width: 910, height: 2900, frame: FRAME, panels }] };
}

// 壁の軸組材（尺モジュール）。1 本ずつ自由な位置に入れるので、面材の縁が
// 来るところ（面材の上端 610）にも受け材を入れておく。
const FRAME = [
  { kind: 'column', direction: 'vertical', label: '柱', position: 0, width: 105 },
  { kind: 'stud', direction: 'vertical', label: '間柱', position: 455, width: 45 },
  { kind: 'column', direction: 'vertical', label: '柱', position: 910, width: 105 },
  { kind: 'beam', direction: 'horizontal', label: '横架材', position: 0, width: 105 },
  { kind: 'joint', direction: 'horizontal', label: '受け材', position: 610, width: 105 },
  { kind: 'beam', direction: 'horizontal', label: '横架材', position: 2900, width: 105 },
];

async function core() {
  return instantiateCore(await wasmBytes());
}

/** 面材 1 枚分の釘配列諸定数（壁の計算の一部として返るもの）。 */
function panelReport(walls, index = 0) {
  return walls[0].panelReports[index];
}

describe('計算実装（wasm）', () => {
  it('版を名乗る（保存時にサーバと突き合わせる）', async () => {
    expect((await core()).version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('壁の軸組と面材の領域から、釘配列諸定数を計算書と同じ桁で返す', async () => {
    const { walls } = (await core()).computeAll(wallOf(EXAMPLE_PANEL));
    const report = panelReport(walls);

    expect(report.ok).toBe(true);
    // 表 3.2.1 の「910×610 横置・日型（@455 / 釘 @150）」の欄
    //（本の値は Ixy 1.56 / Zxy 0.0063 / Cxy 1.23）。
    expect(report.result.Ixy).toBeCloseTo(1.56, 1);
    expect(report.nails).toHaveLength(23);
    expect(report.result.x0).toBe(455);
    expect(report.result.y0).toBe(305);
    // 寸法も面積も、領域から決まる。
    expect(report.width).toBe(910);
    expect(report.height).toBe(610);
    expect(report.panelArea).toBe(555100);
  });

  it('へりあきを変えると釘の位置が動く（面材・釘に合わせて調整できる）', async () => {
    const loaded = await core();
    const narrow = panelReport(loaded.computeAll(wallOf(EXAMPLE_PANEL)).walls);
    const wide = panelReport(
      loaded.computeAll(wallOf({ ...EXAMPLE_PANEL, edgeDistance: 20 })).walls
    );

    expect(narrow.nails[0]).toEqual({ x: 10, y: 10 });
    expect(wide.nails[0]).toEqual({ x: 20, y: 20 });
    // 釘が内側へ寄るぶん、釘配列二次モーメントは小さくなる。
    expect(wide.result.Ixy).toBeLessThan(narrow.result.Ixy);
  });

  it('軸組材の位置と見付け幅から、軸材の縁端距離を判定する', async () => {
    const loaded = await core();
    // 壁の左下に 910 × 610 を 1 枚（面材と釘は 3.3(3) の計算例の組合せ）。
    const wallWith = (frame) =>
      loaded.computeAll({
        walls: [
          {
            wallId: 'w1',
            width: 910,
            height: 2900,
            frame,
            panels: [
              {
                ...EXAMPLE_PANEL,
                materialId: 'plywood12-n65',
                thickness: 12,
                shearModulus: 0.4,
                k: 0.483,
                deltaV: 2.3,
                deltaU: 17,
                deltaPv: 1.13,
                tauMax: 3.6,
                e1: 3500,
                e2: 5500,
              },
            ],
          },
        ],
      }).walls[0];
    const check = (wall) =>
      wall.checks.find((entry) => entry.label.includes('軸材の縁端距離'));

    // 尺モジュールの軸組（釘は @455 の間柱の心にも来るので、いちばん厳しい
    // のは 45 / 2）。
    const standard = wallWith(FRAME);
    expect(standard.ok).toBe(true);
    expect(standard.frameClearanceOk).toBe(true);
    expect(check(standard).value).toContain('最小 縁端距離 22.5 mm ≧ 20 mm');
    expect(check(standard).value).toContain('間柱（見付け 45 mm）');

    // 30 mm の間柱では、材心に打つ釘の縁端距離が 15 mm しか取れない。
    const narrow = wallWith(
      FRAME.map((member) =>
        member.label === '間柱' ? { ...member, width: 30 } : member
      )
    );
    expect(narrow.frameClearanceOk).toBe(false);
    expect(check(narrow).value).toContain('最小 縁端距離 15 mm < 20 mm');
    // 軸組材は、種別・向き・位置・見付け幅まで壁の計算書に残る。
    expect(narrow.frame.map((row) => row.cells[2])).toEqual([
      'X = 0',
      'X = 455',
      'X = 910',
      'Y = 0',
      'Y = 610',
      'Y = 2,900',
    ]);
    expect(narrow.frame[1].cells[0]).toBe('間柱');
    // 面材のページにも、その面材でいちばん厳しい釘列が残る。
    expect(
      narrow.panelReports[0].inputs.find((row) =>
        row.label.startsWith('軸材の縁端距離')
      ).value
    ).toBe('最小 15 mm（中間の縦材（X = 455 mm） ／ 間柱（見付け 30 mm））');

    // 面材の縁を受ける材が無ければ、そこには釘を打てない。
    const missing = wallWith(FRAME.filter((member) => member.position !== 610));
    expect(missing.frameClearanceOk).toBe(false);
    expect(check(missing).value).toContain('軸組材なし');
  });

  it('図の軸組材は、交わるところを種別の勝ち負けで切る', async () => {
    const loaded = await core();
    const wall = loaded.computeAll({
      walls: [
        {
          wallId: 'w1',
          width: 910,
          height: 2900,
          frame: FRAME,
          panels: [{ ...EXAMPLE_PANEL, thickness: 12, shearModulus: 0.4, k: 0.483,
            deltaV: 2.3, deltaU: 17, deltaPv: 1.13, tauMax: 3.6, e1: 3500, e2: 5500 }],
        },
      ],
    }).walls[0];
    const pieces = (label) =>
      wall.wallDiagram.members.filter((member) => member.label === label);

    // 横架材（材心 Y = 0）は左から右まで通る。
    expect(pieces('横架材')[0].width).toBe(910);
    // 柱は横架材に負けるので、上下の横架材のあいだだけになる。
    const column = pieces('柱')[0];
    expect([column.y, column.height]).toEqual([52.5, 2900 - 105]);
    // 受け材（継目の材）は柱に負けて、柱と柱のあいだだけになる。
    const joint = pieces('受け材')[0];
    expect([joint.x, joint.width]).toEqual([52.5, 910 - 105]);
    // 間柱は上下の横架材にも、途中の受け材にも負ける。受け材で断ち切られる
    // ので 2 片になり、どちらも横架材の内側で止まる。
    const stud = pieces('間柱');
    expect(stud).toHaveLength(2);
    expect(stud.map((piece) => [piece.y, piece.height])).toEqual([
      [52.5, 557.5 - 52.5],
      [662.5, 2847.5 - 662.5],
    ]);
    expect(stud.every((piece) => piece.width === 45)).toBe(true);
  });

  it('軸組材は等間隔でも組み立てられる（そのあと 1 本ずつ動かせる）', async () => {
    const frame = (await core()).frame({ width: 1820, height: 2900, studPitch: 455 });

    expect(frame.map((member) => member.position)).toEqual([
      0, 455, 910, 1365, 1820, 0, 2900,
    ]);
    expect(frame[1]).toEqual({
      kind: 'stud',
      direction: 'vertical',
      label: '間柱',
      position: 455,
      width: 45,
    });
  });

  it('釘配列図の範囲と目盛も返す（計算書 PDF と同じもの）', async () => {
    const report = panelReport((await core()).computeAll(wallOf(EXAMPLE_PANEL)).walls);

    expect(report.diagram.panelWidth).toBe(910);
    // 描く範囲には、この面材にかかる軸組材（右端の柱は材心が X = 910 の
    // 105 なので、半分が面材の外へ出る）まで入る。
    expect(report.diagram.maxX).toBe(962.5);
    // その軸組材も、図に描くために面材の座標で返る。
    expect(report.diagram.members.map((member) => member.label)).toEqual([
      '柱',
      '間柱',
      '柱',
      '横架材',
      '受け材',
    ]);
    // 四周打ちなので、横線の釘が 10〜900 に @150 で並ぶ。
    expect(report.diagram.xTicks.map((t) => t.label)).toEqual([
      '10', '155', '305', '455', '605', '755', '900',
    ]);
    expect(report.diagram.axis.xLabel).toBe('x0 = 455.0');
  });

  it('表 3.2.1 の標準的な組み合わせを一覧し、壁と面材へ読み込める', async () => {
    const loaded = await core();
    const presets = loaded.presets();

    // 配列の型は面材が壁のどこに来るかで決まるので、選択肢は型を除いた
    // 33 通り（寸法 × 間柱ピッチ × 釘ピッチ）。
    expect(presets).toHaveLength(33);
    const entry = presets.find((p) => p.id === '910x610-s455-n150-hi');
    expect(entry.label).toBe('910×610 横置（間柱・根太 @455 / 釘 @150）');

    const { wall, panel } = loaded.preset(entry.id);
    expect(wall).toEqual({ studPitch: 455 });
    expect(panel).toMatchObject({
      width: 910,
      height: 610,
      nailPitch: 150,
      edgeDistance: 10,
    });

    // 読み込んだ大きさを壁の左下へ置くと、表 3.2.1 の日型の欄と同じになる。
    const report = panelReport(
      loaded.computeAll(
        wallOf({
          ...EXAMPLE_PANEL,
          right: panel.width,
          top: panel.height,
          nailPitch: panel.nailPitch,
          edgeDistance: panel.edgeDistance,
        })
      ).walls
    );
    expect(report.nails).toHaveLength(entry.nailCount);
  });

  it('グレー本 表 3.3.1 の面材と釘の組合せを一覧する', async () => {
    const materials = (await core()).materials();

    expect(materials).toHaveLength(12);
    expect(materials[0]).toMatchObject({
      id: 'plywood12-n50',
      label: '構造用合板 12mm + 鉄丸釘 N-50',
      thickness: 12,
      shearModulus: 0.4,
      k: 0.43,
      deltaPv: 0.91,
      // へりあきを決めるための釘の呼び径（JIS A 5508）も付いてくる。
      nailDiameter: 2.75,
      // 表 3.3.2 の既定の規格（構造用合板は JAS 1 級）も一緒に付いてくる。
      gradeId: 'plywood-jas1',
      tauMax: 3.6,
      e1: 3500,
      e2: 5500,
    });
  });

  it('グレー本 表 3.3.2 の面材の規格を一覧する', async () => {
    const grades = (await core()).grades();

    expect(grades.map((grade) => grade.id)).toEqual([
      'plywood-jas1',
      'plywood-jas2',
      'mdf',
      'particleboard',
    ]);
    // JAS 2 級はせん断強度だけが下がる（注 *1 により E1・E2 は 1 級と同じ）。
    expect(grades[1]).toMatchObject({ tauMax: 2.4, e1: 3500, e2: 5500 });
  });

  it('グレー本 3.3 の計算例（図 3.3.10）を、本とほぼ同じ答えで返す', async () => {
    // 下から 910 × 1820、その上に 910 × 910 を張った壁（間柱 @455・釘 @75）。
    // 釘 1 本あたりの数値は、本文が計算に使っているものを面材ごとに入れる
    // （面材と釘の仕様は面材ごとの入力で、この計算例は 2 枚とも同じ組合せ）。
    //
    // 本は上側の 910 × 910 を「ロ型」（中間の間柱に釘を打たない配列）として
    // 計算している。釘配列を壁の軸組から導くこのツールでは @455 の間柱が
    // 正方形の面材の内側に来るので、本より釘が多く、答えも 1〜3% 大きく出る。
    const loaded = await core();
    const panels = [
      { panelName: '下段', left: 0, bottom: 0, right: 910, top: 1820 },
      { panelName: '上段', left: 0, bottom: 1820, right: 910, top: 2730 },
    ].map((panel) => ({
      ...panel,
      nailPitch: 75,
      edgeDistance: 10,
      thickness: 12,
      shearModulus: 0.4,
      k: 0.483,
      deltaV: 2.3,
      deltaU: 17,
      deltaPv: 1.13,
      tauMax: 3.6,
      e1: 3500,
      e2: 5500,
    }));

    const { walls } = loaded.computeAll({
      walls: [
        {
          wallId: 'w1',
          wallName: 'グレー本 3.3 の計算例',
          height: 3000,
          width: 910,
          studPitch: 455,
          panels,
        },
      ],
    });

    expect(walls[0].ok).toBe(true);
    // 本の答えは Pa = 8.37 kN、ΔPa = 9.20 kN/m（決めているのは K0/150）。
    expect(walls[0].governing).toBe('drift');
    expect(walls[0].result.Pa).toBeGreaterThan(8.37);
    expect((walls[0].result.Pa - 8.37) / 8.37).toBeLessThan(0.02);
    expect(walls[0].result.dPa).toBeGreaterThan(9.2);
    expect(walls[0].withinLimit).toBe(true);
    expect(walls[0].panels.map((panel) => panel.label)).toEqual(['下段', '上段']);
    // 壁の計算には、その根拠になる面材ごとの釘配列諸定数が付いてくる。
    expect(walls[0].panelReports).toHaveLength(2);
    // 下側の 910 × 1820 は、3.3(1)⑧ により本とまったく同じ配列になる。
    expect(walls[0].panelReports[0].result.Ixy).toBeCloseTo(4.99, 1);
    // 面材のせん断破壊・せん断座屈（式 3.3.8〜3.3.11）も、どちらも通る。
    expect(walls[0].shearOk).toBe(true);
    expect(walls[0].bucklingOk).toBe(true);
    expect(walls[0].buckling.every((panel) => panel.ok)).toBe(true);
    // 面材ごとの面材と釘も、そのまま表として返る。
    expect(walls[0].specs.map((spec) => spec.cells[0])).toEqual(['12', '12']);
  });

  it('壁の面材配列図と配置の判定が、どの壁にも付いてくる', async () => {
    // 面材を動かしても計算（3.3）は面材ごとの値の和のままだが、釘配列は
    // 壁の軸組との位置関係で変わる。食い違う配置はその場で拾う。
    const loaded = await core();
    const wallWith = (...panels) =>
      loaded.computeAll({
        walls: [
          {
            wallId: 'w1',
            height: 3000,
            width: 910,
            studPitch: 455,
            panels: panels.map((panel) => ({
              nailPitch: 75,
              edgeDistance: 10,
              thickness: 12,
              shearModulus: 0.4,
              k: 0.483,
              deltaV: 2.3,
              deltaU: 17,
              deltaPv: 1.13,
              tauMax: 3.6,
              e1: 3500,
              e2: 5500,
              ...panel,
            })),
          },
        ],
      }).walls[0];
    const placementCheck = (wall) =>
      wall.checks.find((check) => check.label.startsWith('面材の配置'));

    // 下から 910×1820、その上に 910×910。
    const stacked = wallWith(
      { panelName: '下段', left: 0, bottom: 0, right: 910, top: 1820 },
      { panelName: '上段', left: 0, bottom: 1820, right: 910, top: 2730 }
    );
    expect(stacked.wallDiagram.sides[0].label).toBe('表面');
    expect(stacked.wallDiagram.sides[0].panels).toHaveLength(2);
    expect(stacked.layout).toHaveLength(2);
    expect(placementCheck(stacked).ok).toBe(true);

    // 重なる配置は、枚数を二重に数えている印として拾う。
    const overlapping = wallWith(
      { panelName: '下段', left: 0, bottom: 0, right: 910, top: 1820 },
      { panelName: '上段', left: 0, bottom: 1000, right: 910, top: 1910 }
    );
    expect(placementCheck(overlapping).ok).toBe(false);
    expect(placementCheck(overlapping).value).toContain('重なっています');

    // 壁からはみ出す配置も同じく拾う。
    const overhanging = wallWith({
      panelName: '下段',
      left: 0,
      bottom: 0,
      right: 1820,
      top: 1820,
    });
    expect(placementCheck(overhanging).ok).toBe(false);
    expect(placementCheck(overhanging).value).toContain('はみ出しています');
  });

  it('1 枚の壁でも、面材ごとに違う面材と釘を使える', async () => {
    const loaded = await core();
    const spec = (id) => {
      const material = loaded.materials().find((entry) => entry.id === id);
      return {
        thickness: material.thickness,
        shearModulus: material.shearModulus,
        k: material.k,
        deltaV: material.deltaV,
        deltaU: material.deltaU,
        deltaPv: material.deltaPv,
        tauMax: material.tauMax,
        e1: material.e1,
        e2: material.e2,
      };
    };
    const placed = [
      { panelName: '下段', left: 0, bottom: 0, right: 910, top: 1820 },
      { panelName: '上段', left: 0, bottom: 1820, right: 910, top: 2730 },
    ].map((panel) => ({ ...panel, nailPitch: 75, edgeDistance: 10 }));
    const wallOfSpecs = (lower, upper) => ({
      walls: [
        {
          wallId: 'w1',
          height: 3000,
          width: 910,
          studPitch: 455,
          panels: [
            { ...placed[0], ...spec(lower) },
            { ...placed[1], ...spec(upper) },
          ],
        },
      ],
    });

    const mixed = loaded.computeAll(wallOfSpecs('plywood12-n50', 'plywood12-cn50'));
    const allN50 = loaded.computeAll(wallOfSpecs('plywood12-n50', 'plywood12-n50'));
    const allCn50 = loaded.computeAll(wallOfSpecs('plywood12-cn50', 'plywood12-cn50'));

    expect(mixed.walls[0].ok).toBe(true);
    // 面材ごとの値は、その面材の仕様だけで決まる（隣の面材に引きずられない）。
    const my = (reports, index) => reports.walls[0].panels[index].cells[5];
    expect(my(mixed, 0)).toBe(my(allN50, 0));
    expect(my(mixed, 1)).toBe(my(allCn50, 1));
    expect(my(allN50, 1)).not.toBe(my(allCn50, 1));
    // 面材ごとの ΔPv が、そのまま面材ごとの表に並ぶ。
    expect(mixed.walls[0].specs.map((entry) => entry.cells[5])).toEqual(['0.91', '0.94']);
  });

  it('計算できない壁は、理由を添えて ok: false で返る', async () => {
    const { walls } = (await core()).computeAll({
      walls: [{ wallId: 'w1', height: 3000, width: 910, panels: [] }],
    });

    expect(walls[0].ok).toBe(false);
    expect(walls[0].error).toContain('面材がありません');
  });

  it('知らない釘配列を呼ぶと、日本語の文面で投げる', async () => {
    const loaded = await core();

    expect(() => loaded.preset('なにか')).toThrow(/知らない釘配列です/);
  });

  it('計算できない面材は、理由を添えて ok: false で返る', async () => {
    // 領域が矩形になっていない（配置が入っていない）面材。
    const { walls } = (await core()).computeAll(
      wallOf({ ...EXAMPLE_PANEL, right: 0, top: 0 })
    );

    expect(panelReport(walls).ok).toBe(false);
    expect(panelReport(walls).error).toContain('壁の中で面材が占める領域');
  });

  it('入力全体が壊れていれば、日本語の文面で投げる', async () => {
    const loaded = await core();

    expect(() => loaded.computeAll(wallOf({ right: 'ろく' }))).toThrow(/面材の右端 X/);
  });

  it('何度呼んでも結果が変わらない（メモリの受け渡しが漏れない）', async () => {
    const loaded = await core();
    const first = loaded.computeAll(wallOf(EXAMPLE_PANEL));

    for (let round = 0; round < 30; round += 1) {
      expect(loaded.computeAll(wallOf(EXAMPLE_PANEL))).toEqual(first);
    }
  });

  it('メモリが広がる大きさの入力でも壊れない', async () => {
    // 3640 × 2730 の壁いっぱいに、間柱 @455・釘 @75 で 1 枚張る。
    const { walls } = (await core()).computeAll({
      walls: [
        {
          wallId: 'w1',
          width: 3640,
          height: 2730,
          studPitch: 455,
          panels: [
            { ...EXAMPLE_PANEL, right: 3640, top: 2730, nailPitch: 75 },
          ],
        },
      ],
    });

    // 縦線 9 本 × 37 本 ＋ 横線 2 本 × 49 本 − 重なり。
    expect(panelReport(walls).nails.length).toBeGreaterThan(400);
    expect(panelReport(walls).result.Ixy).toBeGreaterThan(0);
  });
});

describe('loadCore', () => {
  it('受け取ったバイト列から組み立てる', async () => {
    const fetched = [];
    const loaded = await loadCore('/core.wasm?v=abc', async (url) => {
      fetched.push(url);
      return wasmBytes();
    });

    expect(fetched).toEqual(['/core.wasm?v=abc']);
    expect(loaded.version).toBeTruthy();
  });

  it('受け取れなければ、何が起きたか分かる文面で投げる', async () => {
    await expect(
      loadCore('/core.wasm', async () => {
        throw new Error('サーバーエラーが発生しました (HTTP 503)。');
      })
    ).rejects.toThrow(/計算エンジンを読み込めませんでした.*HTTP 503/);
  });
});
