// 端末の傾きセンサーで水平器の計測値（1000 分率）を測るための、純粋な計算
// （DOM・センサーに触らない）。センサーの読み取りと画面は tilt-meter.js。
//
// 値はブラウザの deviceorientation イベントの beta / gamma（度）から求める。
// 加速度（devicemotion）ではなく向きを使うのは、
//   - 符号の決まりが端末によらない（iOS の加速度は W3C の仕様と符号が逆）
//   - W3C の仕様案が求める丸め（向き 0.1°・加速度 0.1 m/s²）を Safari が実装
//     したときに、向きのほうが細かい（0.1° ≈ 1.7/1000。加速度は約 10/1000）
// から。どちらにしても丸められると測れなくなるので、測るたびに「値の刻み」を
// 実測して確かめる（checkSamples の 'resolution'。README の
// 「端末の傾きセンサーで測る」）。

/** 測る前に待つ時間（ms）。ボタンを押した指を離し、揺れが収まるのを待つ。 */
export const SETTLE_MS = 1000;
/** 1 回の計測で値を集める時間（ms）。 */
export const MEASURE_MS = 2000;
/**
 * 1 回の計測に要る値の数。Safari は 60 Hz で届けるので 2 秒で約 120。
 * ブラウザが届ける間隔を大きく間引いた（15 Hz 未満）ら、測り直しを求める。
 */
export const MIN_SAMPLES = 30;
/**
 * センサー値の刻み（1000 分率）の上限。検査会社のマニュアルの中で最も細かい
 * 「勾配(%)を小数点第 2 位まで表示する水平器」（＝0.1/1000）に合わせる。
 */
export const MAX_STEP = 0.1;
/** 1 回の計測の中のばらつき（標準偏差・1000 分率）の上限。超えたら動いている。 */
export const MAX_SPREAD = 1;
/** 置き方の確かめ: 測る軸の傾きがこれ（1000 分率。約 5.7°）を超えたら置き方の誤り。 */
export const MAX_PLACEMENT = 100;
/**
 * 鉛直を測るときに、端末の長い辺が鉛直からどこまで寝ていてよいか（上向きの
 * 成分の大きさの下限。0.7 ≈ 45°）。床に寝かせたまま壁を測るのを防ぐ。
 */
export const MIN_UPRIGHT = 0.7;
/**
 * 2 回の読みから求めたセンサーのずれ（1000 分率）の上限。これを超えるのは、
 * 2 回目を同じ場所・逆向きに置けていないとき。
 */
export const MAX_BIAS = 10;

const RAD = Math.PI / 180;

/** combineReversal の lowEnd を、画面で言うときの名前。 */
export const LOW_END = { top: '上端', bottom: '下端' };

/**
 * beta / gamma（度）から、端末の座標系で見た「上」の単位ベクトル。
 *
 * 端末の座標系は x が画面の右、y が画面の上、z が画面の手前（W3C の
 * Device Orientation の決まり）。向きは Z-X'-Y'' の順の回転で、
 * 上 = Ry(-γ)·Rx(-β)·(0, 0, 1)。
 *
 * @param {number} beta
 * @param {number} gamma
 * @return {number[]} [x, y, z]
 */
export function upVector(beta, gamma) {
  const b = beta * RAD;
  const g = gamma * RAD;
  return [-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)];
}

/**
 * 「上」のベクトルから、測る軸の傾き（1000 分率。正なら測る軸の正の向きが高い）。
 *
 *   horizontal（床）… 長い辺（y）の水平からの傾き。画面を上にして寝かせても、
 *                     側面で立てても同じ値になる。正なら端末の上端が高い。
 *   vertical（壁・柱）… 当てた側面の法線（x）の水平からの傾き。側面を壁に
 *                     ぴったり当てていれば、これが壁の鉛直からの傾きになる。
 *
 * @param {number[]} up upVector の値
 * @param {'horizontal'|'vertical'} tilt
 * @return {number}
 */
export function slopeOf(up, tilt) {
  const [x, y, z] = up;
  if (tilt === 'vertical') return (1000 * x) / Math.hypot(y, z);
  return (1000 * y) / Math.hypot(x, z);
}

/**
 * 値の刻み: 異なる値どうしの差のうち最も小さいもの。異なる値が 2 つ無ければ
 * Infinity（刻みを確かめられない）。
 *
 * センサーの値がそのまま届いていれば、静止していても値はわずかずつ違い、
 * 差は 0.001° よりずっと小さい。ブラウザが 0.1° に丸めていれば、差は 0.1° の
 * 倍数になる。
 *
 * @param {number[]} values
 * @return {number}
 */
export function quantizationStep(values) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < sorted.length; i++) step = Math.min(step, sorted[i] - sorted[i - 1]);
  return step;
}

/**
 * 1 回の計測で集めた値をまとめる。
 *
 * @param {{beta: number, gamma: number, t: number}[]} samples 集めた値（t は ms）。1 つ以上。
 * @param {'horizontal'|'vertical'} tilt
 * @return {{count: number, slope: number, spread: number, step: number,
 *           rate: number, upright: number}}
 *   slope は平均（1000 分率）、spread は標準偏差、step は値の刻みを 1000 分率に
 *   直したもの、rate は値の届いた頻度（Hz）、upright は「上」の y 成分の大きさ。
 */
