// @vitest-environment jsdom
//
// 現況検査レポート作成ツールの画面（main.js）の「測る」ボタン。
//
// 傾きセンサーで測れる端末では、tilt（mapping.json）のある計測点にだけ
// ボタンを出し、測った値を同じ行の水平器の欄に入れることを固定する。
// 測る画面そのものは tilt-meter.test.js が見る。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prepare: null,
  canMeasureTilt: vi.fn(),
  openTiltMeter: vi.fn(),
}));

vi.mock('../src/page-start.js', () => ({
  startPage: ({ prepare }) => {
    mocks.prepare = prepare;
  },
}));
vi.mock('../src/api.js', () => ({
  apiGet: async (path) => (path.endsWith('/config') ? CONFIG : { configured: true, fileName: '雛形' }),
  apiPostForBlob: vi.fn(),
  apiSendJson: vi.fn(),
}));
vi.mock('../src/drive-picker.js', () => ({ pickFile: vi.fn() }));
vi.mock('../src/template-preview.js', () => ({ connectTemplatePreview: vi.fn() }));
vi.mock('../src/excel-report-formatter/tilt-meter.js', () => ({
  canMeasureTilt: (...args) => mocks.canMeasureTilt(...args),
  openTiltMeter: (...args) => mocks.openTiltMeter(...args),
}));

// /config の形（mapping.json 由来）。測れない計測点（tilt の無いもの）も混ぜる。
const CONFIG = {
  measurement_groups: [
    {
      group: '床',
      select_label: '傾斜方向',
      points: [{ key: 'floor_x', label: 'X方向', options: ['←', '→', '傾斜無'], tilt: 'horizontal' }],
    },
    {
      group: '柱',
      select_label: '測定した柱',
      points: [
        { key: 'pillar_ud', label: '上下', options: ['上柱', '下柱', '―'], tilt: 'vertical' },
        { key: 'other', label: 'その他', options: ['―'], tilt: null },
      ],
    },
  ],
  validation: { no_value_select_options: ['傾斜無', '―'] },
  max_rooms: 3,
};

async function openTool() {
  vi.resetModules();
  document.body.innerHTML = readFileSync(resolve('src/excel-report-formatter/page.html'), 'utf8');
  await import('../src/components/index.js');
  await import('../src/excel-report-formatter/main.js');
  await mocks.prepare();
}

const row = (point) =>
  document.querySelector(`select[data-point="${point}"]`).closest('tr');
const level = (point) =>
  row(point).querySelector('input[data-field="digital_level"]');

/** ボタンを押し、測る画面の答え（openTiltMeter の値）が反映されるまで待つ。 */
async function press(point) {
  row(point).querySelector('.measure-tilt').click();
  await vi.waitFor(() => expect(mocks.openTiltMeter).toHaveBeenCalled());
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canMeasureTilt.mockReturnValue(true);
});

describe('「測る」ボタン', () => {
  it('測れる端末では、tilt のある計測点にだけ出す', async () => {
    await openTool();

    expect(mocks.canMeasureTilt).toHaveBeenCalledWith(window);
    expect(row('floor_x').querySelector('.measure-tilt').textContent).toBe('測る');
    expect(row('pillar_ud').querySelector('.measure-tilt')).not.toBeNull();
    expect(row('other').querySelector('.measure-tilt')).toBeNull();
  });

  it('測れない端末には出さない', async () => {
    mocks.canMeasureTilt.mockReturnValue(false);
    await openTool();

    expect(document.querySelector('.measure-tilt')).toBeNull();
  });

  it('測った値を水平器の欄に入れ、傾斜方向が未選択なら選択欄へ送る', async () => {
    mocks.openTiltMeter.mockResolvedValue({ value: '3.4', lowEnd: 'top' });
    await openTool();
    await press('floor_x');

    expect(mocks.openTiltMeter).toHaveBeenCalledWith({
      doc: document,
      tilt: 'horizontal',
      title: '床 X方向',
    });
    expect(level('floor_x').value).toBe('3.4');
    expect(document.activeElement).toBe(row('floor_x').querySelector('select'));
    // 測る画面は閉じるので、低かった側はメッセージに残す。
    expect(document.getElementById('message').innerText).toBe(
      '床 X方向 に 3.4/1000 を入れました。1 回目に置いた向きで、スマートフォンの上端の側が低くなっていました。'
    );
  });

  it('入れたことは input イベントで知らせる', async () => {
    mocks.openTiltMeter.mockResolvedValue({ value: '2.0', lowEnd: 'bottom' });
    await openTool();
    const seen = vi.fn();
    document.getElementById('rooms').addEventListener('input', (e) => seen(e.target.value));
    await press('floor_x');

    expect(seen).toHaveBeenCalledWith('2.0');
  });

  it('「傾斜無」のままなら、選び直せるよう選択欄へ送る', async () => {
    mocks.openTiltMeter.mockResolvedValue({ value: '3.2', lowEnd: 'top' });
    await openTool();
    row('floor_x').querySelector('select').value = '傾斜無';
    await press('floor_x');

    expect(document.activeElement).toBe(row('floor_x').querySelector('select'));
  });

  it('測る画面を開けなければ、理由を出す', async () => {
    mocks.openTiltMeter.mockRejectedValue(new Error('showModal が使えません'));
    await openTool();
    await press('floor_x');

    expect(document.getElementById('message').innerText).toBe(
      '傾きを測る画面を開けませんでした: showModal が使えません'
    );
  });

  it('選択済みなら、フォーカスは動かさない', async () => {
    mocks.openTiltMeter.mockResolvedValue({ value: '1.2', lowEnd: null });
    await openTool();
    row('pillar_ud').querySelector('select').value = '上柱';
    await press('pillar_ud');

    expect(mocks.openTiltMeter).toHaveBeenCalledWith({
      doc: document,
      tilt: 'vertical',
      title: '柱 上下',
    });
    expect(level('pillar_ud').value).toBe('1.2');
    expect(document.activeElement).not.toBe(row('pillar_ud').querySelector('select'));
    expect(document.getElementById('message').innerText).toBe('柱 上下 に 1.2/1000 を入れました。');
  });

  it('やめたら、入っている値はそのまま', async () => {
    mocks.openTiltMeter.mockResolvedValue(null);
    await openTool();
    level('floor_x').value = '5';
    await press('floor_x');

    expect(level('floor_x').value).toBe('5');
  });

  it('ボタン以外を押しても測らない', async () => {
    await openTool();
    row('floor_x').querySelector('.point-cell').click();

    expect(mocks.openTiltMeter).not.toHaveBeenCalled();
  });
});
