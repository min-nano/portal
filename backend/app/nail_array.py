"""釘配列諸定数（Ixy, Zxy, Cxy）の計算。

グレー本『木造軸組工法住宅の許容応力度設計』
  3.2 面材張り耐力要素の詳細計算法で用いる釘配列諸定数の計算
  （式 3.2.1〜3.2.7）に準拠する。

計算上の仮定:
  - 面材・軸材は剛体、軸材どうしはピン接合。
  - 釘のせん断変形は中立軸に対して平面保持仮定が成立する。

このモジュールは「唯一の計算実装」で、画面に表示する値も PDF 計算書に
印字する値も必ずここを通る（画面側で計算し直さない）。GAS 版
gas-timber-panel-shear-calculator の src/NailArrayConstants.js の移植で、
関数の粒度と式番号のコメントもそのまま引き継いでいる。
"""

import math
from dataclasses import asdict, dataclass


class NailArrayError(ValueError):
    """入力が計算できないときのエラー。message は利用者に表示できる日本語文。"""


@dataclass(frozen=True)
class Nail:
    """釘 1 本の座標 [mm]（原点は面材の左下）。"""

    x: float
    y: float


@dataclass(frozen=True)
class NailArrayConstants:
    """釘配列諸定数と、その途中経過（白箱化のため全部返す）。"""

    n: int
    panel_area: float
    x0: float
    y0: float
    Ix: float
    Iy: float
    Ixy: float
    dx_max: float
    dy_max: float
    Zx: float
    Zy: float
    Zxy: float
    alpha_x: float
    Zpxy: float
    Cxy: float

    def as_dict(self) -> dict:
        return asdict(self)


def neutral_axis_position(coords: list[float]) -> float:
    """弾性中立軸位置を求める。

    y0 = Σ(yj・nj) / Σnj 、 x0 = Σ(xi・ni) / Σni （式 3.2.2a / 3.2.2b の中立軸）。
    釘を「1 要素 = 釘 1 本」で表すため、各座標の重み nj は座標の重複本数として
    自然に折り込まれ、単純な相加平均となる。
    """
    if not coords:
        raise NailArrayError("釘座標のリストが空です。")
    return sum(coords) / len(coords)


def second_moment_of_nail_array(coords: list[float], axis: float) -> float:
    """釘配列二次モーメントを求める。

    Ix = Σ(yj - y0)^2・nj （式 3.2.2a） / Iy = Σ(xi - x0)^2・ni （式 3.2.2b）
    """
    return sum((c - axis) ** 2 for c in coords)


def max_distance_from_axis(coords: list[float], axis: float) -> float:
    """中立軸から端部の釘までの距離の最大値 (yj - y0)max / (xi - x0)max を求める。"""
    return max((abs(c - axis) for c in coords), default=0.0)


def unit_second_moment(ix: float, iy: float, panel_area: float) -> float:
    """単位面積あたりの釘配列二次モーメント Ixy を求める（式 3.2.1）。

    Ixy = ( Ix・Iy / (Ix + Iy) ) / Aw   [mm^2/mm^2]
    """
    denominator = ix + iy
    if denominator == 0:
        raise NailArrayError("Ix + Iy が 0 です（釘が 1 点に集中しています）。")
    return (ix * iy / denominator) / panel_area


def arrangement_coefficient(second_moment: float, max_distance: float) -> float:
    """各方向の釘配列係数を求める（式 3.2.4a / 3.2.4b）。

    Zx = Ix / (yj - y0)max 、 Zy = Iy / (xi - x0)max
    端部距離が 0（その方向に配列の広がりが無い）の場合は 0 を返す。
    """
    if max_distance == 0:
        return 0.0
    return second_moment / max_distance


def unit_arrangement_coefficient(zx: float, zy: float, panel_area: float) -> float:
    """単位面積あたりの釘配列係数 Zxy を求める（式 3.2.3）。

    Zxy = 1 / ( Aw・√(1/Zx^2 + 1/Zy^2) )   [mm/mm^2]

    Zx もしくは Zy が 0 のときは、その方向に配列の広がりが無いということなので
    Zxy は 0 に収束する（JavaScript 版は IEEE 754 の Infinity 経由で同じ値に
    なるが、Python は 1/0 が例外になるため明示的に分岐する）。
    """
    if zx == 0 or zy == 0:
        return 0.0
    root = math.sqrt(1 / (zx * zx) + 1 / (zy * zy))
    if root == 0 or math.isinf(root):
        return 0.0
    return 1 / (panel_area * root)


