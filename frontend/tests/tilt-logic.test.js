// 傾きセンサーで測る計算（tilt-logic.js）の単体テスト。
//
// センサーの値は合成する。床（horizontal）は画面を上にして寝かせた端末を
// 長い辺の向きに傾けた形（beta = 傾きの角度・gamma = 0）、壁（vertical）は
// 縦に立てた端末の側面を当てた形（beta = 90° - 傾きの角度・gamma = -90°）。

import { describe, expect, it } from 'vitest';
import {
  MAX_BIAS,
  MIN_SAMPLES,
  checkSamples,
  combineReversal,
  formatPerMille,
  formatStep,
  quantizationStep,
  slopeOf,
  summarize,
  upVector,
} from '../src/excel-report-formatter/tilt-logic.js';

const DEG = 180 / Math.PI;

/** 1000 分率の傾きを角度（度）にする。 */
const angle = (perMille) => Math.atan(perMille / 1000) * DEG;

/**
 * 合成した計測値。センサーの値がそのまま届いているときのように、静止して
 * いても値がわずかずつ違う（0.0001° 未満の揺れ）。
 *
 * @param {(i: number) => {beta: number, gamma: number}} at i 番目の向き
 * @param {number} count
 * @param {number} hz
 */
function samples(at, count = 120, hz = 60) {
  return Array.from({ length: count }, (_, i) => {
    const jitter = ((i * 7919) % 101) * 1e-6;
    const { beta, gamma } = at(i);
    return { beta: beta + jitter, gamma: gamma - jitter, t: 1000 + (i * 1000) / hz };
  });
}

const floor = (perMille) => () => ({ beta: angle(perMille), gamma: 0 });
const wall = (perMille) => () => ({ beta: 90 - angle(perMille), gamma: -90 });

describe('upVector / slopeOf', () => {
  it('画面を上にして水平に置くと、上は画面の手前（z）', () => {
    const [x, y, z] = upVector(0, 0);
    expect(x).toBeCloseTo(0, 12);
    expect(y).toBeCloseTo(0, 12);
    expect(z).toBeCloseTo(1, 12);
  });

  it('床: 上端が高いと正、低いと負（寝かせても側面で立てても同じ）', () => {
    expect(slopeOf(upVector(angle(3.4), 0), 'horizontal')).toBeCloseTo(3.4, 9);
    expect(slopeOf(upVector(angle(-6), 0), 'horizontal')).toBeCloseTo(-6, 9);
    // 側面で立てた（画面が横を向いた）端末: gamma = -90°。
    expect(slopeOf(upVector(angle(2), -90), 'horizontal')).toBeCloseTo(2, 9);
  });

  it('壁: 当てた側面の法線（x）の傾き', () => {
    expect(slopeOf(upVector(90 - angle(5), -90), 'vertical')).toBeCloseTo(5, 9);
    expect(slopeOf(upVector(90 - angle(5), 90), 'vertical')).toBeCloseTo(-5, 9);
  });
});

describe('quantizationStep', () => {
  it('異なる値どうしの最小の差', () => {
    expect(quantizationStep([0.3, 0.1, 0.2, 0.1])).toBeCloseTo(0.1, 12);
  });

  it('異なる値が 2 つ無ければ確かめられない', () => {
    expect(quantizationStep([])).toBe(Infinity);
    expect(quantizationStep([1.5, 1.5])).toBe(Infinity);
  });
});

describe('summarize', () => {
  it('平均・ばらつき・刻み・頻度・立ち具合', () => {
    const summary = summarize(samples(floor(4)), 'horizontal');

    expect(summary.count).toBe(120);
    expect(summary.slope).toBeCloseTo(4, 2);
    expect(summary.spread).toBeLessThan(0.01);
    expect(summary.step).toBeLessThan(0.001);
    expect(summary.rate).toBeCloseTo(60, 6);
    expect(summary.upright).toBeCloseTo(0.004, 4);
  });

  it('値が変わらなければ刻みは確かめられず、1 つだけなら頻度は 0', () => {
    const summary = summarize([{ beta: 1, gamma: 2, t: 5 }], 'horizontal');

    expect(summary.step).toBe(Infinity);
    expect(summary.rate).toBe(0);
    expect(summary.spread).toBe(0);
  });
});

describe('formatPerMille / formatStep', () => {
  it('桁をそろえる', () => {
    expect(formatPerMille(3.449)).toBe('3.4');
    expect(formatPerMille(0.123, 2)).toBe('0.12');
  });

  it('刻みは細かすぎれば「0.001 未満」、確かめられなければ「―」', () => {
    expect(formatStep(1e-9)).toBe('0.001 未満');
    expect(formatStep(1.7454)).toBe('1.745');
    expect(formatStep(Infinity)).toBe('―');
  });
});

