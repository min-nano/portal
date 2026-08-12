import { describe, expect, it } from 'vitest';
import {
  canRemovePattern,
  defaultSaveName,
  emptyFormData,
  formSignature,
  indexAfterRemoval,
  makePattern,
  mergeFormData,
  patternLabel,
  suggestedFileName,
  toRequestBody,
  verificationOf,
  verificationWarning,
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
  it('サーバへ渡すのは物件情報とパターンだけ', () => {
    const data = { ...emptyFormData(), extra: 'x' };

    expect(Object.keys(toRequestBody(data)).sort()).toEqual([
      'issuedOn',
      'patterns',
      'projectName',
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
  const reports = [
    { ok: true, patternId: 'p1', result: { Cxy: 1.26155 } },
    { ok: false, patternId: 'p2', error: '釘座標が入力されていません。' },
  ];

  it('計算できたパターンの結果だけを添える', () => {
    expect(verificationOf('1.0.0', reports)).toEqual({
      coreVersion: '1.0.0',
      patterns: [{ patternId: 'p1', result: { Cxy: 1.26155 } }],
    });
  });

  it('食い違いが無ければ警告を出さない', () => {
    expect(verificationWarning({ checked: true, ok: true })).toBe('');
    // 突き合わせていない（材料を送っていない）ときも黙っている。
    expect(verificationWarning({ checked: false, ok: true })).toBe('');
    expect(verificationWarning(null)).toBe('');
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
