"""ツールをバックエンドへ載せる受け口（app/tools/ と portal_sdk）。

ここが壊れると「起動はするが、そのツールだけ 404」という気付きにくい
壊れ方をするので、載せ方そのものを固定する。

  - ツールは自分の id だけを名乗り、URL（/api/tools/<id>）は土台が決める
  - 載せたツールのルートが、すべてその接頭辞の下にある
  - 画面側の名乗り（frontend/src/<id>/tool.js）と id がそろっている
  - ヘッダに結果を載せるツールは、そのヘッダ名を自分で名乗る
  - 失敗は 1 つの形（PortalError）で返る。ツールが増えてもハンドラは増えない
"""

import re
from pathlib import Path

import pytest

from app import portal_sdk
from app.errors import PortalError
from app.main import app
from app.tools import TOOLS

FRONTEND_SRC = Path(__file__).resolve().parents[2] / "frontend" / "src"


def api_paths() -> set[str]:
    """公開されている API の面（OpenAPI から取る）。"""
    return set(app.openapi()["paths"])


def test_the_portal_has_tools():
    assert TOOLS


def test_tool_ids_are_unique():
    ids = [tool.id for tool in TOOLS]
    assert len(set(ids)) == len(ids)


@pytest.mark.parametrize("tool", TOOLS, ids=lambda t: t.id)
def test_the_platform_decides_the_url_prefix(tool):
    """ツールは自分の id だけを名乗る。/api/tools/ の付け方は土台の決めごと。"""
    assert tool.router.prefix == f"/api/tools/{tool.id}"
    assert tool.name


@pytest.mark.parametrize("tool", TOOLS, ids=lambda t: t.id)
def test_a_tools_routes_all_live_under_its_own_prefix(tool):
    paths = [path for path in api_paths() if path.startswith(tool.router.prefix)]
    assert paths, f"{tool.id} のルートが 1 つも載っていない"
    for route in tool.router.routes:
        assert route.path.startswith(tool.router.prefix)


def test_no_route_under_api_tools_is_unclaimed():
    """/api/tools/** に、どのツールにも属さないルートが紛れていない。"""
    prefixes = tuple(tool.router.prefix for tool in TOOLS)
    stray = [
        path
        for path in api_paths()
        if path.startswith("/api/tools/") and not path.startswith(prefixes)
    ]
    assert stray == []


@pytest.mark.parametrize("tool", TOOLS, ids=lambda t: t.id)
def test_the_web_manifest_declares_the_same_id(tool):
    """画面（tool.js）とバックエンド（Tool）が、同じ id を名乗っている。

    この 2 つがずれると、画面は /tools/<A>/ に出るのに API は
    /api/tools/<B>/ にある、という組み合わせが黙って出来上がる。
    """
    manifest = FRONTEND_SRC / tool.id / "tool.js"
    assert manifest.exists(), f"{tool.id} の画面側マニフェストが無い"
    declared = re.search(r"id:\s*'([^']+)'", manifest.read_text(encoding="utf-8"))
    assert declared and declared.group(1) == tool.id


def test_headers_named_by_tools_are_exposed_through_cors():
    """本文が xlsx のツールは、突き合わせの結果をヘッダに載せる。

    ブラウザから読めるようにするには CORS の expose_headers に要るが、
    それをツール名で main.py に書くと、ツールが増えるたびに土台を触ることに
    なる。ツールが自分で名乗り、土台がまとめて渡す形になっていることを見る。
    """
    exposed = set()
    for middleware in app.user_middleware:
        exposed |= set(middleware.kwargs.get("expose_headers", []))

    assert "Content-Disposition" in exposed
    named = {name for tool in TOOLS for name in tool.expose_headers}
    assert named, "ヘッダを名乗るツールが 1 つは要る（必要壁量ツール）"
    assert named <= exposed


def test_failures_all_share_one_shape():
    """土台の失敗もツールの失敗も PortalError。ハンドラは 1 つで足りる。"""
    assert issubclass(portal_sdk.ToolError, PortalError)
    assert PortalError in app.exception_handlers

    error = portal_sdk.ToolError("入力が足りません。", 409)
    assert error.status == 409
    assert str(error) == "入力が足りません。"
