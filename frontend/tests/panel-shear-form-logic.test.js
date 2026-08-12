import { describe, expect, it } from 'vitest';
import {
  canRemoveWall,
  defaultSaveName,
  emptyFormData,
  formSignature,
  indexAfterRemoval,
  makePanel,
  makeWall,
  mergeFormData,
  nailNote,
  panelLabel,
  suggestedFileName,
  toRequestBody,
  verificationOf,
  verificationWarning,
  wallFieldsFromGrade,
  wallFieldsFromMaterial,
  wallLabel,
} from '../src/timber-panel-shear-calculator/form-logic.js';

// バックエンドの /config が配る内容の縮小版。
const config = {
  default_file_name: '釘配列諸定数計算書.pdf',
  file_name_template: '釘配列諸定数計算書_{projectName}.pdf',
};

describe('emptyFormData / makeWall / makePanel', () => {
  it('新規作成は壁 1 枚・面材 1 枚から始まる', () => {
    const data = emptyFormData();

    expect(data.projectName).toBe('');
    expect(data.walls).toHaveLength(1);
    expect(data.walls[0].panels).toHaveLength(1);
    // 作成日は当日を入れておく（PDF に刷られる）。
    expect(data.issuedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('面材の既定は割り付け・日型（適用範囲 3.3(1)⑤ の四周打ち）', () => {
    const panel = makePanel();

    expect(panel.mode).toBe('layout');
    expect(panel.arrangement).toBe('hi');
    // へりあきは面材ごとに調整できる（既定は表 3.2.1 が前提とする 10 mm）。
    expect(panel.edgeDistance).toBe(10);
    expect(panel.nailPitch).toBeGreaterThan(0);
    expect(panel.studPitch).toBeGreaterThan(0);
  });

  it('面材と釘の数値は空から始める（確かめないまま計算させない）', () => {
    const wall = makeWall();

    expect([wall.k, wall.deltaV, wall.deltaU, wall.deltaPv]).toEqual(['', '', '', '']);
    expect([wall.tauMax, wall.e1, wall.e2]).toEqual(['', '', '']);
    // 適用範囲 3.3(1)⑦ は中間材（間柱等）を求めているので、既定は「あり」。
    expect(wall.hasIntermediateStud).toBe(true);
    // 階高と壁の幅だけは、よくある寸法を入れておく。
    expect(wall.height).toBeGreaterThan(0);
    expect(wall.width).toBeGreaterThan(0);
  });

  it('壁 ID・面材 ID は重複しない（PDF に埋め込まれ、読み込み後も使う）', () => {
    expect(new Set([makeWall().wallId, makeWall().wallId]).size).toBe(2);
    expect(new Set([makePanel().panelId, makePanel().panelId]).size).toBe(2);
  });
});

describe('mergeFormData', () => {
  it('読み込んだ PDF の内容を画面の形に整える', () => {
    const data = mergeFormData({
      projectName: '○○邸',
      issuedOn: '2026-08-11',
      walls: [
        {
          wallId: 'w1',
          wallName: '南面',
          height: '3000',
          width: 910,
          materialId: 'plywood12-n50',
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
          hasIntermediateStud: false,
          junk: 1,
          panels: [
            {
              panelId: 'pn1',
              panelName: '下段',
              width: 910,
              height: 1820,
              mode: 'layout',
              arrangement: 'hi',
              studPitch: 455,
              nailPitch: 75,
              edgeDistance: 15,
              grain: 'width',
              junk: 2,
            },
          ],
        },
      ],
    });

    expect(data.projectName).toBe('○○邸');
    expect(data.issuedOn).toBe('2026-08-11');
    expect(data.walls[0].junk).toBeUndefined();
    expect(data.walls[0].height).toBe(3000);
    expect(data.walls[0].hasIntermediateStud).toBe(false);
    expect(data.walls[0].panels[0]).toMatchObject({
      panelId: 'pn1',
      panelName: '下段',
      width: 910,
      height: 1820,
      mode: 'layout',
      arrangement: 'hi',
      nailPitch: 75,
      edgeDistance: 15,
      grain: 'width',
    });
    expect(data.walls[0].panels[0].junk).toBeUndefined();
  });

  it('壁が無い内容でも、編集を始められる形にする', () => {
    const data = mergeFormData({ projectName: '邸' });

    expect(data.walls).toHaveLength(1);
    expect(data.issuedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('知らない入力方式は割り付けとして扱う', () => {
    const data = mergeFormData({ walls: [{ panels: [{ mode: 'なにか' }] }] });

    expect(data.walls[0].panels[0].mode).toBe('layout');
  });

  it('名前が空なら通し番号で補う', () => {
    const data = mergeFormData({ walls: [{ panels: [{}, {}] }, {}] });

    expect(data.walls.map((w) => w.wallName)).toEqual(['壁1', '壁2']);
    expect(data.walls[0].panels.map((p) => p.panelName)).toEqual(['面材1', '面材2']);
  });

  it('面材を 1 枚も持たない壁は、そのまま 0 枚で読む', () => {
    expect(mergeFormData({ walls: [{ panels: [] }] }).walls[0].panels).toEqual([]);
  });
});

describe('formSignature', () => {
  it('送信する内容だけを見る（未保存の変更の判定）', () => {
    const data = emptyFormData();
    const before = formSignature(data);

    data.walls[0].panels[0].nailPitch = 75;

    expect(formSignature(data)).not.toBe(before);
  });

  it('送らない値の違いは未保存の変更にしない', () => {
    const data = emptyFormData();
    const before = formSignature(data);

    data.somethingElse = true;

    expect(formSignature(data)).toBe(before);
  });
});

describe('toRequestBody', () => {
  it('サーバへ渡すのは物件情報と壁だけ', () => {
    const data = { ...emptyFormData(), extra: 'x' };

    expect(Object.keys(toRequestBody(data)).sort()).toEqual([
      'issuedOn',
      'projectName',
      'walls',
    ]);
  });
});

describe('ファイル名', () => {
  it('物件名から既定のファイル名を組み立てる', () => {
    const data = { ...emptyFormData(), projectName: '○○邸 新築工事' };

    expect(suggestedFileName(config.file_name_template, data, config.default_file_name))
      .toBe('釘配列諸定数計算書_○○邸 新築工事.pdf');
  });

  it('物件名が空なら既定のファイル名を使う', () => {
    const data = emptyFormData();

    expect(suggestedFileName(config.file_name_template, data, config.default_file_name))
      .toBe('釘配列諸定数計算書.pdf');
  });

  it('ファイル名に使えない文字は落とす', () => {
    const data = { ...emptyFormData(), projectName: 'a/b:c' };

    expect(suggestedFileName(config.file_name_template, data, 'x.pdf')).toBe(
      '釘配列諸定数計算書_abc.pdf'
    );
  });

  it('開いているファイルの名前が保存ダイアログの初期値になる', () => {
    const data = { ...emptyFormData(), projectName: '○○邸' };

    expect(defaultSaveName(config, data, '前の計算書.pdf')).toBe('前の計算書.pdf');
    expect(defaultSaveName(config, data, '')).toBe('釘配列諸定数計算書_○○邸.pdf');
  });
});

describe('壁と面材の増減', () => {
  it('最後の 1 枚は削除できない（0 枚の物件を作らせない）', () => {
    expect(canRemoveWall({ walls: [{}] })).toBe(false);
    expect(canRemoveWall({ walls: [{}, {}] })).toBe(true);
  });

  it('末尾を消したら 1 つ前の壁へ寄せる', () => {
    expect(indexAfterRemoval(2, 2)).toBe(1);
    expect(indexAfterRemoval(0, 2)).toBe(0);
    expect(indexAfterRemoval(0, 1)).toBe(0);
  });

  it('見出しの名前は未入力なら通し番号で代替する', () => {
    expect(wallLabel({ wallName: '南面' }, 0)).toBe('南面');
    expect(wallLabel({ wallName: '  ' }, 2)).toBe('壁3');
    expect(panelLabel({ panelName: '下段' }, 0)).toBe('下段');
    expect(panelLabel({ panelName: '' }, 1)).toBe('面材2');
  });
});

describe('面材と釘の一覧（グレー本 表 3.3.1 / 表 3.3.2）', () => {
  const material = {
    id: 'plywood12-n50',
    label: '構造用合板 12mm + 鉄丸釘 N-50',
    panel: '構造用合板',
    nailLabel: '鉄丸釘 N-50',
    nailDiameter: 2.75,
    thickness: 12,
    shearModulus: 0.4,
    k: 0.43,
    deltaV: 2.1,
    deltaU: 17.1,
    deltaPv: 0.91,
    gradeId: 'plywood-jas1',
    tauMax: 3.6,
    e1: 3500,
    e2: 5500,
  };

  it('表 3.3.1 の 1 行は、規格（表 3.3.2）ごと入力欄の値になる', () => {
    // 1 回の選択で、せん断破壊・せん断座屈の検定に要る数値までそろう。
    expect(wallFieldsFromMaterial(material)).toEqual({
      materialId: 'plywood12-n50',
      thickness: 12,
      shearModulus: 0.4,
      k: 0.43,
      deltaV: 2.1,
      deltaU: 17.1,
      deltaPv: 0.91,
      gradeId: 'plywood-jas1',
      tauMax: 3.6,
      e1: 3500,
      e2: 5500,
    });
  });

  it('表 3.3.2 の 1 行（面材の規格）だけを差し替えられる', () => {
    const grade = {
      id: 'plywood-jas2',
      label: '構造用合板 JAS 2 級',
      tauMax: 2.4,
      e1: 3500,
      e2: 5500,
    };

    expect(wallFieldsFromGrade(grade)).toEqual({
      gradeId: 'plywood-jas2',
      tauMax: 2.4,
      e1: 3500,
      e2: 5500,
    });
  });

  it('へりあきを決める手がかりとして、選んだ釘の呼び径を案内する', () => {
    const note = nailNote([material], 'plywood12-n50');

    expect(note).toContain('鉄丸釘 N-50');
    expect(note).toContain('φ2.75 mm');
    expect(note).toContain('へりあき');
    // まだ選んでいないときは案内を出さない。
    expect(nailNote([material], '')).toBe('');
  });
});

describe('保存時の突き合わせ', () => {
  const reports = {
    walls: [
      {
        ok: true,
        wallId: 'w1',
        result: { Pa: 8.38761 },
        panelReports: [
          { ok: true, panelId: 'pn1', result: { Cxy: 1.26155 } },
          { ok: false, panelId: 'pn2', error: '釘座標が入力されていません。' },
        ],
      },
      { ok: false, wallId: 'w2', error: '面材がありません。', panelReports: [] },
    ],
  };

  it('計算できた壁・面材の結果だけを添える', () => {
    expect(verificationOf('1.0.0', reports)).toEqual({
      coreVersion: '1.0.0',
      walls: [{ wallId: 'w1', result: { Pa: 8.38761 } }],
      panels: [{ panelId: 'pn1', result: { Cxy: 1.26155 } }],
    });
  });

  it('食い違いが無ければ警告を出さない', () => {
    expect(verificationWarning({ checked: true, ok: true })).toBe('');
    // 突き合わせていない（材料を送っていない）ときも黙っている。
    expect(verificationWarning({ checked: false, ok: true })).toBe('');
    expect(verificationWarning(null)).toBe('');
  });

  it('壁の違いは、壁の名前で並べる', () => {
    const warning = verificationWarning({
      checked: true,
      ok: false,
      coreVersion: { client: '1.0.0', server: '1.0.0' },
      differences: [{ wallId: 'w1', wallName: '南面', key: 'Pa', client: 1, server: 2 }],
    });

    expect(warning).toContain('南面 の Pa');
  });

  it('違った値を、どの面材のどの項目か分かる形で並べる', () => {
    const warning = verificationWarning({
      checked: true,
      ok: false,
      coreVersion: { client: '1.0.0', server: '1.0.0' },
      differences: [{ panelName: '下段', key: 'Cxy', client: 1.25, server: 1.26155 }],
      omittedDifferences: 3,
    });

    expect(warning).toContain('下段 の Cxy（画面 1.25 / 計算書 1.26155）');
    expect(warning).toContain('ほか 3 件');
    expect(warning).toContain('サーバーで計算し直した値');
  });

  it('計算エンジンの版が違うときは、再読み込みを促す', () => {
    const warning = verificationWarning({
      checked: true,
      ok: false,
      coreVersion: { client: '0.9.0', server: '1.0.0' },
      differences: [],
    });

    expect(warning).toContain('0.9.0');
    expect(warning).toContain('再読み込み');
  });
});
