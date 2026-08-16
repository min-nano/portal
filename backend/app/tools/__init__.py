"""このポータルに載せるツール（API 側）。

**バックエンドがツールを知っている唯一の場所**がここ。main.py は並んだ
ツールを順に載せるだけで、ツールごとの分岐もツール名の定数も持たない。
画面側の tools.config.js に対応する（docs/plugin-architecture.md §4.2）。

並び順は API の動きに影響しない（それぞれ別の接頭辞を持つため）が、
画面側と同じ順に並べておく。

ツールを別リポジトリへ出したあとは、この import が

    from portal_tool_wall_quantity import TOOL as wall_quantity_calculator

のようなパッケージ参照に変わり、どの版を載せるかは tools.json が決める。
"""

from .excel_report_formatter import TOOL as excel_report_formatter
from .structural_cert_formatter import TOOL as structural_cert_formatter
from .timber_panel_shear_calculator import TOOL as timber_panel_shear_calculator
from .wall_quantity_calculator import TOOL as wall_quantity_calculator

TOOLS = (
    excel_report_formatter,
    structural_cert_formatter,
    timber_panel_shear_calculator,
    wall_quantity_calculator,
)
