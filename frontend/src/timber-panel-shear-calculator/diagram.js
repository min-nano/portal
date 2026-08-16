// 釘配列図・壁の面材配列図の縮尺と座標変換（描画そのものは form-dom.js が
// SVG に写す）。
//
// 工学座標（x は右・y は上、原点は面材の左下）を SVG 座標（y は下向き）へ
// 変換して返す。
//
// 「どこからどこまでを描くか」「目盛にどの値を出し、どう書くか」は計算実装
// （core/）が決めたもの（計算結果の diagram）をそのまま使う。計算書 PDF も
// 同じものを読むので、画面と計算書は縮尺だけが違う同じ図になる。描画範囲は
// 「面材枠 (0,0)-(W,H) と全釘」の外接矩形で、釘が面材からはみ出す配列でも
// 切り取らず、はみ出していることが見えるようになっている。

const PADDING = 44; // ラベル・目盛用の余白 [px]
const MAX_DIMENSION = 460; // 描画領域の長辺の目標サイズ [px]

/**
 * 釘配列図の幾何情報を作る。描けない入力（釘が無い・寸法が 0）なら null。
 *
 * @param {{x:number,y:number}[]} nails 釘座標 [mm]
 * @param {object|null} diagram 計算結果の diagram（面材寸法・範囲・目盛・中立軸）
 */
export function buildDiagram(nails, diagram) {
  if (!diagram || !nails || nails.length === 0) return null;
  const panelWidth = Number(diagram.panelWidth) || 0;
  const panelHeight = Number(diagram.panelHeight) || 0;
  if (!(panelWidth > 0) || !(panelHeight > 0)) return null;

  const { minX, maxX, minY, maxY } = diagram;
  const domainWidth = maxX - minX;
  const domainHeight = maxY - minY;

  const scale = MAX_DIMENSION / Math.max(domainWidth, domainHeight);
  const mapX = (x) => PADDING + (x - minX) * scale;
  // y は上下を反転して、原点が左下に見えるようにする。
  const mapY = (y) => PADDING + (maxY - y) * scale;

  return {
    svgWidth: domainWidth * scale + PADDING * 2,
    svgHeight: domainHeight * scale + PADDING * 2,
    frame: {
      x: mapX(0),
      y: mapY(panelHeight),
      width: panelWidth * scale,
      height: panelHeight * scale,
    },
    points: nails.map((nail, index) => ({
      index: index + 1,
      cx: mapX(nail.x),
      cy: mapY(nail.y),
      x: nail.x,
      y: nail.y,
    })),
    xTicks: diagram.xTicks.map((tick) => ({
      label: tick.label,
      position: mapX(tick.value),
    })),
    yTicks: diagram.yTicks.map((tick) => ({
      label: tick.label,
      position: mapY(tick.value),
    })),
    axes: diagram.axis
      ? {
          x: mapX(diagram.axis.x0),
          y: mapY(diagram.axis.y0),
          xLabel: diagram.axis.xLabel,
          yLabel: diagram.axis.yLabel,
        }
      : null,
    axisBottom: mapY(minY),
    axisLeft: mapX(minX),
  };
}

/**
 * 壁の面材配列図の 1 つの面に取る、見出しと寸法の余白 [px]。
 *
 * 左は「H = 3,000 mm」を右寄せで置く幅、下は「W = 910 mm」を置く高さ、
 * 上は面の見出し（「表面（2 枚）」）の高さ。右は枠が SVG の縁に貼り付かない
 * ための余白だけ。
 */
const WALL_CAPTION = 20;
const WALL_LABEL_LEFT = 72;
const WALL_LABEL_RIGHT = 14;
const WALL_LABEL_BOTTOM = 22;
/** 面（表面・裏面）を横に並べるときの間隔 [px]。 */
const WALL_GAP = 32;
/** 壁 1 面ぶんの描画領域の、いちばん長い辺の目標サイズ [px]。 */
const WALL_MAX_DIMENSION = 300;

/**
 * 壁の面材配列図の幾何情報を作る。描けない入力（配置が無い）なら null。
 *
 * 両面張りの壁は表面と裏面を横に並べる（同じ場所に面材が来るので、1 つの枠に
 * 重ねると読めなくなる）。どこからどこまでを描くか・どの面材に注意の印を
 * 付けるかは計算実装（core/）が決めたものをそのまま使うので、画面と計算書は
 * 縮尺だけが違う同じ図になる。
 *
 * @param {object|null} diagram 壁の計算結果の wallDiagram
 */
export function buildWallDiagram(diagram) {
  const sides = (diagram && diagram.sides) || [];
  if (!sides.length) return null;
  const wallWidth = Number(diagram.wallWidth) || 0;
  const wallHeight = Number(diagram.wallHeight) || 0;
  if (!(wallWidth > 0) || !(wallHeight > 0)) return null;

  // 描く範囲（＝縮尺）は表も裏も同じ 1 つ。面ごとに変えると、同じ寸法の
  // 面材が表と裏で違う大きさに見えてしまう。
  const { minX, maxX, minY, maxY } = diagram;
  const domainWidth = maxX - minX;
  const domainHeight = maxY - minY;
  if (!(domainWidth > 0) || !(domainHeight > 0)) return null;
  const scale = WALL_MAX_DIMENSION / Math.max(domainWidth, domainHeight);

  const columnWidth = domainWidth * scale + WALL_LABEL_LEFT + WALL_LABEL_RIGHT;
  const built = sides.map((side, index) => {
    const originX = index * (columnWidth + WALL_GAP) + WALL_LABEL_LEFT;
    const mapX = (x) => originX + (x - minX) * scale;
    // y は上下を反転して、原点が壁の左下に見えるようにする。
    const mapY = (y) => WALL_CAPTION + (maxY - y) * scale;
    return {
      label: `${side.label}（${side.count} 枚）`,
      captionX: originX + (domainWidth * scale) / 2,
      frame: {
        x: mapX(0),
        y: mapY(wallHeight),
        width: wallWidth * scale,
        height: wallHeight * scale,
      },
      widthLabel: `W = ${wallWidth.toLocaleString('ja-JP')} mm`,
      heightLabel: `H = ${wallHeight.toLocaleString('ja-JP')} mm`,
      panels: side.panels.map((panel) => ({
        label: panel.label,
        sizeLabel: panel.sizeLabel,
        note: panel.note,
        ok: panel.ok,
        x: mapX(panel.x),
        y: mapY(panel.y + panel.height),
        width: panel.width * scale,
        height: panel.height * scale,
      })),
    };
  });

  return {
    svgWidth: columnWidth * sides.length + WALL_GAP * (sides.length - 1),
    svgHeight: domainHeight * scale + WALL_CAPTION + WALL_LABEL_BOTTOM,
    sides: built,
    unplaced: (diagram.unplaced || []).slice(),
  };
}
