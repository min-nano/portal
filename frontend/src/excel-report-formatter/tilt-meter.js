// 端末の傾きセンサーで、水平器の計測値（1000 分率）を測る画面。
//
// 計測点の行の「測る」ボタンから開く。反転法で 2 回測る（1 回目のあと、同じ
// 場所で 180° 回して 2 回目）。2 回の差の半分が傾き、和の半分がセンサーの
// ずれなので、端末ごとのゼロ点のずれが結果に残らない。計算は tilt-logic.js。
//
// 測るたびに、ブラウザが届ける値の刻み・届く頻度・ばらつきを確かめ、足りな
// ければ値を入れさせない。Safari が W3C の仕様案どおりに値を丸めるように
// なったときは、ここで「値の刻みが粗い」と分かる（README の
// 「端末の傾きセンサーで測る」）。
//
// 画面はここで組み立てて <body> に足し、閉じたら捨てる。

import { el } from '../components/form-field.js';
import {
  LOW_END,
  MEASURE_MS,
  SETTLE_MS,
  checkSamples,
  combineReversal,
  formatPerMille,
  formatStep,
} from './tilt-logic.js';

/**
 * この端末で「測る」ボタンを出すか。傾きのイベントがあり、主な操作が指
 * （pointer: coarse）の端末であること。
 *
 * パソコンのブラウザにも DeviceOrientationEvent はあるが、センサーが無く
 * 値が届かないので出さない（タッチパネルのノートパソコンも、主な操作は
 * マウスなので pointer: fine）。
 *
 * @param {Window} win
 * @return {boolean}
 */
export function canMeasureTilt(win) {
  return (
    typeof win.DeviceOrientationEvent === 'function' &&
    win.matchMedia('(pointer: coarse)').matches
  );
}

/**
 * センサーを使う許可を求める。iOS（13 以降）は、利用者の操作（タップ）を
 * 受けてから DeviceOrientationEvent.requestPermission() を呼ぶ必要がある。
 * それ以外のブラウザには無いので、そのまま使える。
 *
 * @param {Window} win
 * @return {Promise<boolean>} 許可されたか
 */
export async function requestTiltPermission(win) {
  const Event = win.DeviceOrientationEvent;
  if (typeof Event.requestPermission !== 'function') return true;
  return (await Event.requestPermission()) === 'granted';
}

/**
 * 少し待ってから、ms のあいだ beta / gamma を集める。
 *
 * @param {Window} win
 * @param {number} ms
 * @return {Promise<{beta: number, gamma: number, t: number}[]>}
 */
export function collectSamples(win, ms) {
  return new Promise((resolve) => {
    const samples = [];
    const onEvent = (event) => {
      if (event.beta === null || event.gamma === null) return;
      samples.push({ beta: event.beta, gamma: event.gamma, t: event.timeStamp });
    };
    setTimeout(() => {
      win.addEventListener('deviceorientation', onEvent);
      setTimeout(() => {
        win.removeEventListener('deviceorientation', onEvent);
        resolve(samples);
      }, ms);
    }, SETTLE_MS);
  });
}

const HOWTO = {
  horizontal: [
    '長い辺を測る方向に合わせて、スマートフォンを床に置きます。ケースは外し、カメラの出っ張りで傾かないよう、側面で立てるか平らな板の上に置いてください。',
    '同じ場所で、向きを 180° 回して（上端と下端を入れ替えて）置き直します。',
  ],
  vertical: [
    'スマートフォンを縦に立て、側面（長い辺）を壁・柱にぴったり当てます。',
    '同じ場所で、反対側の側面を当てて置き直します（画面が逆を向きます）。',
  ],
};

/**
 * 結果の説明。床なら、1 回目の向きでどちらの端が低いかを添える。
 *
 * @param {ReturnType<typeof combineReversal>} result
 * @param {'horizontal'|'vertical'} tilt
 */
function describeResult(result, tilt) {
  const value = formatPerMille(result.value);
  const percent = (result.value / 10).toFixed(2);
  let text = `傾き ${value}/1000（${percent}%）`;
  if (tilt === 'horizontal') {
    text += result.lowEnd
      ? `。1 回目に置いた向きで、スマートフォンの${LOW_END[result.lowEnd]}の側が低くなっています。`
      : '。傾きはありません。';
  }
  return text;
}

/** 1 回の計測の確かめに使った値（値の刻み・頻度・ばらつき）。精度の点検の記録として見せる。 */
function describeSummary(summary) {
  return (
    `値の刻み ${formatStep(summary.step)}/1000・` +
    `ばらつき ${formatPerMille(summary.spread, 2)}/1000・` +
    `${Math.round(summary.rate)} Hz`
  );
}

