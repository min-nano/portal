// @vitest-environment jsdom
//
// 現況検査レポート作成ツールの画面（main.js）の「写真から読み取る」。
//
// 実際のページのマークアップの上でツールの準備を通し、写真の読み取り
// （../src/paddle-ocr/client.js）と確かめるダイアログ（room-dialog.js）は
// 偽物にして、物件名はそのまま入れること・部屋は確定したものだけを空の部屋から
// 順に入れること・読めなかったときの知らせ方を固定する。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prepare: null,
  readings: [],
  readImageFile: null,
  releaseReader: null,
  confirmRooms: null,
}));

vi.mock('../src/page-start.js', () => ({
  startPage: ({ prepare }) => {
    mocks.prepare = prepare;
  },
}));
vi.mock('../src/api.js', () => ({
  apiGet: async (path) =>
    path.endsWith('/config')
      ? {
          measurement_groups: [
            { group: '床', select_label: '方向', points: [{ key: 'floor_x', label: 'X', options: ['東'] }] },
          ],
          validation: {},
          max_rooms: 3,
        }
      : { configured: true, fileName: '雛形' },
  apiPostForBlob: vi.fn(),
  apiSendJson: vi.fn(),
}));
vi.mock('../src/drive-picker.js', () => ({ pickFile: vi.fn() }));
vi.mock('../src/template-preview.js', () => ({ connectTemplatePreview: vi.fn() }));
vi.mock('../src/paddle-ocr/client.js', () => ({
  readImageFile: (...args) => mocks.readImageFile(...args),
  releaseReader: (...args) => mocks.releaseReader(...args),
}));
vi.mock('../src/excel-report-formatter/room-dialog.js', () => ({
  confirmRooms: (...args) => mocks.confirmRooms(...args),
}));

const item = (text, x, y) => ({ text, x0: x, y0: y, x1: x + 100, y1: y + 40 });

/** データシートの写真の読み（物件名は架空）。 */
const DATA_SHEET = [item('物件名', 0, 0), item('架空市本町1-2', 200, 0)];
/** 間取り図の写真の読み。 */
const FLOOR_PLAN = [item('1F', 0, 0), item('LDK', 0, 200), item('2F', 0, 600), item('洋室', 0, 800)];

const roomValues = () =>
  [...document.querySelectorAll('#rooms .room')].map((room) => [
    room.querySelector('[data-room-field="floor"]').value,
    room.querySelector('[data-room-field="room_name"]').value,
  ]);
const message = () => document.getElementById('message');

/** 写真を選んだことにして、読み取りが終わるまで待つ。 */
async function choosePhotos(names) {
  const input = document.getElementById('photoInput');
  Object.defineProperty(input, 'files', { value: names.map((name) => ({ name })), configurable: true });
  input.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(document.getElementById('photoReadBtn').disabled).toBe(false));
  // ダイアログを閉じた後の処理まで進める。
  await new Promise((done) => setTimeout(done, 0));
}

beforeEach(async () => {
  vi.resetModules();
  mocks.readings = {};
  mocks.readImageFile = vi.fn(async (file) => {
    const reading = mocks.readings[file.name];
    if (reading instanceof Error) throw reading;
    return reading;
  });
  mocks.releaseReader = vi.fn();
  mocks.confirmRooms = vi.fn(async (rooms) => rooms);
  document.body.innerHTML = readFileSync(resolve('src/excel-report-formatter/page.html'), 'utf8');
  await import('../src/components/index.js');
  await import('../src/excel-report-formatter/main.js');
  await mocks.prepare();
});

