import { describe, expect, it } from 'vitest';
import {
  canRemovePattern,
  canRemoveWall,
  defaultSaveName,
  emptyFormData,
  formSignature,
  indexAfterRemoval,
  makePattern,
  makeWall,
  mergeFormData,
  panelChoices,
  patternLabel,
  suggestedFileName,
  toRequestBody,
  verificationOf,
  verificationWarning,
  wallFieldsFromMaterial,
  wallLabel,
} from '../src/timber-panel-shear-calculator/form-logic.js';

// バックエンドの /config が配る内容の縮小版。
const config = {
  default_file_name: '釘配列諸定数計算書.pdf',
  file_name_template: '釘配列諸定数計算書_{projectName}.pdf',
};

describe('emptyFormData / makePattern', () => {
  it('新規作成はパターン 1 つから始まる', () => {
    const data = emptyFormData();

    expect(data.projectName).toBe('');
    expect(data.patterns).toHaveLength(1);
    expect(data.patterns[0].mode).toBe('grid');
    // 作成日は当日を入れておく（PDF に刷られる）。
    expect(data.issuedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('パターン ID は重複しない（PDF に埋め込まれ、読み込み後も使う）', () => {
    const ids = new Set([makePattern().patternId, makePattern().patternId]);

    expect(ids.size).toBe(2);
  });
});

describe('mergeFormData', () => {
  it('読み込んだ PDF の内容を画面の形に整える', () => {
    const data = mergeFormData({
      projectName: '○○邸',
      issuedOn: '2026-08-11',
      patterns: [
        {
          patternId: 'p1',
          patternName: '南面',
          width: 610,
          height: 910,
          mode: 'coords',
          coords: '0, 0',
        },
      ],
    });

    expect(data.projectName).toBe('○○邸');
    expect(data.issuedOn).toBe('2026-08-11');
    expect(data.patterns[0]).toMatchObject({
      patternId: 'p1',
      patternName: '南面',
      width: 610,
      height: 910,
      mode: 'coords',
      coords: '0, 0',
      gridX: '',
    });
  });

  it('パターンが無い内容でも、編集を始められる形にする', () => {
    const data = mergeFormData({ projectName: '邸' });

    expect(data.patterns).toHaveLength(1);
    expect(data.issuedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('知らない入力方式は格子として扱う', () => {
    const data = mergeFormData({ patterns: [{ mode: 'なにか' }] });

    expect(data.patterns[0].mode).toBe('grid');
  });

  it('パターン名が空なら通し番号で補う', () => {
    const data = mergeFormData({ patterns: [{}, {}] });

    expect(data.patterns.map((p) => p.patternName)).toEqual([
      'パターン1',
      'パターン2',
    ]);
  });
});

describe('formSignature', () => {
  it('送信する内容だけを見る（未保存の変更の判定）', () => {
    const data = emptyFormData();
    const before = formSignature(data);

    data.patterns[0].gridX = '0, 445';

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
  it('サーバへ渡すのは物件情報とパターン・壁だけ', () => {
    const data = { ...emptyFormData(), extra: 'x' };

    expect(Object.keys(toRequestBody(data)).sort()).toEqual([
      'issuedOn',
      'patterns',
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

describe('パターンの増減', () => {
  it('最後の 1 つは削除できない（0 個の物件を作らせない）', () => {
    expect(canRemovePattern({ patterns: [{}] })).toBe(false);
    expect(canRemovePattern({ patterns: [{}, {}] })).toBe(true);
  });

  it('末尾を消したら 1 つ前のパターンへ寄せる', () => {
    expect(indexAfterRemoval(2, 2)).toBe(1);
    expect(indexAfterRemoval(0, 2)).toBe(0);
    expect(indexAfterRemoval(0, 1)).toBe(0);
  });

  it('タブの名前は未入力なら通し番号で代替する', () => {
    expect(patternLabel({ patternName: '南面' }, 0)).toBe('南面');
    expect(patternLabel({ patternName: '  ' }, 2)).toBe('パターン3');
  });
});

describe('保存時の突き合わせ', () => {
  const reports = {
    patterns: [
      { ok: true, patternId: 'p1', result: { Cxy: 1.26155 } },
      { ok: false, patternId: 'p2', error: '釘座標が入力されていません。' },
    ],
    walls: [
      { ok: true, wallId: 'w1', result: { Pa: 8.38761 } },
      { ok: false, wallId: 'w2', error: '面材がありません。' },
    ],
  };

  it('計算できたパターン・壁の結果だけを添える', () => {
    expect(verificationOf('1.0.0', reports)).toEqual({
      coreVersion: '1.0.0',
      patterns: [{ patternId: 'p1', result: { Cxy: 1.26155 } }],
      walls: [{ wallId: 'w1', result: { Pa: 8.38761 } }],
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

  it('違った値を、どのパターンのどの項目か分かる形で並べる', () => {
    const warning = verificationWarning({
      checked: true,
      ok: false,
      coreVersion: { client: '1.0.0', server: '1.0.0' },
      differences: [
        { patternName: '南面', key: 'Cxy', client: 1.25, server: 1.26155 },
      ],
      omittedDifferences: 3,
    });

    expect(warning).toContain('南面 の Cxy（画面 1.25 / 計算書 1.26155）');
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

describe('壁（グレー本 3.3）', () => {
  it('新規作成は壁 0 枚から始まる（釘配列諸定数だけの使い方を残す）', () => {
    expect(emptyFormData().walls).toEqual([]);
  });

  it('面材と釘の数値は空から始める（確かめないまま計算させない）', () => {
    const wall = makeWall();

    expect(wall.panels).toEqual([]);
    expect([wall.k, wall.deltaV, wall.deltaU, wall.deltaPv]).toEqual(['', '', '', '']);
    // 階高と壁の幅だけは、よくある寸法を入れておく。
    expect(wall.height).toBeGreaterThan(0);
    expect(wall.width).toBeGreaterThan(0);
  });

  it('壁 ID は重複しない（PDF に埋め込まれ、読み込み後も使う）', () => {
    expect(new Set([makeWall().wallId, makeWall().wallId]).size).toBe(2);
  });

  it('表 3.3.1 の 1 行は、そのまま入力欄の値になる', () => {
    const material = {
      id: 'plywood12-n50',
      label: '構造用合板 12mm + 鉄丸釘 N-50',
      panel: '構造用合板',
      thickness: 12,
      shearModulus: 0.4,
      k: 0.43,
      deltaV: 2.1,
      deltaU: 17.1,
      deltaPv: 0.91,
    };

    expect(wallFieldsFromMaterial(material)).toEqual({
      materialId: 'plywood12-n50',
      thickness: 12,
      shearModulus: 0.4,
      k: 0.43,
      deltaV: 2.1,
      deltaU: 17.1,
      deltaPv: 0.91,
    });
  });

  it('面材の選択肢は、そのときの釘配列パターンの並びそのもの', () => {
    const data = {
      patterns: [
        { patternId: 'p1', patternName: '南面' },
        { patternId: 'p2', patternName: '  ' },
      ],
    };

    expect(panelChoices(data)).toEqual([
      { patternId: 'p1', label: '南面' },
      { patternId: 'p2', label: 'パターン2' },
    ]);
  });

  it('壁は 0 枚でもよいので、1 枚だけでも削除できる', () => {
    expect(canRemoveWall({ walls: [] })).toBe(false);
    expect(canRemoveWall({ walls: [{}] })).toBe(true);
  });

  it('タブの名前は未入力なら通し番号で代替する', () => {
    expect(wallLabel({ wallName: '南面' }, 0)).toBe('南面');
    expect(wallLabel({ wallName: '  ' }, 2)).toBe('壁3');
  });
});

describe('mergeFormData（壁）', () => {
  it('保存した壁を、定義に無いキーを捨てて読み戻す', () => {
    const data = mergeFormData({
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
          panels: [{ patternId: 'p1' }, { patternId: '' }, {}],
          junk: 1,
        },
      ],
    });

    expect(data.walls).toHaveLength(1);
    expect(data.walls[0].junk).toBeUndefined();
    expect(data.walls[0].height).toBe(3000);
    // 未選択の面材の行は落とす。
    expect(data.walls[0].panels).toEqual([{ patternId: 'p1' }]);
  });

  it('壁を持たない（この節より前に保存した）PDF も読める', () => {
    expect(mergeFormData({ patterns: [] }).walls).toEqual([]);
  });

  it('壁の名前が空なら通し番号で埋める', () => {
    expect(mergeFormData({ walls: [{}, {}] }).walls.map((w) => w.wallName)).toEqual([
      '壁1',
      '壁2',
    ]);
  });
});