/**
 * 傾きを測る画面を開く。
 *
 * @param {object} options
 * @param {Document} options.doc
 * @param {'horizontal'|'vertical'} options.tilt 測る基準（mapping.json の tilt）
 * @param {string} options.title 見出し（例: 「床 X方向」）
 * @return {Promise<{value: string, lowEnd: 'top'|'bottom'|null}|null>}
 *   入れる値（1000 分率・小数点以下 1 桁）と、床なら 1 回目の向きで低い側の端
 *   （壁・柱と、傾きが 0.0 のときは null）。やめたら null。
 */
export function openTiltMeter({ doc, tilt, title }) {
  const win = doc.defaultView;
  const dialog = el(doc, 'dialog', 'app-dialog tilt-meter');
  dialog.setAttribute('aria-label', `${title}を測る`);
  const heading = el(doc, 'h3', null, `${title}を測る`);
  const howto = el(doc, 'p', 'tilt-meter-howto');
  const readings = el(doc, 'ol', 'tilt-meter-readings');
  const status = el(doc, 'p', 'tilt-meter-status');
  status.setAttribute('aria-live', 'polite');
  const error = el(doc, 'p', 'dialog-error');
  const actions = el(doc, 'div', 'dialog-actions');
  const go = el(doc, 'button', 'tilt-meter-go');
  const redo = el(doc, 'button', 'secondary tilt-meter-redo', '最初から');
  const cancel = el(doc, 'button', 'secondary tilt-meter-cancel', 'やめる');
  [go, redo, cancel].forEach((button) => {
    button.type = 'button';
  });
  actions.append(go, redo, cancel);
  dialog.append(heading, howto, readings, status, error, actions);
  doc.body.append(dialog);

  // 1 回目・2 回目の slope と、確定した結果。
  let firstSlope = null;
  let result = null;
  // 測り直し・閉じるたびに増える番号。測っている途中で「最初から」や
  // 「やめる」を押したら、その計測の結果は捨てる。
  let generation = 0;

  const show = () => {
    const step = firstSlope === null ? 0 : 1;
    howto.textContent = result ? describeResult(result, tilt) : HOWTO[tilt][step];
    go.textContent = result ? `${formatPerMille(result.value)} を入れる` : `${step + 1} 回目を測る`;
    redo.hidden = firstSlope === null && !result;
  };

  const addReading = (label, summary) => {
    readings.append(
      el(doc, 'li', null, `${label}: ${formatPerMille(summary.slope)}/1000（${describeSummary(summary)}）`)
    );
  };

  const reset = () => {
    generation += 1;
    firstSlope = null;
    result = null;
    readings.replaceChildren();
    status.textContent = '';
    error.textContent = '';
    show();
  };

  const measure = async () => {
    const current = generation;
    const stale = () => current !== generation;
    error.textContent = '';
    go.disabled = true;
    try {
      const granted = await requestTiltPermission(win);
      if (stale()) return;
      if (!granted) {
        error.textContent = 'センサーの利用が許可されませんでした。ブラウザの設定で「モーションと画面の向き」へのアクセスを許可してください。';
        return;
      }
      status.textContent = '測っています。スマートフォンから手を離してお待ちください…';
      const samples = await collectSamples(win, MEASURE_MS);
      if (stale()) return;
      const { summary, problems } = checkSamples(samples, tilt);
      status.textContent = '';
      if (problems.length > 0) {
        error.textContent = problems.map((problem) => problem.message).join('\n');
        return;
      }
      if (firstSlope === null) {
        firstSlope = summary.slope;
        addReading('1 回目', summary);
      } else {
        addReading('2 回目', summary);
        const combined = combineReversal(firstSlope, summary.slope);
        if (combined.problems.length > 0) {
          const message = combined.problems.map((problem) => problem.message).join('\n');
          reset();
          error.textContent = message;
          return;
        }
        result = combined;
        status.textContent = `センサーのずれ ${formatPerMille(combined.bias)}/1000 を差し引いた値です。`;
      }
      show();
    } catch (failure) {
      if (stale()) return;
      status.textContent = '';
      error.textContent = `センサーを使えませんでした: ${failure.message}`;
    } finally {
      go.disabled = false;
    }
  };

  return new Promise((resolve) => {
    let answer = null;
    go.addEventListener('click', () => {
      if (!result) {
        measure();
        return;
      }
      // 低い側の端は床のときだけ意味がある（壁・柱で測るのは側面の法線）。
      answer = {
        value: formatPerMille(result.value),
        lowEnd: tilt === 'horizontal' ? result.lowEnd : null,
      };
      dialog.close();
    });
    redo.addEventListener('click', reset);
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      generation += 1;
      dialog.remove();
      resolve(answer);
    });
    show();
    dialog.showModal();
  });
}
