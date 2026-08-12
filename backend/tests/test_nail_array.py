"""釘配列諸定数の計算のユニットテスト。

GAS 版 tests/NailArrayConstants.test.js の移植で、テストケースの構成も
引き継いでいる:

  1. グレー本 3.2【解説】の計算例（図 3.2.2）を再現する統合テスト。
  2. 各関数単位のユニットテスト。
  3. 入力検証・エッジケース。
"""

import math

import pytest

from app import nail_array
from app.nail_array import Nail, NailArrayError

# グレー本 3.2【解説】の計算例（図 3.2.2）。
#   釘: X ∈ {0, 445, 890}, Y ∈ {0, 145, 295, 445, 590} の格子（15 本）
#   面材: 610 × 910 = 555100 mm²
EXAMPLE_XS = [0, 445, 890]
EXAMPLE_YS = [0, 145, 295, 445, 590]
EXAMPLE_AREA = 610 * 910


@pytest.fixture(scope="module")
def example():
    nails = nail_array.build_rectangular_grid(EXAMPLE_XS, EXAMPLE_YS)
    return nail_array.compute(nails, EXAMPLE_AREA)


# --- 1. グレー本 3.2【解説】の計算例（図 3.2.2） -----------------------------


def test_example_counts_and_area(example):
    assert example.n == 15
    assert example.panel_area == 555100


def test_example_neutral_axis(example):
    assert example.x0 == 445
    assert example.y0 == 295


def test_example_second_moments(example):
    assert example.Ix == 657150
    assert example.Iy == 1980250


def test_example_unit_second_moment(example):
    """Ixy = 0.889 [mm²/mm²]（式 3.2.1）。"""
    assert round(example.Ixy, 3) == 0.889


def test_example_edge_distances(example):
    assert example.dy_max == 295
    assert example.dx_max == 445


def test_example_arrangement_coefficients(example):
    """Zx = 2228, Zy = 4450 [mm]（式 3.2.4）。"""
    assert round(example.Zx) == 2228
    assert round(example.Zy) == 4450


def test_example_unit_arrangement_coefficient(example):
    """Zxy = 0.0036 [mm/mm²]（式 3.2.3）。"""
    assert round(example.Zxy, 4) == 0.0036


def test_example_deformation_ratio(example):
    """αx = 0.751（式 3.2.7）。"""
    assert round(example.alpha_x, 3) == 0.751


def test_example_plastic_unit_arrangement_coefficient(example):
    """Zpxy = 0.0045 [mm/mm²]（式 3.2.6）。"""
    assert round(example.Zpxy, 4) == 0.0045


def test_example_yield_ultimate_ratio(example):
    """Cxy（式 3.2.5、Cxy ≧ 1.0）。

    グレー本は丸めた 0.0045 / 0.0036 = 1.25 と表示している。丸め前の
    厳密値は約 1.26 で、いずれも 1.0 以上になる。
    """
    assert round(0.0045 / 0.0036, 2) == 1.25
    assert example.Cxy == pytest.approx(1.26, abs=0.02)
    assert example.Cxy >= 1.0


# --- 2. 各関数単位のユニットテスト -------------------------------------------


def test_neutral_axis_position_is_the_arithmetic_mean():
    assert nail_array.neutral_axis_position([0, 445, 890]) == 445
    assert nail_array.neutral_axis_position([0, 145, 295, 445, 590]) == 295


def test_neutral_axis_position_weights_duplicate_coordinates():
    """重複座標（本数の重み）を正しく反映する: (0+0+300)/3 = 100。"""
    assert nail_array.neutral_axis_position([0, 0, 300]) == 100


def test_neutral_axis_position_rejects_empty():
    with pytest.raises(NailArrayError):
        nail_array.neutral_axis_position([])


def test_second_moment_of_nail_array():
    assert nail_array.second_moment_of_nail_array([-1, 1], 0) == 2
    assert nail_array.second_moment_of_nail_array([2, 4, 6], 4) == 8  # 4 + 0 + 4


def test_second_moment_reproduces_the_example_ix():
    ys = EXAMPLE_YS * 3
    assert nail_array.second_moment_of_nail_array(ys, 295) == 657150


def test_max_distance_from_axis():
    assert nail_array.max_distance_from_axis([0, 145, 295, 445, 590], 295) == 295
    assert nail_array.max_distance_from_axis([0, 445, 890], 445) == 445


def test_unit_second_moment_reproduces_the_example():
    value = nail_array.unit_second_moment(657150, 1980250, 555100)
    assert value == pytest.approx(0.8889, abs=1e-3)


def test_unit_second_moment_rejects_a_single_point():
    with pytest.raises(NailArrayError):
        nail_array.unit_second_moment(0, 0, 100)


def test_arrangement_coefficient():
    assert nail_array.arrangement_coefficient(657150, 295) == pytest.approx(
        2227.63, abs=0.1
    )
    assert nail_array.arrangement_coefficient(1980250, 445) == 4450


def test_arrangement_coefficient_without_spread_is_zero():
    """端部距離 0 のとき 0 を返す（0 除算を回避）。"""
    assert nail_array.arrangement_coefficient(0, 0) == 0


def test_unit_arrangement_coefficient_reproduces_the_example():
    value = nail_array.unit_arrangement_coefficient(2228, 4450, 555100)
    assert value == pytest.approx(0.0036, abs=1e-4)


def test_unit_arrangement_coefficient_without_spread_is_zero():
    """Zx = 0 のとき Zxy = 0（例外を出さない）。"""
    assert nail_array.unit_arrangement_coefficient(0, 4450, 555100) == 0


def test_deformation_ratio_x():
    value = nail_array.deformation_ratio_x(657150, 1980250)
    assert value == pytest.approx(0.751, abs=1e-3)


def test_plastic_unit_arrangement_coefficient_reproduces_the_example():
    nails = nail_array.build_rectangular_grid(EXAMPLE_XS, EXAMPLE_YS)
    alpha_x = nail_array.deformation_ratio_x(657150, 1980250)
    value = nail_array.plastic_unit_arrangement_coefficient(
        nails, 445, 295, alpha_x, 555100
    )
    assert value == pytest.approx(0.0045, abs=1e-4)


def test_yield_ultimate_ratio():
    assert nail_array.yield_ultimate_ratio(0.0045, 0.0036) == pytest.approx(1.25)


def test_yield_ultimate_ratio_is_clamped_to_one():
    assert nail_array.yield_ultimate_ratio(0.5, 1.0) == 1.0


def test_yield_ultimate_ratio_rejects_zero():
    with pytest.raises(NailArrayError):
        nail_array.yield_ultimate_ratio(0.1, 0)


def test_build_rectangular_grid():
    nails = nail_array.build_rectangular_grid(EXAMPLE_XS, EXAMPLE_YS)
    assert len(nails) == 15
    assert nails[0] == Nail(0, 0)
    assert nails[-1] == Nail(890, 590)


# --- 3. 入力検証・エッジケース ------------------------------------------------


def test_compute_rejects_an_empty_nail_list():
    with pytest.raises(NailArrayError):
        nail_array.compute([], 100)


@pytest.mark.parametrize("area", [0, -5])
def test_compute_rejects_a_non_positive_area(area):
    with pytest.raises(NailArrayError):
        nail_array.compute([Nail(0, 0)], area)


def test_compute_rejects_non_finite_coordinates():
    with pytest.raises(NailArrayError):
        nail_array.compute([Nail(0, math.nan)], 100)