describe('写真から読み取る', () => {
  it('説明は「?」に畳んであり、押すと開く', () => {
    const help = document.getElementById('helpPhoto').closest('.help');
    const button = help.querySelector('.help-btn');
    expect(help.classList.contains('open')).toBe(false);
    button.click();
    expect(help.classList.contains('open')).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('ボタンで写真の選択を開き、何も選ばなければ何もしない', () => {
    const input = document.getElementById('photoInput');
    const opened = vi.fn();
    input.click = opened;
    document.getElementById('photoReadBtn').click();
    expect(opened).toHaveBeenCalled();

    Object.defineProperty(input, 'files', { value: [], configurable: true });
    input.dispatchEvent(new Event('change'));
    expect(mocks.readImageFile).not.toHaveBeenCalled();
  });

  it('物件名はそのまま入れ、部屋は確かめてから空の部屋に入れ、足りなければ追加する', async () => {
    mocks.readings = { sheet: DATA_SHEET, plan: FLOOR_PLAN };
    document.getElementById('property_name').value = '前の物件';

    await choosePhotos(['sheet', 'plan']);

    expect(document.getElementById('property_name').value).toBe('架空市本町1-2');
    expect(mocks.confirmRooms).toHaveBeenCalledWith(
      [
        { floor: '1', name: 'LDK' },
        { floor: '2', name: '洋室' },
      ],
      3 // 最初の空の部屋 1 つ + 上限 3 までの残り 2
    );
    expect(roomValues()).toEqual([
      ['1', 'LDK'],
      ['2', '洋室'],
    ]);
    expect(message().innerText).toBe('物件名を入れました。2 部屋を入れました。');
    expect(message().style.color).toBe('green');
    expect(mocks.releaseReader).toHaveBeenCalledTimes(1);
    expect(document.getElementById('photoInput').value).toBe('');
  });

  it('入力済みの部屋はそのまま残し、入れられる数を数えるときにも除く', async () => {
    const [first] = document.querySelectorAll('#rooms .room');
    first.querySelector('[data-point="floor_x"][data-field="diff"]').value = '3';
    document.getElementById('addRoomBtn').click();
    document.querySelectorAll('[data-room-field="room_name"]')[1].value = 'ホール';
    mocks.readings = { plan: FLOOR_PLAN };
    mocks.confirmRooms = vi.fn(async () => [{ floor: '2', name: '書斎' }]);

    await choosePhotos(['plan']);

    expect(mocks.confirmRooms.mock.calls[0][1]).toBe(1);
    expect(roomValues()).toEqual([
      ['1', ''],
      ['1', 'ホール'],
      ['2', '書斎'],
    ]);
    expect(message().innerText).toBe('1 部屋を入れました。');
  });

  it('確かめるダイアログでキャンセルしたら、部屋は入れない（物件名は入れたまま）', async () => {
    mocks.readings = { sheet: DATA_SHEET, plan: FLOOR_PLAN };
    mocks.confirmRooms = vi.fn(async () => null);

    await choosePhotos(['sheet', 'plan']);

    expect(document.getElementById('property_name').value).toBe('架空市本町1-2');
    expect(roomValues()).toEqual([['1', '']]);
    expect(message().innerText).toBe('物件名を入れました。部屋は入れていません。');

    mocks.readings = { plan: FLOOR_PLAN };
    await choosePhotos(['plan']);
    expect(message().innerText).toBe('部屋は入れていません。');
  });

  it('部屋が読めなければダイアログは開かず、物件名だけを入れたと知らせる', async () => {
    mocks.readings = { sheet: DATA_SHEET };
    await choosePhotos(['sheet']);
    expect(mocks.confirmRooms).not.toHaveBeenCalled();
    expect(message().innerText).toBe(
      '物件名を入れました。部屋は読み取れませんでした（間取り図の写真も選ぶと、部屋も読み取ります）。'
    );
    expect(message().style.color).toBe('green');
  });

  it('どちらも読めなければ、撮り直しを促す', async () => {
    mocks.readings = { blank: [item('ごあいさつ', 0, 0)] };
    document.getElementById('property_name').value = '前の物件';
    await choosePhotos(['blank']);
    expect(document.getElementById('property_name').value).toBe('前の物件');
    expect(message().innerText).toBe(
      '物件名も部屋も読み取れませんでした。資料の全体が大きく、まっすぐ写るように撮り直してください。'
    );
    expect(message().style.color).toBe('red');
  });

  it('読み取りに失敗したら理由を出し、読み取りは手放す', async () => {
    mocks.readings = { broken: new Error('写真を開けませんでした。') };
    await choosePhotos(['broken']);
    expect(message().innerText).toBe('写真を読み取れませんでした: 写真を開けませんでした。');
    expect(mocks.releaseReader).toHaveBeenCalledTimes(1);
    expect(mocks.confirmRooms).not.toHaveBeenCalled();
  });

  it('読んでいる間はボタンを押せず、何枚目かを知らせる', async () => {
    let finish;
    mocks.readings = { plan: FLOOR_PLAN };
    mocks.readImageFile = vi.fn(
      (file) =>
        new Promise((done) => {
          finish = () => done(mocks.readings[file.name]);
        })
    );
    const input = document.getElementById('photoInput');
    Object.defineProperty(input, 'files', { value: [{ name: 'plan' }, { name: 'plan' }], configurable: true });
    input.dispatchEvent(new Event('change'));

    expect(document.getElementById('photoReadBtn').disabled).toBe(true);
    expect(message().innerText).toBe(
      '写真を読んでいます（1/2）…初回は読み取りの準備（約 36MB の読み込み）にも時間がかかります。'
    );
    finish();
    await vi.waitFor(() => expect(message().innerText).toBe('写真を読んでいます（2/2）…'));
    finish();
    await vi.waitFor(() => expect(document.getElementById('photoReadBtn').disabled).toBe(false));
  });
});
