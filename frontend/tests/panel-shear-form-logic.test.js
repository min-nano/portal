import { describe, expect, it } from 'vitest';
import {
  canRemoveWall,
  capturePanel,
  defaultSaveName,
  emptyFormData,
  formSignature,
  indexAfterRemoval,
  defaultFrame,
  fitEnds,
  makeFrame,
  makeMember,
  makePanel,
  makeWall,
  mergeFormData,
  nextPlacement,
  minimumEdgeDistance,
  nailNote,
  raiseEdgeDistance,
  panelLabel,
  suggestedFileName,
  toRequestBody,
  verificationOf,
  verificationWarning,
  panelFieldsFromGrade,
  panelFieldsFromMaterial,
  specOf,
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

  it('面材の既定は、壁の左下に置いた 3×6 板 1 枚', () => {
    const panel = makePanel();

    expect(panel.side).toBe('front');
    expect([panel.left, panel.bottom]).toEqual([0, 0]);
    expect(panel.right - panel.left).toBe(910);
    expect(panel.top - panel.bottom).toBe(1820);
    // へりあきは面材ごとに調整できる（既定は表 3.2.1 が前提とする 10 mm）。
    expect(panel.edgeDistance).toBe(10);
    expect(panel.nailPitch).toBeGreaterThan(0);
    // 寸法も配列の型も、面材の入力欄には無い（配置と壁の軸組から決まる）。
    expect(panel.width).toBeUndefined();
    expect(panel.arrangement).toBeUndefined();
    expect(panel.studPitch).toBeUndefined();
  });

  it('面材と釘の数値は面材ごとに、空から始める（確かめないまま計算させない）', () => {
    const panel = makePanel();

    expect([panel.k, panel.deltaV, panel.deltaU, panel.deltaPv]).toEqual(['', '', '', '']);
    expect([panel.tauMax, panel.e1, panel.e2]).toEqual(['', '', '']);
    expect([panel.materialId, panel.gradeId]).toEqual(['', '']);
  });

  it('壁が持つのは軸組（階高・幅・軸組材）だけ（面材と釘は面材ごと）', () => {
    const wall = makeWall();

    // 階高・壁の幅は、よくある寸法を入れておく。
    expect(wall.height).toBeGreaterThan(0);
    expect(wall.width).toBeGreaterThan(0);
    // 間柱ピッチは入力ではなくなった（軸組材を等間隔に入れる入り口だけ）。
    expect(wall.studPitch).toBeUndefined();
    // 軸組材は 1 本ずつ持つ（両端の柱・@455 の間柱・上下の横架材）。
    expect(wall.frame.map((member) => [member.label, member.position])).toEqual([
      ['柱', 0],
      ['間柱', 455],
      ['柱', 910],
      ['横架材', 0],
      ['横架材', 2900],
    ]);
    // 中間材の有無は入力しない（間柱ピッチと壁の幅から決まる）。
    expect(wall.hasIntermediateStud).toBeUndefined();
    expect(wall.materialId).toBeUndefined();
    expect(wall.thickness).toBeUndefined();
  });

  it('軸組材は 1 本ずつ自由な位置に入れる（既定は種別に合わせて埋める）', () => {
    expect(makeMember({ kind: 'column', position: 0 })).toEqual({
      kind: 'column',
      direction: 'vertical',
      label: '柱',
      position: 0,
      width: 105,
    });
    // 種別を書かなければ間柱（図の勝ち負けでいちばん弱い側）。
    expect(makeMember({ position: 600 })).toEqual({
      kind: 'stud',
      direction: 'vertical',
      label: '間柱',
      position: 600,
      width: 45,
    });
    // 向きは種別のふつうの向き。名前は自由に付けられる。
    expect(makeMember({ kind: 'beam', label: 'まぐさ', position: 2000 })).toEqual({
      kind: 'beam',
      direction: 'horizontal',
      label: 'まぐさ',
      position: 2000,
      width: 105,
    });
    // 継目の材は縦にも横にも入るので、向きを書けばそちらが優先される。
    expect(makeMember({ kind: 'joint', direction: 'horizontal', position: 1820 })).toEqual({
      kind: 'joint',
      direction: 'horizontal',
      label: '継目の材',
      position: 1820,
      width: 105,
    });
  });

  it('材端の既定は、直交する材の外面まで（横架材は柱の外面まで伸びる）', () => {
    const frame = fitEnds(
      [
        makeMember({ kind: 'column', position: 0 }),
        makeMember({ kind: 'column', position: 910 }),
        makeMember({ kind: 'beam', position: 0 }),
        // 材端を入れた材は、その長さのまま（開口の幅だけのまぐさ）。
        makeMember({ kind: 'beam', label: 'まぐさ', position: 2000, from: 300, to: 700 }),
      ],
      { width: 910, height: 2900 }
    );

    // 横架材は両端の柱（見付け 105）の外面まで。
    expect([frame[2].from, frame[2].to]).toEqual([-52.5, 962.5]);
    // 柱は下の横架材の外面から壁の上端まで（この軸組には上の横架材が無い）。
    expect([frame[0].from, frame[0].to]).toEqual([-52.5, 2900]);
    expect([frame[3].from, frame[3].to]).toEqual([300, 700]);
  });

  it('等間隔の軸組は、両端の柱・間柱・上下の横架材でできる', () => {
    const frame = defaultFrame(1820, 2900, 455);

    expect(frame.filter((member) => member.direction === 'vertical').map((m) => m.position))
      .toEqual([0, 455, 910, 1365, 1820]);
    expect(frame.filter((member) => member.direction === 'horizontal').map((m) => m.position))
      .toEqual([0, 2900]);
    // 種別も入る（図の勝ち負けと、足すときの既定に効く）。
    expect(frame.map((member) => member.kind)).toEqual([
      'column',
      'stud',
      'stud',
      'stud',
      'column',
      'beam',
      'beam',
    ]);
  });

  it('面材の仕様だけを取り出して、次の面材へ引き継げる', () => {
    const spec = specOf(makePanel({ materialId: 'plywood12-n50', thickness: 12, k: 0.43 }));

    expect(spec.materialId).toBe('plywood12-n50');
    expect(spec.thickness).toBe(12);
    expect(spec.k).toBe(0.43);
    // 仕様以外（寸法・釘配列）は持ち込まない。
    expect(spec.width).toBeUndefined();
    expect(spec.nailPitch).toBeUndefined();
    // 何も無い面材からは空の仕様になる。
    expect(specOf(undefined).materialId).toBe('');
  });

  it('壁 ID・面材 ID は重複しない（PDF に埋め込まれ、読み込み後も使う）', () => {
    expect(new Set([makeWall().wallId, makeWall().wallId]).size).toBe(2);
    expect(new Set([makePanel().panelId, makePanel().panelId]).size).toBe(2);
  });
});

