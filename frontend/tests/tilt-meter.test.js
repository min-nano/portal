// @vitest-environment jsdom
//
// 傾きを測る画面（tilt-meter.js）。センサーは deviceorientation イベントを
// 端末の置き方から合成して流す（tilt-fixtures.js）。反転法の 2 回の計測から値を求めて返すこと、精度が足りない
// とき（値の刻みが粗い・値が届かない・許可されない）は値を入れさせない
// ことを固定する。計算そのものは tilt-logic.test.js が見る。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEASURE_MS, SETTLE_MS } from '../src/excel-report-formatter/tilt-logic.js';
import {
  canMeasureTilt,
  listenOrientation,
  openTiltMeter,
  requestTiltPermission,
} from '../src/excel-report-formatter/tilt-meter.js';
import { onFloor, onWall, samples } from './tilt-fixtures.js';

// jsdom の <dialog> には showModal / close が無い。開閉の印だけを真似る。
HTMLDialogElement.prototype.showModal = function showModal() {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close() {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
};

/** 合成した deviceorientation を 1 つ流す。 */
function emit(alpha, beta, gamma, timeStamp) {
  const event = new Event('deviceorientation');
  Object.assign(event, { alpha, beta, gamma });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  window.dispatchEvent(event);
}

/**
 * 待ち時間（wait）のあと、60 Hz で 2 秒ぶんの値を流しきる。値には、
 * センサーの値がそのまま届いているときのような細かな揺れを足し、最後に
 * ブラウザがする丸め（round）を通す。
 */
async function stream(orientation, { wait = SETTLE_MS, count = 120, round } = {}) {
  await vi.advanceTimersByTimeAsync(wait);
  const at = typeof orientation === 'function' ? orientation : () => orientation;
  for (const { alpha, beta, gamma, t } of samples(at, { count, round })) {
    emit(alpha, beta, gamma, t);
  }
  await vi.advanceTimersByTimeAsync(MEASURE_MS);
}

const dialog = () => document.querySelector('dialog.tilt-meter');
const go = () => dialog().querySelector('.tilt-meter-go');
const errorText = () => dialog().querySelector('.dialog-error').textContent;

/** 「n 回目を測る」を押して、値を流しきる。 */
async function measure(orientation, options) {
  go().click();
  await vi.advanceTimersByTimeAsync(0); // 許可の確認（await）を済ませる
  await stream(orientation, options);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  window.DeviceOrientationEvent = class DeviceOrientationEvent {};
});

afterEach(() => {
  vi.useRealTimers();
  delete window.DeviceOrientationEvent;
});

describe('canMeasureTilt', () => {
  it('傾きのイベントがあり、主な操作が指の端末だけ', () => {
    const DeviceOrientationEvent = class {};
    const pointer = (coarse) => (query) => ({ matches: coarse && query === '(pointer: coarse)' });
    expect(canMeasureTilt({ DeviceOrientationEvent, matchMedia: pointer(true) })).toBe(true);
    // タッチパネルのノートパソコンなど（主な操作はマウス）。
    expect(canMeasureTilt({ DeviceOrientationEvent, matchMedia: pointer(false) })).toBe(false);
    expect(canMeasureTilt({ matchMedia: pointer(true) })).toBe(false);
  });
});

describe('requestTiltPermission', () => {
  it('許可を求める仕組みが無ければ（iOS 以外）そのまま使える', async () => {
    expect(await requestTiltPermission(window)).toBe(true);
  });

  it('iOS は requestPermission の答えに従う', async () => {
    window.DeviceOrientationEvent.requestPermission = async () => 'granted';
    expect(await requestTiltPermission(window)).toBe(true);
    window.DeviceOrientationEvent.requestPermission = async () => 'denied';
    expect(await requestTiltPermission(window)).toBe(false);
  });
});

describe('listenOrientation', () => {
  it('待ち時間のあと、決めた時間だけ値を集める（傾きの無いイベントは捨てる）', async () => {
    const sensor = listenOrientation(window);
    const collecting = sensor.collect(SETTLE_MS, MEASURE_MS);
    emit(0, 1, 2, 0); // 待ち時間の中: 捨てる
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    emit(9, 3, 4, 10);
    emit(null, 3, 4, 15); // alpha だけ無いのは使う
    emit(9, null, 4, 20);
    emit(9, 3, null, 30);
    await vi.advanceTimersByTimeAsync(MEASURE_MS);
    emit(0, 5, 6, 40); // 終わったあと: 捨てる

    expect(await collecting).toEqual([
      { alpha: 9, beta: 3, gamma: 4, t: 10 },
      { alpha: null, beta: 3, gamma: 4, t: 15 },
    ]);
    sensor.stop();
  });

  it('止めるまで聞き続け（alpha の基準を変えない）、重なった集めもそれぞれに届く', async () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const sensor = listenOrientation(window);
    const first = sensor.collect(0, MEASURE_MS);
    await vi.advanceTimersByTimeAsync(MEASURE_MS / 2);
    const second = sensor.collect(0, MEASURE_MS);
    await vi.advanceTimersByTimeAsync(0);
    emit(1, 2, 3, 10);
    await vi.advanceTimersByTimeAsync(MEASURE_MS);

    expect(await first).toHaveLength(1);
    expect(await second).toHaveLength(1);
    expect(remove).not.toHaveBeenCalledWith('deviceorientation', expect.any(Function));
    sensor.stop();
    expect(remove).toHaveBeenCalledWith('deviceorientation', expect.any(Function));
    remove.mockRestore();
  });
});