describe('checkSamples', () => {
  const codes = (result) => result.problems.map((problem) => problem.code);

  it('値が届かなければ測れない', () => {
    const result = checkSamples([], 'horizontal');

    expect(result.summary).toBeNull();
    expect(codes(result)).toEqual(['no-sensor']);
  });

  it('刻みは beta で見る（gamma が動かなくてもよい）', () => {
    const onFloor = samples(floor(3)).map((s) => ({ ...s, gamma: 0 }));
    const onWall = samples(wall(3)).map((s) => ({ ...s, gamma: -90 }));

    expect(checkSamples(onFloor, 'horizontal').problems).toEqual([]);
    expect(checkSamples(onWall, 'vertical').problems).toEqual([]);
  });

  it('センサーの値がそのまま届き、静止していれば使える', () => {
    expect(checkSamples(samples(floor(3)), 'horizontal').problems).toEqual([]);
    expect(checkSamples(samples(wall(3)), 'vertical').problems).toEqual([]);
  });

  it('ブラウザが値を 0.1° に丸めていたら、刻みが粗いと分かる（W3C の仕様案の丸め）', () => {
    // 0.1° の丸めを越えて揺れていても、値は 0.1° の倍数にしかならない。
    const rounded = samples((i) => ({ beta: angle(3) + (i % 3) * 0.05, gamma: (i % 2) * 0.05 })).map((s) => ({
      ...s,
      beta: Math.round(s.beta * 10) / 10,
      gamma: Math.round(s.gamma * 10) / 10,
    }));
    const result = checkSamples(rounded, 'horizontal');

    expect(codes(result)).toEqual(['resolution']);
    expect(result.problems[0].message).toContain('1.745/1000');
  });

  it('値が動かなければ刻みを確かめられないので、使わない', () => {
    const frozen = samples(floor(3)).map((s) => ({ ...s, beta: 0.2 }));

    const result = checkSamples(frozen, 'horizontal');

    expect(codes(result)).toEqual(['resolution']);
    expect(result.problems[0].message).toContain('値がまったく変わらず');
  });

  it('値の届く間隔が広すぎれば測り直し', () => {
    const result = checkSamples(samples(floor(3), MIN_SAMPLES - 1, 10), 'horizontal');

    expect(codes(result)).toEqual(['rate']);
    expect(result.problems[0].message).toContain(`${MIN_SAMPLES - 1} 回`);
    expect(result.problems[0].message).toContain('10 Hz');
  });

  it('壁なのに寝かせたままなら、立てるよう促す', () => {
    const result = checkSamples(samples(floor(3)), 'vertical');

    expect(codes(result)).toEqual(['placement']);
    expect(result.problems[0].message).toContain('縦に立て');
  });

  it('傾きが大きすぎれば置き方の誤り', () => {
    const onWall = checkSamples(samples(wall(150)), 'vertical');
    const onFloor = checkSamples(samples(floor(-150)), 'horizontal');

    expect(codes(onWall)).toEqual(['placement']);
    expect(onWall.problems[0].message).toContain('側面');
    expect(codes(onFloor)).toEqual(['placement']);
    expect(onFloor.problems[0].message).toContain('床に置いて');
  });

  it('測っている間に動けば測り直し', () => {
    const shaky = samples((i) => ({ beta: angle(i % 2 ? 5 : -1), gamma: 0 }));

    expect(codes(checkSamples(shaky, 'horizontal'))).toEqual(['unsteady']);
  });
});

describe('combineReversal', () => {
  it('差の半分が傾き、和の半分がセンサーのずれ', () => {
    // 本当の傾き 3、センサーのずれ 1.5。
    const result = combineReversal(4.5, -1.5);

    expect(result.slope).toBeCloseTo(3, 12);
    expect(result.value).toBeCloseTo(3, 12);
    expect(result.bias).toBeCloseTo(1.5, 12);
    expect(result.lowEnd).toBe('bottom');
    expect(result.problems).toEqual([]);
  });

  it('1 回目の向きで上端が低ければ top、入れる値が 0.0 なら null', () => {
    expect(combineReversal(-2, 2).lowEnd).toBe('top');
    expect(combineReversal(1, 1).lowEnd).toBeNull();
    // 傾き 0.03 は 0.0 と入るので、低い側も示さない。
    expect(combineReversal(0.06, 0).lowEnd).toBeNull();
    expect(combineReversal(-0.06, 0).lowEnd).toBeNull();
  });

  it('ずれが大きすぎれば、2 回目の置き方の誤り', () => {
    const result = combineReversal(MAX_BIAS + 3, MAX_BIAS + 1);

    expect(result.problems.map((problem) => problem.code)).toEqual(['bias']);
    expect(result.problems[0].message).toContain('12.0/1000');
  });
});