describe('capturePanel', () => {
  it('書き戻したあとの面材を返す（先に取り出した面材は捨てられる）', () => {
    const wall = makeWall({ panels: [makePanel({ panelName: '下段' })] });
    // 入力欄から読み直した内容。面材はオブジェクトごと作り直される。
    const captured = {
      wallName: '南面',
      panels: [{ ...wall.panels[0], panelName: '下段（入力中）' }],
    };
    const stale = wall.panels[0];

    const panel = capturePanel(wall, captured, 0);

    expect(wall.wallName).toBe('南面');
    // 書き換えてよいのは、書き戻したあとの面材のほう。
    expect(panel).toBe(wall.panels[0]);
    expect(panel).not.toBe(stale);
    expect(panel.panelName).toBe('下段（入力中）');
    panel.gradeId = 'plywood-jas2';
    expect(wall.panels[0].gradeId).toBe('plywood-jas2');
  });

  it('面材を指していなければ null（書き戻しだけを行う）', () => {
    const wall = makeWall();
    const captured = { wallName: '南面', panels: [] };

    expect(capturePanel(wall, captured, undefined)).toBe(null);
    expect(capturePanel(wall, captured, 3)).toBe(null);
    expect(wall.wallName).toBe('南面');
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
          studPitch: 500,
          junk: 1,
          panels: [
            {
              panelId: 'pn1',
              panelName: '下段',
              // 面材と釘は面材ごとの入力（1 枚の壁でも張り分けられる）。
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
              side: 'back',
              left: 0,
              bottom: 1820,
              right: 910,
              top: 2730,
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
    expect(data.walls[0].panels[0]).toMatchObject({
      panelId: 'pn1',
      panelName: '下段',
      materialId: 'plywood12-n50',
      thickness: 12,
      k: 0.483,
      gradeId: 'plywood-jas1',
      tauMax: 3.6,
      side: 'back',
      left: 0,
      bottom: 1820,
      right: 910,
      top: 2730,
      nailPitch: 75,
      edgeDistance: 15,
      grain: 'width',
    });
    expect(data.walls[0].panels[0].junk).toBeUndefined();
    expect(data.walls[0].panels[0].junk).toBeUndefined();
  });

  it('壁が無い内容でも、編集を始められる形にする', () => {
    const data = mergeFormData({ projectName: '邸' });

    expect(data.walls).toHaveLength(1);
    expect(data.issuedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('知らない張る面は表面として扱う', () => {
    const data = mergeFormData({ walls: [{ panels: [{ side: 'なにか' }] }] });

    expect(data.walls[0].panels[0].side).toBe('front');
  });

  it('軸組材が入っていなければ、尺モジュールの軸組を入れておく', () => {
    // 読み込んだ計算書は計算実装が軸組材へ読み替え終えているので、ここへ
    // 一覧の無い内容が来るのは、手で組み立てた入力のときだけ。
    const data = mergeFormData({ walls: [{ width: 1820, height: 2900, panels: [{}] }] });

    expect(data.walls[0].frame.map((member) => member.position)).toEqual([
      0, 455, 910, 1365, 1820, 0, 2900,
    ]);
  });

  it('軸組材が入っていれば、その位置と見付け幅をそのまま読む', () => {
    const data = mergeFormData({
      walls: [
        {
          frame: [
            { kind: 'column', direction: 'vertical', label: '柱', position: 0, width: 120 },
            { kind: 'beam', direction: 'horizontal', label: 'まぐさ', position: 2000, width: 105 },
          ],
          panels: [{}],
        },
      ],
    });

    // 材端を書いていない材には、既定の材端（直交する材の外面まで）が入る。
    expect(data.walls[0].frame).toEqual([
      { kind: 'column', direction: 'vertical', label: '柱', position: 0, width: 120,
        from: 0, to: 2900 },
      { kind: 'beam', direction: 'horizontal', label: 'まぐさ', position: 2000, width: 105,
        from: -60, to: 910 },
    ]);
    // 全て消した状態は、そのまま空で扱う（既定に戻さない）。
    expect(mergeFormData({ walls: [{ frame: [], panels: [{}] }] }).walls[0].frame)
      .toEqual([]);
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

describe('nextPlacement', () => {
  it('直前の面材と同じ大きさのものを、その真上に置く', () => {
    const previous = makePanel({ left: 0, bottom: 0, right: 910, top: 1820 });

    expect(nextPlacement(previous)).toEqual({
      side: 'front',
      left: 0,
      bottom: 1820,
      right: 910,
      top: 3640,
    });
  });

  it('張る面と左右の位置は引き継ぐ（同じ通りを上へ重ねる）', () => {
    const previous = makePanel({
      side: 'back',
      left: 455,
      bottom: 0,
      right: 1365,
      top: 910,
    });

    expect(nextPlacement(previous)).toEqual({
      side: 'back',
      left: 455,
      bottom: 910,
      right: 1365,
      top: 1820,
    });
  });

  it('直前の面材が無ければ、壁の左下に 3×6 板を 1 枚置く', () => {
    expect(nextPlacement(undefined)).toEqual({
      side: 'front',
      left: 0,
      bottom: 0,
      right: 910,
      top: 1820,
    });
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
    // 3.3(1)④「10mm 以上かつ接合具径 d × 5 以上」→ 2.75 × 5 = 13.75mm。
    minEdgeDistance: 13.75,
    // 同じ ④ の軸材側は「20mm 以上かつ d × 5 以上」→ 20mm。
    minFrameClearance: 20,
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
    expect(panelFieldsFromMaterial(material)).toEqual({
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

    expect(panelFieldsFromGrade(grade)).toEqual({
      gradeId: 'plywood-jas2',
      tauMax: 2.4,
      e1: 3500,
      e2: 5500,
    });
  });

  it('選んだ釘と、そこから決まるへりあき・縁端距離の最小値を案内する', () => {
    const note = nailNote([material], 'plywood12-n50');

    expect(note).toContain('鉄丸釘 N-50');
    expect(note).toContain('φ2.75 mm');
    // 3.3(1)④「10mm 以上かつ接合具径 d × 5 以上」→ 2.75 × 5 = 13.75mm。
    expect(note).toContain('13.75 mm 以上');
    // 軸材の側は「20mm 以上かつ d × 5 以上」なので、この釘では 20mm。
    expect(note).toContain('軸材の縁端距離は 20 mm 以上');
    // まだ選んでいないときは案内を出さない。
    expect(nailNote([material], '')).toBe('');
  });

  it('必要なへりあきは、選んだ釘で決まる（未選択なら 10mm）', () => {
    expect(minimumEdgeDistance([material], 'plywood12-n50')).toBe(13.75);
    expect(minimumEdgeDistance([material], '')).toBe(10);
    expect(minimumEdgeDistance([], 'plywood12-n50')).toBe(10);
  });

  it('足りないへりあきだけを引き上げる（広げた値は狭めない）', () => {
    const panels = [
      { edgeDistance: 10 },
      { edgeDistance: 20 },
      { edgeDistance: '' },
    ];

    raiseEdgeDistance(panels, 13.75);

    expect(panels.map((panel) => panel.edgeDistance)).toEqual([13.75, 20, 13.75]);
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
