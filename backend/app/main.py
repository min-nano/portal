"""社内ポータル バックエンド API（Cloud Run）。

フロントエンド（Firebase Hosting）からは Hosting のリライト機能で /api/** が
この Cloud Run サービスへ転送されるため、ブラウザからは同一オリジンに見える。
全エンドポイント（healthz を除く）は Clerk セッション JWT を検証し、確認した
メールアドレスのユーザー代理（domain-wide delegation）で Workspace の Drive を
操作する。これにより GAS 版の「アクセスしているユーザーとして実行」と同じ
権限モデル（雛形にアクセス権のある本人しか読めない）を維持する。

このファイルが持つのは **組み立てだけ** で、ツールの中身は 1 行も無い:

  - どのツールにも同じように効くもの（/healthz・/me・/drive/items）
  - 失敗の返し方（PortalError なら status と日本語、それ以外は 500）
  - 載せるツール（app/tools/）のルーターを /api/tools/<id> へ載せる

ツールが増えても、ここは変わらない（README の「🧩 土台とツール」）。
土台としてツールへ貸し出すもの（認証・代理アクセス・共有設定・PDF の保存先・
wasm）は portal_sdk にある。
"""

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import config, drive_browser, google_drive, portal_sdk
from .clerk_auth import User
from .errors import PortalError
from .portal_sdk import require_user
from .tools import TOOLS

app = FastAPI(title="portal-api", docs_url=None, redoc_url=None)

# 本番は Firebase Hosting のリライトで同一オリジンになるため CORS は不要だが、
# ローカル開発（Vite dev サーバーから直接叩く場合）のために許可しておく。
#
# 本文ではなくヘッダに結果を載せるツールは、そのヘッダ名を自分で名乗る
# （Tool.expose_headers）。ここにツール固有のヘッダ名は書かない。
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.cors_allowed_origins(),
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=[
        "Content-Disposition",
        *(name for tool in TOOLS for name in tool.expose_headers),
    ],
)


def _error_response(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


@app.exception_handler(PortalError)
async def _portal_error_handler(_request: Request, exc: PortalError):
    """利用者に見せられる失敗（認証・Drive・共有設定・各ツール）。

    土台もツールも同じ形（message + status）で失敗を伝えるので、ハンドラは
    これ 1 つで足りる。ツールが増えてもここは増えない。
    """
    return _error_response(exc.status, str(exc))


@app.exception_handler(Exception)
async def _unexpected_error_handler(_request: Request, exc: Exception):
    return _error_response(500, str(exc))


# --- どのツールにも同じように効くもの ----------------------------------------


@app.get("/api/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/api/me")
async def me(user: User = Depends(require_user)):
    return {"email": user.email}


@app.get("/api/drive/items")
async def list_drive_items(
    location: str | None = None,
    folder: str | None = None,
    q: str | None = None,
    mimeTypes: str | None = None,
    foldersOnly: bool = False,
    pageToken: str | None = None,
    user: User = Depends(require_user),
):
    """ファイル選択ダイアログに出す一覧（全ツール共通）。

    Drive の中をたどる画面はポータル側で描き、一覧だけをここで本人の代理
    （drive.readonly）で取る（Google Picker をやめた理由は drive_browser 参照）。
    指定は folder（フォルダの中身）→ q（名前で検索）→ location（最初の場所:
    my-drive / shared-drives / recent / shared-with-me）の順に見る。
    """
    session = google_drive.delegated_session(user.email)
    return drive_browser.list_items(
        session,
        location=location,
        folder=folder,
        query=q,
        mime_types=drive_browser.parse_mime_types(mimeTypes),
        folders_only=foldersOnly,
        page_token=pageToken,
    )


# --- ツール ------------------------------------------------------------------
#
# 載せるツールは app/tools/ が決める。ここは並んだものを順に載せるだけで、
# ツールの名前も、ツールごとの分岐も持たない。

for _tool in TOOLS:
    app.include_router(_tool.router)


# 土台がツールへ貸し出すもの。ツール側からは portal_sdk として見えるが、
# テストが差し替えたい口（require_user など）はここからも辿れるようにしておく。
__all__ = ["TOOLS", "app", "portal_sdk", "require_user"]
