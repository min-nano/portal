"""面材張り大壁 計算ツールの API（/api/tools/timber-panel-shear-calculator/**）。

GAS 版はスプレッドシートへ現在値と履歴を書き出していたが、ここでは証明書と
同じく「成果物の PDF そのものが保存形式」になる。フォーム入力を PDF の
文書情報へ埋め込むため、保存した PDF を開き直せば続きを編集できる。
雛形は使わない（計算書はバックエンドが直接組み立てる）ので、このツールには
共有設定が無い。

編集中の計算に API は使わない。画面は /core.wasm で計算実装を受け取り、
手元で計算する（入力のたびの往復が無いので、釘の本数が増えても速い）。
サーバが計算するのは保存のときだけで、そこで画面の値と突き合わせる。
"""

from fastapi import Depends, Request

from .. import panel_shear, portal_sdk
from ..clerk_auth import User
from ..panel_shear import PanelShearError
from ..portal_sdk import Tool, require_user

TOOL_ID = "timber-panel-shear-calculator"

router = portal_sdk.tool_router(TOOL_ID)


@router.get("/config")
async def get_config(user: User = Depends(require_user)):
    """既定のファイル名と、計算実装の在り処を配信する。"""
    return panel_shear.form_config(f"{router.prefix}/core.wasm")


@router.get("/core.wasm")
async def get_core(request: Request, user: User = Depends(require_user)):
    """画面が編集中の計算に使う wasm を配る（portal_sdk.wasm_response 参照）。"""
    return portal_sdk.wasm_response(request)


@router.post("/reports")
async def create_report(request: Request, user: User = Depends(require_user)):
    """フォームデータから計算書 PDF を作り、Drive へ保存する。

    保存方法は証明書と同じく body.save.mode（overwrite / new）で切り替える。

    計算書に載るのはここで計算し直した値。編集中に画面（同じ wasm）が出して
    いた値も body.verify として受け取り、突き合わせた結果を応答へ添える
    （食い違っていても保存は止めず、画面に警告を出させる）。
    """
    body = await portal_sdk.json_body(request)
    data = panel_shear.normalize_data(body)
    reports = panel_shear.validate(data)
    verification = panel_shear.verify(reports, body.get("verify"))

    session = portal_sdk.delegated_write_session(user.email)
    destination = portal_sdk.resolve_pdf_destination(
        session,
        body.get("save"),
        PanelShearError,
        panel_shear.ensure_pdf_extension,
        lambda: panel_shear.default_file_name(data),
    )

    return portal_sdk.save_pdf(
        session,
        destination,
        panel_shear.build_pdf(data, reports),
        verification=verification,
    )


# 計算書 PDF の読み戻し（アップロード / Drive）。段取りは証明書ツールと同じ。
portal_sdk.pdf_parse_routes(
    router,
    "/reports",
    parse=panel_shear.parse_pdf,
    error=PanelShearError,
)


TOOL = Tool(
    id=TOOL_ID,
    name="面材張り大壁 計算ツール",
    router=router,
)
