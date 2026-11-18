// 傾きセンサーで測る計算（tilt-logic.js）の単体テスト。
//
// センサーの値は、端末の置き方から合成する（tilt-fixtures.js）。床は画面を
// 上にして寝かせ、壁・柱は縦に持って側面を当てる。

import { describe, expect, it } from 'vitest';
import {
  MAX_BIAS,
  MIN_SAMPLES,
  checkSamples,
  combineReversal,
  formatPerMille,
  formatStep,
  measuredAxis,
  quantizationStep,
  slopeOf,
  summarize,
  upVector,
} from '../src/excel-report-formatter/tilt-logic.js';
import {
  onFloor,
  onFloorFaceDown,
  onWall,
  samples,
} from './tilt-fixtures.js';

const up = ({ beta, gamma }) => upVector(beta, gamma);
const still = (orientation) => () => orientation;

describe('upVector / slopeOf / measuredAxis', () => {
  it('画面を上にして水平に置くと、上は画面の手前（z）', () => {
    const [x, y, z] = upVector(0, 0);
    expect(x).toBeCloseTo(0, 12);
    expect(y).toBeCloseTo(0, 12);
    expect(z).toBeCloseTo(1, 12);
  });

  it('床: 長い辺の傾き。上端が高いと正、低いと負（向きによらない）', () => {
    expect(slopeOf(up(onFloor(0, 3.4)), 'horizontal')).toBeCloseTo(3.4, 9);
    expect(slopeOf(up(onFloor(123, -6)), 'horizontal')).toBeCloseTo(-6, 9);
    // 画面を下にしても、長い辺の傾きは同じ。
    expect(slopeOf(up(onFloorFaceDown(40, 2)), 'horizontal')).toBeCloseTo(2, 9);
  });

  it('壁: 当てた側面の法線の傾き（上端が上でも下でも）', () => {
    expect(slopeOf(up(onWall(30, 5)), 'vertical')).toBeCloseTo(5, 9);
    expect(slopeOf(up(onWall(210, -5, -1)), 'vertical')).toBeCloseTo(-5, 9);
  });

  it('測る軸の地面での向き（床は長い辺、壁は当てた側面の法線）', () => {
    const floor = onFloor(90, 0);
    const [east, north] = measuredAxis(floor.alpha, floor.beta, floor.gamma, 'horizontal');
    expect(east).toBeCloseTo(-1, 9);
    expect(north).toBeCloseTo(0, 9);

    // 縦に持った端末は beta が 90° 近くになる（ちょうど 90° だと alpha と gamma が
    // 定まらないので、少し傾ける）。
    const wall = onWall(90, 2);
    const [wallEast, wallNorth] = measuredAxis(wall.alpha, wall.beta, wall.gamma, 'vertical');
    expect(wallEast).toBeCloseTo(1, 4);
    expect(wallNorth).toBeCloseTo(0, 4);
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
  it('平均・ばらつき・刻み・頻度・上の向き・測る軸の向き', () => {
    const summary = summarize(samples(still(onFloor(0, 4))), 'horizontal');

    expect(summary.count).toBe(120);
    expect(summary.slope).toBeCloseTo(4, 2);
    expect(summary.spread).toBeLessThan(0.01);
    expect(summary.step).toBeLessThan(0.001);
    expect(summary.rate).toBeCloseTo(60, 6);
    expect(summary.up[2]).toBeCloseTo(1, 4);
    expect(summary.heading[0]).toBeCloseTo(0, 4);
    expect(summary.heading[1]).toBeCloseTo(1, 4);
  });

  it('alpha が 1 つも届かなければ、測る軸の向きは分からない。一部欠けても残りから求める', () => {
    const none = summarize(samples(() => ({ ...onFloor(0, 1), alpha: null })), 'horizontal');
    const some = summarize(
      samples((i) => (i === 3 ? { ...onFloor(90, 1), alpha: null } : onFloor(90, 1))),
      'horizontal'
    );

    expect(none.heading).toBeNull();
    expect(some.heading[0]).toBeCloseTo(-1, 4);
  });

  it('値が変わらなければ刻みは確かめられず、1 つだけなら頻度は 0', () => {
    const summary = summarize([{ alpha: 0, beta: 1, gamma: 2, t: 5 }], 'horizontal');

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
  const toTenth = (value) => Math.round(value * 10) / 10;

  it('alpha が届かず向きを確かめられなければ、1 回目から測れない（回し忘れを見逃さない）', () => {
    // 動いてもいるが、測り直しても直らない理由だけを伝える。
    const blind = samples((i) => ({ ...onFloor(0, i % 2 ? 5 : -1), alpha: null }));
    const result = checkSamples(blind, 'horizontal');

    expect(codes(result)).toEqual(['heading']);
    expect(result.problems[0].message).toContain('デジタル水平器');
  });

  it('値が届かなければ測れない', () => {
    const result = checkSamples([], 'horizontal');

    expect(result.summary).toBeNull();
    expect(codes(result)).toEqual(['no-sensor']);
  });

  it('センサーの値がそのまま届き、静止していれば使える', () => {
    expect(checkSamples(samples(still(onFloor(10, 3))), 'horizontal').problems).toEqual([]);
    expect(checkSamples(samples(still(onWall(10, 3))), 'vertical').problems).toEqual([]);
  });

  it('刻みは beta で見る（gamma が動かなくてもよい）', () => {
    const floor = samples(still(onFloor(10, 3))).map((s) => ({ ...s, gamma: 0 }));
    const wall = samples(still(onWall(10, 3))).map((s) => ({ ...s, gamma: -89.8 }));

    expect(checkSamples(floor, 'horizontal').problems).toEqual([]);
    expect(checkSamples(wall, 'vertical').problems).toEqual([]);
  });

  it('ブラウザが値を 0.1° に丸めていたら、刻みが粗いと分かる（W3C の仕様案の丸め）', () => {
    // 0.1° の丸めを越えて揺れていても、値は 0.1° の倍数にしかならない。
    const base = onFloor(0, 3);
    const rounded = samples(
      (i) => ({ ...base, beta: base.beta + (i % 3) * 0.05, gamma: (i % 2) * 0.05 }),
      { round: toTenth }
    );
    const result = checkSamples(rounded, 'horizontal');

    expect(codes(result)).toEqual(['resolution']);
    expect(result.problems[0].message).toContain('1.745/1000');
  });

  it('値が動かなければ刻みを確かめられないので、使わない', () => {
    const frozen = samples(still(onFloor(0, 3))).map((s) => ({ ...s, beta: 0.2 }));
    const result = checkSamples(frozen, 'horizontal');

    expect(codes(result)).toEqual(['resolution']);
    expect(result.problems[0].message).toContain('値がまったく変わらず');
  });

  it('値の届く間隔が広すぎれば測り直し', () => {
    const result = checkSamples(
      samples(still(onFloor(0, 3)), { count: MIN_SAMPLES - 1, hz: 10 }),
      'horizontal'
    );

    expect(codes(result)).toEqual(['rate']);
    expect(result.problems[0].message).toContain(`${MIN_SAMPLES - 1} 回`);
    expect(result.problems[0].message).toContain('10 Hz');
  });

  it('床で画面を下にしていたら、画面を上にするよう促す（出っ張りの傾きが打ち消されない）', () => {
    const result = checkSamples(samples(still(onFloorFaceDown(0, 3))), 'horizontal');

    expect(codes(result)).toEqual(['placement']);
    expect(result.problems[0].message).toContain('画面を上にして');
  });

  it('壁で縦に持っていなければ（床に寝かせたまま）、縦に持つよう促す', () => {
    const result = checkSamples(samples(still(onFloor(0, 3))), 'vertical');

    // 寝かせたままだと、側面の法線の「傾き」が大きく揺れて、ばらつきも出る。
    expect(codes(result)[0]).toBe('placement');
    expect(result.problems[0].message).toContain('縦に持ち');
  });

  it('傾きが大きすぎれば置き方の誤り', () => {
    const wall = checkSamples(samples(still(onWall(0, 150))), 'vertical');
    const floor = checkSamples(samples(still(onFloor(0, -150))), 'horizontal');

    expect(codes(wall)).toEqual(['placement']);
    expect(wall.problems[0].message).toContain('ぴったり');
    expect(codes(floor)).toEqual(['placement']);
    expect(floor.problems[0].message).toContain('床に置いて');
  });

  it('測っている間に動けば測り直し', () => {
    const shaky = samples((i) => onFloor(0, i % 2 ? 5 : -1));

    expect(codes(checkSamples(shaky, 'horizontal'))).toEqual(['unsteady']);
  });
});

describe('combineReversal', () => {
  const read = (orientation, tilt) => summarize(samples(still(orientation)), tilt);
  const codes = (result) => result.problems.map((problem) => problem.code);

  it('床: 180° 回した 2 回。差の半分が傾き、和の半分がずれ（カメラの出っ張りの分も）', () => {
    // 本当の傾き 3（1 回目の向きで上端が高い）、ずれ 15。
    const result = combineReversal(
      read(onFloor(20, 3 + 15), 'horizontal'),
      read(onFloor(200, -3 + 15), 'horizontal'),
      'horizontal'
    );

    expect(result.slope).toBeCloseTo(3, 2);
    expect(result.value).toBeCloseTo(3, 2);
    expect(result.bias).toBeCloseTo(15, 2);
    expect(result.lowEnd).toBe('bottom');
    expect(result.problems).toEqual([]);
  });

  it('床: 1 回目の向きで上端が低ければ top、入れる値が 0.0 なら null', () => {
    const top = combineReversal(
      read(onFloor(0, -2), 'horizontal'),
      read(onFloor(180, 2), 'horizontal'),
      'horizontal'
    );
    // 傾き 0.03 は 0.0 と入るので、低い側も示さない。
    const flat = combineReversal(
      read(onFloor(0, 1.03), 'horizontal'),
      read(onFloor(180, 0.97), 'horizontal'),
      'horizontal'
    );

    expect(top.lowEnd).toBe('top');
    expect(flat.lowEnd).toBeNull();
  });

  it('壁: 側面を当て、反対側の側面を当てる。ずれが打ち消され、低い側は出さない', () => {
    // 本当の傾き 4、センサーのずれ 2。
    const result = combineReversal(
      read(onWall(60, 4 + 2), 'vertical'),
      read(onWall(240, -4 + 2), 'vertical'),
      'vertical'
    );

    expect(result.value).toBeCloseTo(4, 2);
    expect(result.bias).toBeCloseTo(2, 2);
    expect(result.lowEnd).toBeNull();
    expect(result.problems).toEqual([]);
  });

  it('回し忘れ・回し方の誤りは、測る軸の向きで分かる', () => {
    const notTurned = combineReversal(
      read(onFloor(0, 3), 'horizontal'),
      read(onFloor(5, 3), 'horizontal'),
      'horizontal'
    );
    // 壁で、同じ側面のまま上下を逆さにした（当てた側面の法線は同じ向き）。
    const spun = combineReversal(
      read(onWall(0, 3), 'vertical'),
      read(onWall(0, 3, -1), 'vertical'),
      'vertical'
    );

    expect(codes(notTurned)).toEqual(['turn']);
    expect(notTurned.problems[0].message).toContain('180° 回して');
    expect(codes(spun)).toEqual(['turn']);
    expect(spun.problems[0].message).toContain('反対側の側面');
  });


  it('ずれが大きすぎれば置き直し', () => {
    const limit = MAX_BIAS.horizontal;
    const result = combineReversal(
      read(onFloor(0, limit + 5), 'horizontal'),
      read(onFloor(180, limit + 1), 'horizontal'),
      'horizontal'
    );

    expect(codes(result)).toEqual(['bias']);
    expect(result.problems[0].message).toContain(`${formatPerMille(limit + 3)}/1000`);
  });

  it('ずれの上限は、出っ張りの効かない壁・柱のほうが狭い', () => {
    expect(MAX_BIAS.vertical).toBeLessThan(MAX_BIAS.horizontal);
    const bias = MAX_BIAS.vertical + 2;
    const result = combineReversal(
      read(onWall(0, 1 + bias), 'vertical'),
      read(onWall(180, -1 + bias), 'vertical'),
      'vertical'
    );

    expect(codes(result)).toEqual(['bias']);
  });
});