def deformation_ratio_x(ix: float, iy: float) -> float:
    """全塑性状態の全体変形に対する X 方向の変形割合 αx を求める（式 3.2.7）。

    αx = Iy / (Ix + Iy)
    """
    denominator = ix + iy
    if denominator == 0:
        raise NailArrayError("Ix + Iy が 0 です（釘が 1 点に集中しています）。")
    return iy / denominator


def plastic_unit_arrangement_coefficient(
    nails: list[Nail], x0: float, y0: float, alpha_x: float, panel_area: float
) -> float:
    """単位面積あたりの塑性釘配列係数 Zpxy を求める（式 3.2.6）。

    Zpxy = Σ√( {(yj - y0)・αx}^2 + {(xi - x0)・(1 - αx)}^2 ) / Aw   [mm/mm^2]
    """
    total = 0.0
    for nail in nails:
        dy = (nail.y - y0) * alpha_x
        dx = (nail.x - x0) * (1 - alpha_x)
        total += math.sqrt(dy * dy + dx * dx)
    return total / panel_area


def yield_ultimate_ratio(zpxy: float, zxy: float) -> float:
    """釘配列降伏終局比 Cxy を求める（式 3.2.5）。

    Cxy = Zpxy / Zxy 、ただし Cxy < 1.0 の場合は Cxy = 1.0 とする。
    """
    if zxy == 0:
        raise NailArrayError("Zxy が 0 です。")
    ratio = zpxy / zxy
    return 1.0 if ratio < 1.0 else ratio


def validate_input(nails: list[Nail], panel_area: float):
    """釘リストと面材面積を検証する。"""
    if not nails:
        raise NailArrayError("釘座標のリストが空です。少なくとも 1 本の釘が必要です。")
    for index, nail in enumerate(nails, start=1):
        if not math.isfinite(nail.x) or not math.isfinite(nail.y):
            raise NailArrayError(f"釘座標 #{index} の x, y は有限の数値である必要があります。")
    if not math.isfinite(panel_area) or panel_area <= 0:
        raise NailArrayError("面材の面積 Aw は正の数値である必要があります。")


def compute(nails: list[Nail], panel_area: float) -> NailArrayConstants:
    """釘配列諸定数を一括で計算する（グレー本 3.2 の手順 1)〜9) に対応）。"""
    validate_input(nails, panel_area)

    xs = [nail.x for nail in nails]
    ys = [nail.y for nail in nails]

    # 2) 各方向の弾性中立軸位置 x0, y0
    x0 = neutral_axis_position(xs)
    y0 = neutral_axis_position(ys)

    # 3) 各方向の釘配列二次モーメント Ix, Iy
    ix = second_moment_of_nail_array(ys, y0)  # Y 方向中立軸まわり（X 軸まわり）
    iy = second_moment_of_nail_array(xs, x0)  # X 方向中立軸まわり（Y 軸まわり）

    # 4) 単位面積あたりの釘配列二次モーメント Ixy
    ixy = unit_second_moment(ix, iy, panel_area)

    # 5) 各方向の釘配列係数 Zx, Zy
    dy_max = max_distance_from_axis(ys, y0)
    dx_max = max_distance_from_axis(xs, x0)
    zx = arrangement_coefficient(ix, dy_max)
    zy = arrangement_coefficient(iy, dx_max)

    # 6) 単位面積あたりの釘配列係数 Zxy
    zxy = unit_arrangement_coefficient(zx, zy, panel_area)

    # 7) αx
    alpha_x = deformation_ratio_x(ix, iy)

    # 8) 単位面積あたりの塑性釘配列係数 Zpxy
    zpxy = plastic_unit_arrangement_coefficient(nails, x0, y0, alpha_x, panel_area)

    # 9) 釘配列降伏終局比 Cxy
    cxy = yield_ultimate_ratio(zpxy, zxy)

    return NailArrayConstants(
        n=len(nails),
        panel_area=panel_area,
        x0=x0,
        y0=y0,
        Ix=ix,
        Iy=iy,
        Ixy=ixy,
        dx_max=dx_max,
        dy_max=dy_max,
        Zx=zx,
        Zy=zy,
        Zxy=zxy,
        alpha_x=alpha_x,
        Zpxy=zpxy,
        Cxy=cxy,
    )


def build_rectangular_grid(xs: list[float], ys: list[float]) -> list[Nail]:
    """矩形格子状の釘配列を生成する（xs と ys の全組合せに釘を 1 本ずつ）。"""
    return [Nail(x, y) for x in xs for y in ys]
