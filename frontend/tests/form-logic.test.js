// フォームの純粋ロジック（form-logic.js）の単体テスト。
// 旧リポジトリで GAS 側の挙動として固定していたバリデーション仕様を引き継ぐ。

import { describe, expect, it } from 'vitest';
import { collectWarnings, toNumber } from '../src/excel-report-formatter/form-logic.js';
import { fileNameFromDisposition } from '../src/content-disposition.js';

// バックエンドの /config が返す形（mapping.json 由来）を模したフォーム定義。
const GROUPS = [
  {
    group: '床',
    select_label: '傾斜方向',
    points: [
      { key: 'floor_x', label: 'X方向', options: ['←', '→', '傾斜無'] },
      { key: 'floor_y', label: 'Y方向', options: ['↑', '↓', '傾斜無'] },
    ],
  },
  {
    group: '柱',
    select_label: '測定した柱',
    points: [{ key: 'pillar_ud', label: '上下', options: ['上柱', '下柱', '―'] }],
  },
];

const VALIDATION = {
  slope_warning_threshold: 6,
  no_value_select_options: ['傾斜無', '―'],
  require_select_keys: ['pillar_ud'],
};

function room(measurements) {
  return { floor: '1', room_name: 'LDK', measurements };
}

describe('toNumber', () => {
  it('半角の数値文字列を解釈する', () => {
    expect(toNumber('3.5')).toBe(3.5);
    expect(toNumber('-2')).toBe(-2);
  });

  it('全角の数字・記号を NFKC 正規化して解釈する（バックエンドと同じ挙動）', () => {
    expect(toNumber('１５００')).toBe(1500);
    expect(toNumber('－３')).toBe(-3);
    expect(toNumber('３．５')).toBe(3.5);
  });

  it('空値は NaN', () => {
    expect(toNumber('')).toBeNaN();
    expect(toNumber('  ')).toBeNaN();
    expect(toNumber(null)).toBeNaN();
    expect(toNumber(undefined)).toBeNaN();
  });
});

describe('collectWarnings', () => {
  it('問題のない入力では警告を出さない', () => {
    const data = {
      rooms: [
        room({
          floor_x: { select: '←', diff: '2', distance: '2000' },
          pillar_ud: { select: '―' },
        }),
      ],
    };
    expect(collectWarnings(data, GROUPS, VALIDATION)).toEqual([]);
  });

  it('必須の選択欄（柱）が未選択なら警告する', () => {
    const data = { rooms: [room({})] };
    const warnings = collectWarnings(data, GROUPS, VALIDATION);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('柱 上下');
    expect(warnings[0]).toContain('未選択');
  });

  it('向きを選択したのに計測値が未入力なら警告する', () => {
    const data = {
      rooms: [room({ floor_x: { select: '←' }, pillar_ud: { select: '―' } })],
    };
    const warnings = collectWarnings(data, GROUPS, VALIDATION);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('床 X方向');
    expect(warnings[0]).toContain('計測値が未入力');
  });

  it('「傾斜無」「―」の選択では計測値が未入力でも警告しない', () => {
    const data = {
      rooms: [room({ floor_x: { select: '傾斜無' }, pillar_ud: { select: '―' } })],
    };
    expect(collectWarnings(data, GROUPS, VALIDATION)).toEqual([]);
  });

  it('水平器計測値がしきい値以上なら警告する', () => {
    const data = {
      rooms: [
        room({
          floor_x: { select: '←', digital_level: '6' },
          pillar_ud: { select: '―' },
        }),
      ],
    };
    const warnings = collectWarnings(data, GROUPS, VALIDATION);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('6/1000 以上だと再検査');
  });

  it('1000×差÷距離 がしきい値以上なら警告する（全角入力も解釈する）', () => {
    const data = {
      rooms: [
        room({
          floor_x: { select: '←', diff: '１２', distance: '１０００' },
          pillar_ud: { select: '―' },
        }),
      ],
    };
    const warnings = collectWarnings(data, GROUPS, VALIDATION);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('約 12/1000');
  });

  it('しきい値未満の傾斜では警告しない', () => {
    const data = {
      rooms: [
        room({
          floor_x: { select: '←', diff: '2', distance: '2000', digital_level: '1' },
          pillar_ud: { select: '上柱' , digital_level: '2' },
        }),
      ],
    };
    expect(collectWarnings(data, GROUPS, VALIDATION)).toEqual([]);
  });

  it('部屋番号を警告文に含める', () => {
    const data = { rooms: [room({ pillar_ud: { select: '―' } }), room({})] };
    const warnings = collectWarnings(data, GROUPS, VALIDATION);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('部屋 2');
  });
});

describe('fileNameFromDisposition', () => {
  it('RFC 5987 の filename* をデコードする', () => {
    const disposition =
      "attachment; filename*=UTF-8''%E5%82%BE%E6%96%9C%E6%B8%AC%E5%AE%9A%E5%A0%B1%E5%91%8A%E6%9B%B8.xlsx";
    expect(fileNameFromDisposition(disposition)).toBe('傾斜測定報告書.xlsx');
  });

  it('ヘッダーが無ければ null', () => {
    expect(fileNameFromDisposition(null)).toBeNull();
    expect(fileNameFromDisposition('attachment')).toBeNull();
  });
});