describe('openTiltMeter', () => {
  it('床: 画面を上にして寝かせ、180° 回した 2 回から、ずれを除いた傾きと低い側を返す', async () => {
    const answer = openTiltMeter({ doc: document, tilt: 'horizontal', title: '床 X方向' });

    expect(dialog().hasAttribute('open')).toBe(true);
    expect(dialog().querySelector('h3').textContent).toBe('床 X方向を測る');
    expect(dialog().querySelector('.tilt-meter-howto').textContent).toContain('画面を上にして');
    expect(go().textContent).toBe('1 回目を測る');
    expect(dialog().querySelector('.tilt-meter-redo').hidden).toBe(true);

    // 本当の傾き 3（上端が高い）、ずれ 15（カメラの出っ張りで端末が傾く分）。
    await measure(onFloor(30, 3 + 15));
    expect(go().textContent).toBe('2 回目を測る');
    expect(dialog().querySelector('.tilt-meter-howto').textContent).toContain('180° 回して');
    expect(dialog().querySelector('.tilt-meter-redo').hidden).toBe(false);
    const first = dialog().querySelector('.tilt-meter-readings li').textContent;
    expect(first).toContain('1 回目: 18.0/1000');
    expect(first).toContain('値の刻み 0.001 未満/1000');
    expect(first).toContain('60 Hz');

    await measure(onFloor(210, -3 + 15));
    expect(go().textContent).toBe('3.0 を入れる');
    expect(dialog().querySelector('.tilt-meter-howto').textContent).toBe(
      '傾き 3.0/1000（0.30%）。1 回目に置いた向きで、スマートフォンの下端の側が低くなっています。'
    );
    expect(dialog().querySelector('.tilt-meter-status').textContent).toContain('ずれ 15.0/1000');

    go().click();
    expect(await answer).toEqual({ value: '3.0', lowEnd: 'bottom' });
    expect(dialog()).toBeNull();
  });

  it('床: 傾きが無ければそう書く', async () => {
    openTiltMeter({ doc: document, tilt: 'horizontal', title: '床 Y方向' });
    await measure(onFloor(0, 1));
    await measure(onFloor(180, 1));

    expect(dialog().querySelector('.tilt-meter-howto').textContent).toBe(
      '傾き 0.0/1000（0.00%）。傾きはありません。'
    );
  });

  it('壁: 側面を当て、反対側の側面を当てて 2 回。低い側は出さない', async () => {
    const answer = openTiltMeter({ doc: document, tilt: 'vertical', title: '壁 上下' });
    expect(dialog().querySelector('.tilt-meter-howto').textContent).toContain('側面');

    // 本当の傾き 3、センサーのずれ 1。
    await measure(onWall(90, 3 + 1));
    expect(dialog().querySelector('.tilt-meter-howto').textContent).toContain('反対側の側面');
    await measure(onWall(270, -3 + 1));
    expect(dialog().querySelector('.tilt-meter-howto').textContent).toBe('傾き 3.0/1000（0.30%）');
    expect(dialog().querySelector('.tilt-meter-status').textContent).toContain('（センサーの分）');

    go().click();
    expect(await answer).toEqual({ value: '3.0', lowEnd: null });
  });

  it('値の刻みが粗ければ（ブラウザが丸めている）、値を入れさせず水平器を勧める', async () => {
    openTiltMeter({ doc: document, tilt: 'horizontal', title: '床 X方向' });
    // W3C の仕様案どおり 0.1° に丸める。
    const toTenth = (value) => Math.round(value * 10) / 10;
    const base = onFloor(0, 3);
    await measure(
      (i) => ({ ...base, beta: base.beta + (i % 3) * 0.05, gamma: (i % 2) * 0.05 }),
      { round: toTenth }
    );

    expect(errorText()).toContain('刻み');
    expect(errorText()).toContain('デジタル水平器で測ってください');
    expect(go().textContent).toBe('1 回目を測る');
    expect(go().disabled).toBe(false);
  });

  it('値が届かなければ、その旨を出す', async () => {
    openTiltMeter({ doc: document, tilt: 'horizontal', title: '床 X方向' });
    await measure(onFloor(0, 1), { count: 0 });

    expect(errorText()).toContain('傾きセンサーの値が届きません');
  });

  it('許可されなければ測らない', async () => {
    window.DeviceOrientationEvent.requestPermission = async () => 'denied';
    openTiltMeter({ doc: document, tilt: 'horizontal', title: '床 X方向' });
    go().click();
    await vi.advanceTimersByTimeAsync(0);

    expect(errorText()).toContain('許可されませんでした');
    expect(dialog().querySelector('.tilt-meter-status').textContent).toBe('');
  });

  it('許可を求められなければ（操作の外から呼んだなど）理由を出す', async () => {
    window.DeviceOrientationEvent.requestPermission = async () => {
      throw new Error('requires a user gesture');
    };
    openTiltMeter({ doc: document, tilt: 'horizontal', title: '床 X方向' });
    go().click();
    await vi.advanceTimersByTimeAsync(0);

    expect(errorText()).toBe('センサーを使えませんでした: requires a user gesture');
    expect(go().disabled).toBe(false);
  });

  it('2 回目の向きが違えば、最初から測り直す', async () => {
    openTiltMeter({ doc: document, tilt: 'horizontal', title: '床 X方向' });
    await measure(onFloor(0, 2));
    await measure(onFloor(0, 2));

    expect(errorText()).toContain('2 回目の向きが違います');
    expect(go().textContent).toBe('1 回目を測る');
    expect(dialog().querySelector('.tilt-meter-readings').children).toHaveLength(0);
  });

  it('測っている途中で「最初から」を押したら、その計測は捨てる', async () => {
    openTiltMeter({ doc: document, tilt: 'horizontal', title: '床 X方向' });
    await measure(onFloor(0, 2));
    go().click();
    await vi.advanceTimersByTimeAsync(0);
    dialog().querySelector('.tilt-meter-redo').click();
    await stream(onFloor(180, -2));

    expect(go().textContent).toBe('1 回目を測る');
    expect(dialog().querySelector('.tilt-meter-readings').children).toHaveLength(0);
    expect(errorText()).toBe('');
  });

  it('許可を待つ間に閉じたら、あとで届いた答えは画面に書かない', async () => {
    let answerPermission;
    let failPermission;
    window.DeviceOrientationEvent.requestPermission = () =>
      new Promise((resolve, reject) => {
        answerPermission = resolve;
        failPermission = reject;
      });
    for (const settle of [() => answerPermission('denied'), () => failPermission(new Error('x'))]) {
      const answer = openTiltMeter({ doc: document, tilt: 'horizontal', title: '床 X方向' });
      const opened = dialog();
      go().click();
      opened.querySelector('.tilt-meter-cancel').click();
      settle();
      await vi.advanceTimersByTimeAsync(0);

      expect(await answer).toBeNull();
      expect(opened.querySelector('.dialog-error').textContent).toBe('');
    }
  });

  it('測っている途中で閉じたら、何も返さない', async () => {
    const answer = openTiltMeter({ doc: document, tilt: 'horizontal', title: '床 X方向' });
    go().click();
    await vi.advanceTimersByTimeAsync(0);
    document.querySelector('dialog.tilt-meter').querySelector('.tilt-meter-cancel').click();
    await stream(onFloor(0, 1));

    expect(await answer).toBeNull();
    expect(dialog()).toBeNull();
  });

  it('測っている途中・1 回目のあとに画面が消えたら（ロックなど）、最初から測り直す', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get');
    const remove = vi.spyOn(document, 'removeEventListener');
    const visibility = (isHidden) => {
      hidden.mockReturnValue(isHidden);
      document.dispatchEvent(new Event('visibilitychange'));
    };
    openTiltMeter({ doc: document, tilt: 'horizontal', title: '床 X方向' });

    // 測る前に消えても、何もしない。
    visibility(true);
    expect(errorText()).toBe('');

    await measure(onFloor(0, 2));
    // 画面が戻ったときの知らせでは何もしない。
    visibility(false);
    expect(go().textContent).toBe('2 回目を測る');

    visibility(true);
    expect(go().textContent).toBe('1 回目を測る');
    expect(errorText()).toBe('画面が消えたので、最初から測り直してください。');

    // 測っている途中に消えたら、その計測は捨て、すぐ測り直せる。
    go().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(go().disabled).toBe(true);
    visibility(true);
    expect(go().disabled).toBe(false);
    await stream(onFloor(0, 2));
    expect(go().textContent).toBe('1 回目を測る');
    expect(dialog().querySelector('.tilt-meter-readings').children).toHaveLength(0);

    // 結果が出たあとに消えても、結果はそのまま。
    await measure(onFloor(0, 2));
    await measure(onFloor(180, -2));
    visibility(true);
    expect(go().textContent).toBe('2.0 を入れる');

    // 閉じたら聞くのをやめる。
    dialog().querySelector('.tilt-meter-cancel').click();
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    hidden.mockRestore();
    remove.mockRestore();
  });

  it('「最初から」で 1 回目に戻り、「やめる」なら何も返さない', async () => {
    const answer = openTiltMeter({ doc: document, tilt: 'horizontal', title: '床 X方向' });
    await measure(onFloor(0, 2));
    dialog().querySelector('.tilt-meter-redo').click();

    expect(go().textContent).toBe('1 回目を測る');
    expect(dialog().querySelector('.tilt-meter-readings').children).toHaveLength(0);

    dialog().querySelector('.tilt-meter-cancel').click();
    expect(await answer).toBeNull();
    expect(dialog()).toBeNull();
  });
});
