"""小規模木造建築物 必要壁量 計算ツールの API（/api/tools/wall-quantity-calculator/**）。

提出物は「日本住宅・木材技術センターが配布している表計算ツールに値を入れたもの」
そのものなので、雛形は Drive ではなくリポジトリに同梱した配布物を使い、
Excel 形式のまま返す（Google スプレッドシート等へは変換しない）。共有設定も
Drive アクセスも要らないので、このツールにあるのは config と wasm と生成だけ。

提出物に入る計算結果は配布物の数式が出す（このツールは xlsx の数式に手を
入れない）。一方で画面には、配布物の数式を写した wasm で計算した「出力結果」
をその場で出す。保存のときはサーバも同じ wasm で計算し、画面が出していた値と
突き合わせて、食い違えば応答ヘッダで知らせる。
"""

import json
from urllib.parse import quote

from fastapi import Depends, Request, Response

from .. import portal_sdk, wall_quantity
from ..clerk_auth import User
from ..google_drive import XLSX_MIME
from ..portal_sdk import Tool, require_user

TOOL_ID = "wall-quantity-calculator"

# 突き合わせの結果を載せるヘッダ。本文が xlsx そのものなので、応答の中に
# 入れる場所がここしかない（CORS の expose_headers に載せる必要がある）。
VERIFICATION_HEADER = "X-Wall-Quantity-Verification"

router = portal_sdk.tool_router(TOOL_ID)


@router.get("/config")
async def get_config(user: User = Depends(require_user)):
    """フォーム定義（節・入力欄・選択肢・条件）と、同梱している配布物の版を配る。"""
    return wall_quantity.form_config(f"{router.prefix}/core.wasm")


@router.get("/core.wasm")
async def get_core(request: Request, user: User = Depends(require_user)):
    """画面が編集中の計算に使う wasm を配る（面材張り大壁と同じバイト列）。"""
    return portal_sdk.wasm_response(request)


@router.post("/worksheets")
async def create_worksheet(request: Request, user: User = Depends(require_user)):
    """フォーム入力を書き込んだ表計算ツール（xlsx）を返す。

    本文が xlsx そのものなので、画面との突き合わせ（verify）の結果は
    応答ヘッダ X-Wall-Quantity-Verification に JSON で載せる。食い違っても
    生成は止めない（xlsx に入るのは入力値で、計算するのは Excel の数式）。
    """
    body = await portal_sdk.json_body(request)
    data = wall_quantity.normalize_data(body)
    wall_quantity.validate(data)
    verification = wall_quantity.verify(wall_quantity.compute(data), body.get("verify"))
    xlsx_bytes = wall_quantity.build_worksheet(data)

    return Response(
        content=xlsx_bytes,
        media_type=XLSX_MIME,
        headers={
            "Content-Disposition": (
                f"attachment; filename*=UTF-8''{quote(wall_quantity.file_name(data))}"
            ),
            # key と数値だけなので ASCII に収まる（ヘッダに非 ASCII は置けない）。
            VERIFICATION_HEADER: json.dumps(verification, ensure_ascii=True),
        },
    )


TOOL = Tool(
    id=TOOL_ID,
    name="小規模木造建築物 必要壁量 計算ツール",
    router=router,
    # 本文が xlsx なので、突き合わせの結果はヘッダで返す。ブラウザから読める
    # ようにするため、CORS の expose_headers へ載せてもらう。
    expose_headers=(VERIFICATION_HEADER,),
)
