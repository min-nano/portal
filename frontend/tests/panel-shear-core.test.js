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
} from '../src/timber-panel-shear-calculator/core.js';

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

// グレー本 3.2【解説】の計算例（図 3.2.2）。W 910 × H 610 の横置きで、
// へりあき 10 mm を見込んだ配列（本は左下の釘を (0, 0) として書いている）。
//
// 釘配列諸定数は壁を構成する面材ごとの計算なので、壁 1 枚の中に置いて呼ぶ。
const EXAMPLE_PANEL = {
  panelId: 'pn1',
  panelName: 'グレー本の計算例',
  width: 910,
  height: 610,
  mode: 'layout',
  arrangement: 'kawa',
  studPitch: 455,
  nailPitch: 150,
  edgeDistance: 10,
};

/** 面材を並べただけの壁（面材と釘の数値は入れない）。 */
function wallOf(...panels) {
  return { walls: [{ wallId: 'w1', panels }] };
}

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

  it('グレー本の計算例を、計算書と同じ桁で返す', async () => {
    const { walls } = (await core()).computeAll(wallOf(EXAMPLE_PANEL));
    const report = panelReport(walls);

    expect(report.ok).toBe(true);
    expect(Object.fromEntries(report.summary.map((s) => [s.key, s.value]))).toEqual({
      Ixy: '0.888868',
      Zxy: '0.00358851',
      Cxy: '1.26155',
    });
    expect(report.nails).toHaveLength(15);
    expect(report.result.x0).toBe(455);
    expect(report.result.y0).toBe(305);
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

  it('釘配列図の範囲と目盛も返す（計算書 PDF と同じもの）', async () => {
    const report = panelReport((await core()).computeAll(wallOf(EXAMPLE_PANEL)).walls);

    expect(report.diagram.panelWidth).toBe(910);
    expect(report.diagram.maxX).toBe(910);
    expect(report.diagram.xTicks.map((t) => t.label)).toEqual(['10', '455', '900']);
    expect(report.diagram.axis.xLabel).toBe('x0 = 455.0');
  });

  it('グレー本 表 3.2.1 の釘配列を一覧して、そのまま割り付けへ読み込める', async () => {
    const loaded = await core();
    const presets = loaded.presets();

    expect(presets).toHaveLength(106);
    const kawa = presets.find((p) => p.id === '910x610-s455-n150-kawa');
    expect(kawa.label).toBe('910×610 横置・川型（間柱・根太 @455 / 釘 @150）');

    // 表 3.2.1 の「910×610 横置・川型」は、解説の計算例そのもの。
    const panel = loaded.preset(kawa.id);
    expect(panel).toMatchObject({
      width: 910,
      height: 610,
      mode: 'layout',
      arrangement: 'kawa',
      studPitch: 455,
      nailPitch: 150,
      edgeDistance: 10,
    });

    const report = panelReport(loaded.computeAll(wallOf(panel)).walls);
    expect(Object.fromEntries(report.summary.map((s) => [s.key, s.value]))).toEqual({
      Ixy: '0.888868',
      Zxy: '0.00358851',
      Cxy: '1.26155',
    });
  });

  it('割り付けの型（川型・山型・ロ型・日型）を一覧する', async () => {
    const arrangements = (await core()).arrangements();

    expect(arrangements.map((a) => a.id)).toEqual(['kawa', 'yama', 'ro', 'hi']);
    expect(arrangements[3].label).toBe('日型');
    expect(arrangements[3].note).toContain('上下端');
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

  it('グレー本 3.3 の計算例（図 3.3.10）を、本と同じ答えで返す', async () => {
    // 面材は表 3.2.1 の配列をそのまま壁の中へ置く。釘 1 本あたりの数値は、
    // 本文が計算に使っているものをそのまま入れる。
    const loaded = await core();
    const panels = ['910x1820-s455-n75-hi', '910x910-s455-n75-ro'].map((id) =>
      loaded.preset(id)
    );

    const { walls } = loaded.computeAll({
      walls: [
        {
          wallId: 'w1',
          wallName: 'グレー本 3.3 の計算例',
          height: 3000,
          width: 910,
          thickness: 12,
          shearModulus: 0.4,
          k: 0.483,
          deltaV: 2.3,
          deltaU: 17,
          deltaPv: 1.13,
          tauMax: 3.6,
          e1: 3500,
          e2: 5500,
          hasIntermediateStud: true,
          panels,
        },
      ],
    });

    expect(walls[0].ok).toBe(true);
    // 本の答えは Pa = 8.37 kN、ΔPa = 9.20 kN/m（決めているのは K0/150）。
    expect(walls[0].governing).toBe('drift');
    expect(walls[0].result.Pa).toBeCloseTo(8.37, 1);
    expect(walls[0].result.dPa).toBeCloseTo(9.2, 1);
    expect(walls[0].withinLimit).toBe(true);
    expect(walls[0].panels.map((panel) => panel.label)).toEqual([
      '1820×910 縦置・日型（間柱・根太 @455 / 釘 @75）',
      '910×910 縦置・ロ型（間柱・根太 @455 / 釘 @75）',
    ]);
    // 壁の計算には、その根拠になる面材ごとの釘配列諸定数が付いてくる。
    expect(walls[0].panelReports).toHaveLength(2);
    expect(walls[0].panelReports[0].result.Ixy).toBeCloseTo(4.99, 1);
    // 面材のせん断破壊・せん断座屈（式 3.3.8〜3.3.11）も、どちらも通る。
    expect(walls[0].shearOk).toBe(true);
    expect(walls[0].bucklingOk).toBe(true);
    expect(walls[0].buckling.every((panel) => panel.ok)).toBe(true);
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
    const { walls } = (await core()).computeAll(
      wallOf({ ...EXAMPLE_PANEL, mode: 'coords', coords: '' })
    );

    expect(panelReport(walls).ok).toBe(false);
    expect(panelReport(walls).error).toContain('釘座標が入力されていません');
  });

  it('入力全体が壊れていれば、日本語の文面で投げる', async () => {
    const loaded = await core();

    expect(() => loaded.computeAll(wallOf({ width: 'ろく' }))).toThrow(/面材の幅 W/);
  });

  it('何度呼んでも結果が変わらない（メモリの受け渡しが漏れない）', async () => {
    const loaded = await core();
    const first = loaded.computeAll(wallOf(EXAMPLE_PANEL));

    for (let round = 0; round < 30; round += 1) {
      expect(loaded.computeAll(wallOf(EXAMPLE_PANEL))).toEqual(first);
    }
  });

  it('メモリが広がる大きさの入力でも壊れない', async () => {
    const axis = Array.from({ length: 40 }, (_, index) => index * 10).join(', ');

    const { walls } = (await core()).computeAll(
      wallOf({ ...EXAMPLE_PANEL, mode: 'grid', gridX: axis, gridY: axis })
    );

    expect(panelReport(walls).nails).toHaveLength(1600);
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