export function summarize(samples, tilt) {
  const count = samples.length;
  const ups = samples.map((s) => upVector(s.beta, s.gamma));
  const slopes = ups.map((up) => slopeOf(up, tilt));
  const slope = slopes.reduce((sum, v) => sum + v, 0) / count;
  const spread = Math.sqrt(slopes.reduce((sum, v) => sum + (v - slope) ** 2, 0) / count);
  // 刻みは beta で見る。どの置き方でも、測る傾きを決めるのは beta だから
  // （床は y = sin β。壁は端末が立っていて x = -cos β·sin γ の cos β が傾きの
  // 大きさで、gamma の刻みは cos β 倍に縮む）。gamma は縦に立てると ±90° の
  // 境で値が定まらず、刻みを測る役に立たない。ブラウザの丸めは beta・gamma
  // どちらにも掛かるので、beta だけで分かる。
  const angleStep = quantizationStep(samples.map((s) => s.beta));
  // 角度の刻み Δ は、傾きでは 1000·tan(Δ) の刻みになる（傾きの小さい範囲）。
  const step = angleStep < 90 ? 1000 * Math.tan(angleStep * RAD) : Infinity;
  const duration = (samples[count - 1].t - samples[0].t) / 1000;
  const rate = duration > 0 ? (count - 1) / duration : 0;
  const upright = Math.abs(ups.reduce((sum, up) => sum + up[1], 0) / count);
  return { count, slope, spread, step, rate, upright };
}

/** 1000 分率を小数点以下 digits 桁の文字列にする。 */
export function formatPerMille(value, digits = 1) {
  return value.toFixed(digits);
}

/** 値の刻みを読める形にする（0.001 未満は「0.001 未満」、確かめられなければ「―」）。 */
export function formatStep(step) {
  if (!Number.isFinite(step)) return '―';
  return step < 0.001 ? '0.001 未満' : formatPerMille(step, 3);
}

/**
 * 1 回の計測が使えるかを確かめ、使えない理由を並べる（使えるなら空）。
 *
 * 'resolution' はブラウザが値を丸めている（＝iOS の更新などで精度が落ちた）
 * ことを表す。測り直しても直らないので、画面はデジタル水平器を使うよう促す。
 *
 * @param {{beta: number, gamma: number, t: number}[]} samples
 * @param {'horizontal'|'vertical'} tilt
 * @return {{summary: object|null, problems: {code: string, message: string}[]}}
 */
export function checkSamples(samples, tilt) {
  if (samples.length === 0) {
    return {
      summary: null,
      problems: [
        {
          code: 'no-sensor',
          message:
            '傾きセンサーの値が届きません。この端末・ブラウザでは測れないか、センサーの利用が許可されていません。',
        },
      ],
    };
  }
  const summary = summarize(samples, tilt);
  const problems = [];
  if (summary.count < MIN_SAMPLES) {
    problems.push({
      code: 'rate',
      message:
        `センサーの値が ${summary.count} 回しか届きませんでした（${Math.round(summary.rate)} Hz）。` +
        'ブラウザが値の届く間隔を広げた可能性があります。',
    });
  }
  if (summary.step > MAX_STEP) {
    const found = Number.isFinite(summary.step)
      ? `ブラウザが届けるセンサーの値の刻みが ${formatStep(summary.step)}/1000 と粗く、` +
        `必要な ${MAX_STEP}/1000 に足りません。`
      : 'ブラウザが届けるセンサーの値がまったく変わらず、値の刻みを確かめられません。';
    problems.push({
      code: 'resolution',
      message:
        found +
        'iOS やブラウザの更新で精度が下がった可能性があります。' +
        'この端末では測れないので、デジタル水平器で測ってください。',
    });
  }
  if (tilt === 'vertical' && summary.upright < MIN_UPRIGHT) {
    problems.push({
      code: 'placement',
      message: 'スマートフォンを縦に立て、側面を壁・柱に当ててください。',
    });
  } else if (Math.abs(summary.slope) > MAX_PLACEMENT) {
    problems.push({
      code: 'placement',
      message:
        tilt === 'vertical'
          ? '側面が壁・柱にぴったり当たっていないようです（傾きが大きすぎます）。'
          : '長い辺を測る方向に合わせて、床に置いてください（傾きが大きすぎます）。',
    });
  }
  if (summary.spread > MAX_SPREAD) {
    problems.push({
      code: 'unsteady',
      message: '測っている間に動きました。手を離して（または押さえたまま動かさずに）測り直してください。',
    });
  }
  return { summary, problems };
}

/**
 * 反転法: 同じ場所で 180° 回した 2 回の読みから、傾きとセンサーのずれを求める。
 *
 * センサーのずれ（ゼロ点）は端末に付いて回るので、1 回目は「傾き + ずれ」、
 * 2 回目は「-傾き + ずれ」になる。差の半分が傾き、和の半分がずれ。
 *
 * @param {number} first 1 回目の slope
 * @param {number} second 2 回目の slope
 * @return {{slope: number, value: number, bias: number, lowEnd: 'top'|'bottom'|null,
 *           problems: {code: string, message: string}[]}}
 *   slope は 1 回目の向きでの傾き（正なら端末の上端が高い）、value はその大きさ、
 *   lowEnd は 1 回目の向きで低い側の端（床のとき。小数点以下 1 桁で 0.0 なら null）。
 */
export function combineReversal(first, second) {
  const slope = (first - second) / 2;
  const bias = (first + second) / 2;
  const problems = [];
  if (Math.abs(bias) > MAX_BIAS) {
    problems.push({
      code: 'bias',
      message:
        `2 回の読みが合いません（センサーのずれが ${formatPerMille(bias)}/1000）。` +
        '2 回目は同じ場所で、向きをちょうど 180° 回して置いてください。',
    });
  }
  // 低い側は、入れる値（小数点以下 1 桁）が 0.0 でないときだけ示す。
  let lowEnd = null;
  if (formatPerMille(Math.abs(slope)) !== '0.0') lowEnd = slope > 0 ? 'bottom' : 'top';
  return { slope, value: Math.abs(slope), bias, lowEnd, problems };
}
