// 傾きセンサーのテストで使う、合成した端末の向き（tilt-logic / tilt-meter のテスト）。
//
// 端末の置き方（各軸が地面の座標系でどちらを向くか）から、deviceorientation
// の alpha / beta / gamma を作る。端末の座標系は x が画面の右、y が画面の上、
// z が画面の手前。地面の座標系は [東, 北, 上]。R = Rz(α)·Rx(β)·Ry(γ) の列が
// 端末の各軸の向きなので、R から角度を逆に解く。

const DEG = 180 / Math.PI;

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** 端末の x・y・z 軸の地面での向きから、alpha / beta / gamma（度）。 */
export function orientationOf(x, y, z) {
  // R[i][j] = 軸 j の成分 i。
  const R = [0, 1, 2].map((i) => [x[i], y[i], z[i]]);
  return {
    alpha: Math.atan2(-R[0][1], R[1][1]) * DEG,
    beta: Math.asin(R[2][1]) * DEG,
    gamma: Math.atan2(-R[2][0], R[2][2]) * DEG,
  };
}

/** 1000 分率の傾きを、ラジアンの角度にする。 */
const angle = (perMille) => Math.atan(perMille / 1000);

/**
 * 床に画面を上にして置いた端末。長い辺（y）が方位 heading（度）を向き、
 * 上端が slope（1000 分率）だけ高い。
 */
export function onFloor(heading, slope) {
  const h = heading / DEG;
  const t = angle(slope);
  const y = [-Math.sin(h) * Math.cos(t), Math.cos(h) * Math.cos(t), Math.sin(t)];
  const z = [Math.sin(h) * Math.sin(t), -Math.cos(h) * Math.sin(t), Math.cos(t)];
  return orientationOf(cross(y, z), y, z);
}

/**
 * 床で、画面を下にして（裏返して）置いた端末。長い辺の向きと傾きは onFloor と同じ。
 */
export function onFloorFaceDown(heading, slope) {
  const h = heading / DEG;
  const t = angle(slope);
  const y = [-Math.sin(h) * Math.cos(t), Math.cos(h) * Math.cos(t), Math.sin(t)];
  const z = [-Math.sin(h) * Math.sin(t), Math.cos(h) * Math.sin(t), -Math.cos(t)];
  return orientationOf(cross(y, z), y, z);
}

/**
 * 縦に持って側面を壁に当てた端末。当てた側面の法線（x）が方位 heading（度）を
 * 向き、水平から lean（1000 分率）だけ上を向く。yUp が正なら上端が上。
 */
export function onWall(heading, lean, yUp = 1) {
  const h = heading / DEG;
  const e = angle(lean);
  const x = [Math.cos(e) * Math.sin(h), Math.cos(e) * Math.cos(h), Math.sin(e)];
  const y = [
    -yUp * Math.sin(e) * Math.sin(h),
    -yUp * Math.sin(e) * Math.cos(h),
    yUp * Math.cos(e),
  ];
  return orientationOf(x, y, cross(x, y));
}

/**
 * 合成した計測値。センサーの値がそのまま届いているときのように、静止して
 * いても値がわずかずつ違う（0.0001° 未満の揺れ）。round を渡すと、ブラウザが
 * する丸めを通す。
 *
 * @param {(i: number) => {alpha: number|null, beta: number, gamma: number}} at i 番目の向き
 */
export function samples(at, { count = 120, hz = 60, round = (value) => value } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const jitter = ((i * 7919) % 101) * 1e-6;
    const { alpha, beta, gamma } = at(i);
    return {
      alpha: alpha === null ? null : round(alpha + jitter),
      beta: round(beta + jitter),
      gamma: round(gamma - jitter),
      t: 1000 + (i * 1000) / hz,
    };
  });
}
