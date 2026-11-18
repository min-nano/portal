// 端末の傾きセンサーで水平器の計測値（1000 分率）を測るための、純粋な計算
// （DOM・センサーに触らない）。センサーの読み取りと画面は tilt-meter.js。
//
// 値はブラウザの deviceorientation イベントの alpha / beta / gamma（度）から
// 求める。加速度（devicemotion）ではなく向きを使うのは、
//   - 符号の決まりが端末によらない（iOS の加速度は W3C の仕様と符号が逆）
//   - W3C の仕様案が求める丸め（向き 0.1°・加速度 0.1 m/s²）を Safari が実装
//     したときに、向きのほうが細かい（0.1° ≈ 1.7/1000。加速度は約 10/1000）
// から。どちらにしても丸められると測れなくなるので、測るたびに「値の刻み」を
// 実測して確かめる（checkSamples の 'resolution'。README の
// 「端末の傾きセンサーで測る」）。
//
// 置き方:
//   horizontal（床）… 画面を上にして床に寝かせ、長い辺（y）の傾きを測る
//       （立てて置くのは難しいため）。2 回目は画面を上にしたまま 180° 回す。
//       カメラの出っ張りで端末が傾いても、その傾きは端末に付いて回るので、
//       センサーのずれと一緒に打ち消される。
//   vertical（壁・柱）… 手で縦に持ち、平らな側面（長い辺）を当てて、側面の
//       法線（x）の傾きを測る。2 回目は反対側の側面を当てる（x が逆を向くので、
//       センサーのずれが打ち消される）。背面を当てると、カメラの出っ張りで
//       傾いた分が打ち消されないので使わない。

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
 * 置き方の確かめ: 上に向けるはずの軸（床は画面の法線 z、壁・柱は長い辺 y）の、
 * 上向きの成分の下限（0.7 ≈ 45°。壁・柱は上下どちら向きでもよい）。床では
 * 画面を下にして置く（カメラの出っ張りの傾きが打ち消されない）・立てて置く
 * のを、壁・柱では床に寝かせたまま測るのを防ぐ。
 */
export const MIN_FACING = 0.7;
/**
 * 2 回の読みから求めたずれ（1000 分率）の上限。床ではカメラの出っ張りに
 * よる傾き（iPhone で 15/1000 前後）もここに入るので広くとる。壁・柱は
 * 側面を当てるので出っ張りが効かず、センサーのずれだけを見込む。これを
 * 超えるのは、2 回目を同じ場所に置けていないとき。
 */
export const MAX_BIAS = { horizontal: 30, vertical: 10 };
/**
 * 2 回目を逆向きに置けたかの確かめ: 測る軸の水平な向きどうしの内積の上限
 * （-0.9 ≈ 180° から ±25° 以内）。
 */
export const MAX_TURN_DOT = -0.9;

const RAD = Math.PI / 180;

/** combineReversal の lowEnd を、画面で言うときの名前。 */
export const LOW_END = { top: '上端', bottom: '下端' };

/**
 * 端末の座標系で見た「上」の単位ベクトル。
 *
 * 端末の座標系は x が画面の右、y が画面の上、z が画面の手前（W3C の
 * Device Orientation の決まり）。向きは Z-X'-Y'' の順の回転 R = Rz(α)·Rx(β)·Ry(γ)
 * で、上は R の 3 行目 = Ry(-γ)·Rx(-β)·(0, 0, 1)。
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
 * 測る軸（床は y、壁・柱は x）が地面の座標系で向いている向き（R の列）。
 * alpha は端末ごとの任意の向きが基準で、センサーを聞き始めるたびに変わり
 * うる。測る画面は開いている間ずっと聞き続ける（tilt-meter.js の
 * listenOrientation）ので、1 回目と 2 回目の向きを比べられる。
 *
 * @param {number} alpha
 * @param {number} beta
 * @param {number} gamma
 * @param {'horizontal'|'vertical'} tilt
 * @return {number[]} [東西, 南北, 上下] の向きの単位ベクトル
 */
