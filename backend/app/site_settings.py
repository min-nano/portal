"""ポータル全体の設定（表示名とロゴ）。

以前は表示名をビルド時の環境変数（VITE_PORTAL_TITLE）で HTML に埋め込んで
いたが、変えるたびにリポジトリ変数の書き換えと再デプロイが要った。画面の
「設定」から変えられるよう、ツールの共有設定と同じく Firestore に置く
（置き場所は settings_store の site_settings/site）。

ロゴは画像そのものを base64 にしてドキュメントに入れる。別の置き場所
（Cloud Storage など）を持たずに済み、Firestore のドキュメントの上限
（1 MiB）にも十分収まる大きさに抑えてある（MAX_LOGO_BYTES）。

  保存する形:  {"title": "...", "logo": {"mime_type": "image/png", "data": "<base64>"}}
  返す形:      {"title": "...", "logo": "data:image/png;base64,<base64>" | null}

画面はロゴを <img> の data: URL として描く。<img> で読み込んだ SVG は
スクリプトを動かさないので、SVG を受け付けても画面の中で何かが実行される
ことはない（このポータルのオリジンで SVG を単独の文書として配ることもしない）。
"""

import base64
import binascii
import re

from fastapi import APIRouter, Depends, Request, Response

from . import settings_store
from .clerk_auth import User
from .errors import PortalError
from .portal_sdk import json_body, require_user

#: 表示名の長さの上限（ヘッダーは 1 行に収め、長ければ … で切る）。
MAX_TITLE_LENGTH = 60

#: ロゴの大きさの上限。base64 にすると 4/3 倍になるので、それでも Firestore の
#: ドキュメントの上限（1 MiB）に余裕を持って収まる値にする。
MAX_LOGO_BYTES = 256 * 1024

PNG_MIME = "image/png"
SVG_MIME = "image/svg+xml"

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

# 先頭の XML 宣言・コメント・DOCTYPE を読み飛ばした先に <svg が来るか。
_SVG_ROOT = re.compile(
    r"\A\s*(?:<\?xml[^>]*\?>\s*)?(?:(?:<!--.*?-->|<!DOCTYPE[^>]*>)\s*)*<svg[\s>/]",
    re.DOTALL,
)

_DATA_URL = re.compile(r"\Adata:([\w.+/-]+);base64,(.*)\Z", re.DOTALL)


class SiteSettingsError(PortalError):
    """設定の値が受け付けられないときの失敗（400）。"""


def _sniff_mime_type(content: bytes) -> str | None:
    """中身から画像の種類を決める（申告された種類やファイル名は信じない）。"""
    if content.startswith(_PNG_SIGNATURE):
        return PNG_MIME
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None
    return SVG_MIME if _SVG_ROOT.match(text) else None


def parse_title(value) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise SiteSettingsError("ポータルの名前が不正です。")
    title = " ".join(value.split())
    if len(title) > MAX_TITLE_LENGTH:
        raise SiteSettingsError(f"ポータルの名前は {MAX_TITLE_LENGTH} 文字までです。")
    return title


def parse_logo(value) -> dict | None:
    """data: URL を確かめ、保存する形（種類 + base64）にする。null はロゴなし。"""
    if value is None or value == "":
        return None
    match = _DATA_URL.match(value) if isinstance(value, str) else None
    if not match:
        raise SiteSettingsError("ロゴの画像を読み取れませんでした。")
    try:
        content = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError):
        raise SiteSettingsError("ロゴの画像を読み取れませんでした。") from None
    if len(content) > MAX_LOGO_BYTES:
        raise SiteSettingsError(
            f"ロゴの画像が大きすぎます（{MAX_LOGO_BYTES // 1024}KB まで）。", 413
        )
    mime_type = _sniff_mime_type(content)
    if mime_type is None:
        raise SiteSettingsError("ロゴには PNG か SVG の画像を選んでください。")
    # 申告された種類ではなく、中身から決めた種類で保存する。
    return {"mime_type": mime_type, "data": base64.b64encode(content).decode("ascii")}


def logo_data_url(logo) -> str | None:
    if not isinstance(logo, dict) or not logo.get("data"):
        return None
    if logo.get("mime_type") not in (PNG_MIME, SVG_MIME):
        return None
    return f"data:{logo['mime_type']};base64,{logo['data']}"


def public_view(settings: dict) -> dict:
    """画面へ返す形。未設定の項目は空（表示名の既定値は画面が決める）。"""
    title = settings.get("title")
    return {
        "title": title if isinstance(title, str) else "",
        "logo": logo_data_url(settings.get("logo")),
    }


router = APIRouter(prefix="/api/site")


@router.get("")
def get_site(response: Response):
    """表示名とロゴ。**サインイン前でも読める**。

    サインイン画面のヘッダーにも名前とロゴを出すため。以前は同じものを
    ビルド時に静的な HTML へ埋め込んで配っていたので、誰に読めるかは
    変わらない。どのページでも最初に呼ばれるので、変更がすぐ届くよう
    キャッシュはさせない（画面の側が前回の値を覚えていて、先に出す）。
    """
    response.headers["Cache-Control"] = "no-store"
    return public_view(settings_store.get_site_settings())


@router.put("")
async def put_site(request: Request, user: User = Depends(require_user)):
    """設定画面からの保存。表示名とロゴをまとめて置き換える。"""
    body = await json_body(request)
    # 本文が読めないまま空で上書きしてしまわないよう、表示名の欄は必須にする
    # （空文字は「既定の名前に戻す」という正当な指定）。
    if "title" not in body:
        raise SiteSettingsError("設定の内容が不正です。")
    values = {"title": parse_title(body.get("title"))}
    logo = parse_logo(body.get("logo"))
    if logo:
        values["logo"] = logo
    settings_store.set_site_settings(values)
    return public_view(values)