export function measuredAxis(alpha, beta, gamma, tilt) {
  const [ca, sa] = [Math.cos(alpha * RAD), Math.sin(alpha * RAD)];
  const [cb, sb] = [Math.cos(beta * RAD), Math.sin(beta * RAD)];
  const [cg, sg] = [Math.cos(gamma * RAD), Math.sin(gamma * RAD)];
  if (tilt === 'vertical') {
    return [ca * cg - sa * sb * sg, sa * cg + ca * sb * sg, -cb * sg];
  }
  return [-sa * cb, ca * cb, sb];
}

/**
 * 「上」のベクトルから、測る軸の傾き（1000 分率。正なら測る軸の正の向きが高い）。
 *
 *   horizontal（床）… 長い辺（y）の水平からの傾き（画面を上にして寝かせる）。
 *                     正なら端末の上端が高い。
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

/** ベクトルの和を、長さ 1 にそろえる（向きの平均）。 */
function meanDirection(vectors) {
  const sum = vectors.reduce((acc, v) => acc.map((value, i) => value + v[i]));
  const length = Math.hypot(...sum);
  return sum.map((value) => value / length);
}

/**
 * 1 回の計測で集めた値をまとめる。
 *
 * @param {{alpha: number|null, beta: number, gamma: number, t: number}[]} samples
 *   集めた値（t は ms）。1 つ以上。
 * @param {'horizontal'|'vertical'} tilt
 * @return {{count: number, slope: number, spread: number, step: number,
 *           rate: number, up: number[], heading: number[]|null}}
 *   slope は平均（1000 分率）、spread は標準偏差、step は値の刻みを 1000 分率に
 *   直したもの、rate は値の届いた頻度（Hz）、up は「上」の向きの平均、heading は
 *   測る軸の水平な向き（[東西, 南北] の単位ベクトル。alpha が 1 つも届かなければ null）。
 */
export function summarize(samples, tilt) {
  const count = samples.length;
  const ups = samples.map((s) => upVector(s.beta, s.gamma));
  const slopes = ups.map((up) => slopeOf(up, tilt));
  const slope = slopes.reduce((sum, v) => sum + v, 0) / count;
  const spread = Math.sqrt(slopes.reduce((sum, v) => sum + (v - slope) ** 2, 0) / count);
  // 刻みは beta で見る。どちらの置き方でも、測る傾きを決めるのは beta だから
  // （床は傾き = tan β で gamma によらない。壁・柱は端末が立っていて
  // x = -cos β·sin γ の cos β が傾きの大きさで、gamma の刻みは cos β 倍に
  // 縮む）。gamma は縦に立てると ±90° の境に来て値が定まらない。
  const angleStep = quantizationStep(samples.map((s) => s.beta));
  // 角度の刻み Δ は、傾きでは 1000·tan(Δ) の刻みになる（傾きの小さい範囲）。
  const step = angleStep < 90 ? 1000 * Math.tan(angleStep * RAD) : Infinity;
  const duration = (samples[count - 1].t - samples[0].t) / 1000;
  const rate = duration > 0 ? (count - 1) / duration : 0;
  // alpha の欠けた値があっても、届いたものから向きを求める。
  const withAlpha = samples.filter((s) => Number.isFinite(s.alpha));
  const heading = withAlpha.length
    ? meanDirection(withAlpha.map((s) => measuredAxis(s.alpha, s.beta, s.gamma, tilt).slice(0, 2)))
    : null;
  return { count, slope, spread, step, rate, up: meanDirection(ups), heading };
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

/** 測り直しても直らない（この端末・ブラウザでは測れない）理由。 */
const FATAL = new Set(['heading', 'resolution']);

/**
 * 1 回の計測が使えるかを確かめ、使えない理由を並べる（使えるなら空）。
 *
 * 'resolution' はブラウザが値を丸めている（＝iOS の更新などで精度が落ちた）
 * ことを表す。測り直しても直らないので、画面はデジタル水平器を使うよう促す。
 *
 * @param {{alpha: number|null, beta: number, gamma: number, t: number}[]} samples
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
  if (!summary.heading) {
    // 回し忘れると傾きがほぼ 0 に出て、ずれの上限では見つからないことがある
    // ので、2 回目を逆向きに置いたかを確かめられないときは測らない。
    problems.push({
      code: 'heading',
      message:
        'このブラウザは端末の向き（方位）を届けないので、2 回目を逆向きに置いたかを確かめられません。' +
        'デジタル水平器で測ってください。',
    });
  }
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
  if (tilt === 'vertical' && Math.abs(summary.up[1]) < MIN_FACING) {
    problems.push({
      code: 'placement',
      message: 'スマートフォンを縦に持ち、側面（長い辺）を壁・柱に当ててください。',
    });
  } else if (tilt === 'horizontal' && summary.up[2] < MIN_FACING) {
    problems.push({
      code: 'placement',
      message: '画面を上にして、床に寝かせて置いてください。',
    });
  } else if (Math.abs(summary.slope) > MAX_PLACEMENT) {
    problems.push({
      code: 'placement',
      message:
        tilt === 'vertical'
          ? '側面が壁・柱にぴったり当たっていないようです（傾きが大きすぎます）。'
          : '画面を上にして、長い辺を測る方向に合わせて床に置いてください（傾きが大きすぎます）。',
    });
  }
  if (summary.spread > MAX_SPREAD) {
    problems.push({
      code: 'unsteady',
      message: '測っている間に動きました。手を離して（または押さえたまま動かさずに）測り直してください。',
    });
  }
  // 測り直しても直らない理由があれば、それだけを伝える（測り直しを促す理由と
  // 並べると、どちらに従えばよいか分からない）。
  const fatal = problems.filter((problem) => FATAL.has(problem.code));
  return { summary, problems: fatal.length > 0 ? fatal : problems };
}

/**
 * 反転法: 同じ場所で逆向きに置いた 2 回の読みから、傾きとずれを求める。
 *
 * センサーのずれ（ゼロ点）と、カメラの出っ張りなどで端末が傾く分は端末に
 * 付いて回るので、1 回目は「傾き + ずれ」、2 回目は「-傾き + ずれ」になる。
 * 差の半分が傾き、和の半分がずれ。
 *
 * 2 回目の置き方も確かめる: 測る軸の水平な向きが、1 回目のほぼ逆を向いて
 * いること。回し忘れ・回し方の誤りを見つける。向き（heading）があること
 * と、床で同じ面（画面を上）にしていることは、checkSamples が 1 回ごとに
 * 確かめる。
 *
 * @param {ReturnType<typeof summarize>} first 1 回目
 * @param {ReturnType<typeof summarize>} second 2 回目
 * @param {'horizontal'|'vertical'} tilt
 * @return {{slope: number, value: number, bias: number, lowEnd: 'top'|'bottom'|null,
 *           problems: {code: string, message: string}[]}}
 *   slope は 1 回目の向きでの傾き（床なら正で端末の上端が高い）、value はその大きさ、
 *   lowEnd は床のときの 1 回目の向きで低い側の端（壁・柱と、小数点以下 1 桁で 0.0 なら null）。
 */
export function combineReversal(first, second, tilt) {
  const slope = (first.slope - second.slope) / 2;
  const bias = (first.slope + second.slope) / 2;
  const problems = [];
  const dot = first.heading[0] * second.heading[0] + first.heading[1] * second.heading[1];
  if (dot > MAX_TURN_DOT) {
    problems.push({
      code: 'turn',
      message:
        tilt === 'vertical'
          ? '2 回目の向きが違います。同じ場所で、反対側の側面を当ててください。'
          : '2 回目の向きが違います。同じ場所で、向きをちょうど 180° 回して置いてください。',
    });
  } else if (Math.abs(bias) > MAX_BIAS[tilt]) {
    problems.push({
      code: 'bias',
      message:
        `2 回の読みが合いません（ずれが ${formatPerMille(bias)}/1000）。` +
        '2 回目は同じ場所に置いてください。',
    });
  }
  // 低い側は、床で入れる値（小数点以下 1 桁）が 0.0 でないときだけ示す。
  let lowEnd = null;
  if (tilt === 'horizontal' && formatPerMille(Math.abs(slope)) !== '0.0') {
    lowEnd = slope > 0 ? 'bottom' : 'top';
  }
  return { slope, value: Math.abs(slope), bias, lowEnd, problems };
}
