"""ツールが乗る土台。

ポータルの API は「土台 + ツール」で出来ている。ツールが持つのは
`/api/tools/<ツール名>/**` のルートだけで、そこで使う道具立て——認証、
代理アクセス、共有設定、PDF の保存先の解決、計算実装（wasm）の呼び出し、
エラーの返し方——はすべてここが出す。

複数のツールが同じことを書いていると分かったものは、ここへ寄せる
（洗い出しと順序は docs/shared-logic.md）。ツールに残るのは、そのツール
にしか出てこないものだけになる。

  ツール側                          ここ（土台）
  ─────────────────────────────    ─────────────────────────────
  TOOL = Tool(id=…, router=…)  →   main.py が /api/tools/<id> に載せる
  Depends(require_user)        →   Clerk JWT を検証して確定した本人
  delegated_session(email)     →   本人の代理で Drive を触るセッション
  resolve_pdf_destination(…)   →   「保存 / 別名で保存」の保存先の確認
  raise ToolError("…")         →   利用者に見せる日本語 + HTTP ステータス
"""

from dataclasses import dataclass, field

from fastapi import APIRouter, Header, Request, Response

from . import clerk_auth, google_drive, nail_core, settings_store
from .clerk_auth import User
from .errors import PortalError

# アップロードされる PDF の上限（証明書・計算書とも 1〜数ページ）。
MAX_UPLOAD_BYTES = 20 * 1024 * 1024


class ToolError(PortalError):
    """ツールが返す失敗（入力の不備・生成や解析の失敗）。"""


@dataclass(frozen=True)
class Tool:
    """ツールの名乗り。画面側のマニフェスト（tool.js）に対応するもの。

    id は URL とルートの接頭辞（/api/tools/<id>）になり、画面側の
    マニフェストの id と一致していなければならない。

    expose_headers は、本文ではなくヘッダに結果を載せるツールのためのもの。
    ここに挙げたものが CORS の Access-Control-Expose-Headers に入る
    （必要壁量ツールは本文が xlsx なので、突き合わせの結果をヘッダに載せる）。
    """

    id: str
    name: str
    router: APIRouter
    expose_headers: tuple[str, ...] = field(default=())


def tool_router(tool_id: str) -> APIRouter:
    """そのツールのルートを載せる APIRouter を作る。

    接頭辞をツール自身に書かせないのは、URL の決め方（/api/tools/<id>）が
    土台の決めごとだから。ツールが知っているのは自分の id だけでよい。
    """
    return APIRouter(prefix=f"/api/tools/{tool_id}")


def require_user(authorization: str | None = Header(default=None)) -> User:
    """Clerk セッション JWT を検証して、本人のメールアドレスを確定する。"""
    return clerk_auth.user_from_authorization_header(authorization)


async def json_body(request: Request) -> dict:
    """要求の本文を dict として読む（JSON でなければ空の dict）。"""
    try:
        body = await request.json()
    except Exception:
        body = None
    return body if isinstance(body, dict) else {}


async def read_upload(file, error=ToolError) -> bytes:
    """アップロードされたファイルを、上限を確かめながら読む。

    Content-Length（file.size）は自己申告なので、読んだあとの実長でも確かめる。
    """
    if file.size is not None and file.size > MAX_UPLOAD_BYTES:
        raise error("ファイルが大きすぎます（20MB まで）。", 413)
    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise error("ファイルが大きすぎます（20MB まで）。", 413)
    return content


# --- 共有設定（Firestore） ---------------------------------------------------


def get_settings(tool_id: str) -> dict:
    """そのツールの共有設定を読む（保存先のチャンネル分離は土台が面倒みる）。"""
    return settings_store.get_tool_settings(tool_id)


def set_settings(tool_id: str, values: dict) -> None:
    """そのツールの共有設定を書く。"""
    settings_store.set_tool_settings(tool_id, values)


# --- 代理アクセス（Drive / Docs） --------------------------------------------


def delegated_session(email: str):
    """本人の代理で Drive を**読む**セッション。"""
    return google_drive.delegated_session(email)


def delegated_write_session(email: str):
    """本人の代理で Drive を**読み書きする**セッション。"""
    return google_drive.delegated_write_session(email)


# --- PDF を Drive へ保存する（証明書・計算書の共通処理） ----------------------
#
# どちらのツールも、通常のアプリと同じ「保存」／「別名で保存」で PDF を
# Drive へ書き出す。保存先の確かめ方（上書き先が PDF か・保存先がフォルダか）
# は同じなので、ここにまとめてツールごとのエラー型とファイル名の既定値だけを
# 渡す。届くのは ID だけなので、種類・ゴミ箱の確認は必ず実行ユーザーの代理
# セッションから行う。


def resolve_pdf_destination(
    session, save, error=ToolError, ensure_name=lambda name: name, default_name=lambda: ""
) -> dict:
    """body.save から保存先を決め、実際に使えるかを確かめる。

    error はツールごとの例外クラス、ensure_name は拡張子の補正、default_name は
    ファイル名が指定されなかったときの既定値を作る関数。
    """
    save = save if isinstance(save, dict) else {}
    mode = save.get("mode") or "new"
    if mode not in ("new", "overwrite"):
        raise error("保存方法が不正です。")

    if mode == "overwrite":
        file_id = save.get("fileId")
        if not file_id or not isinstance(file_id, str):
            raise error("上書きするファイルが指定されていません。")
        meta = google_drive.get_file_metadata(session, file_id)
        if meta.get("trashed"):
            raise error("上書き先のファイルはゴミ箱に入っています。")
        if meta.get("mimeType") != google_drive.PDF_MIME:
            raise error("上書きできるのは PDF ファイルだけです。")
        return {"mode": mode, "fileId": file_id}

    # 新規保存の保存先は、そのつど画面の Picker で選ばれたフォルダ。
    folder_id = save.get("folderId")
    if not folder_id or not isinstance(folder_id, str):
        raise error("保存先のフォルダが選択されていません。")
    folder = google_drive.get_file_metadata(session, folder_id)
    if folder.get("trashed"):
        raise error("保存先のフォルダはゴミ箱に入っています。")
    if folder.get("mimeType") != google_drive.FOLDER_MIME:
        raise error("保存先にはフォルダを選択してください。")
    return {
        "mode": mode,
        "folderId": folder_id,
        "fileName": ensure_name(save.get("fileName") or default_name()),
    }


def save_pdf(session, destination: dict, pdf_bytes: bytes) -> tuple[str, dict]:
    """PDF を保存し、(保存方法, Drive のファイル情報) を返す。"""
    if destination["mode"] == "overwrite":
        saved = google_drive.update_file_content(
            session, destination["fileId"], pdf_bytes, google_drive.PDF_MIME
        )
    else:
        saved = google_drive.create_file(
            session,
            destination["folderId"],
            destination["fileName"],
            pdf_bytes,
            google_drive.PDF_MIME,
        )
    return destination["mode"], saved


def open_drive_pdf(session, file_id, error=ToolError) -> tuple[bytes, dict]:
    """Drive 上の PDF を、種類とゴミ箱を確かめてから読む。

    返す meta の id が、そのまま「上書き保存」の対象になる。
    """
    if not file_id or not isinstance(file_id, str):
        raise error("ファイルが選択されていません。")

    meta = google_drive.get_file_metadata(session, file_id)
    if meta.get("trashed"):
        raise error("選択したファイルはゴミ箱に入っています。")
    if meta.get("mimeType") != google_drive.PDF_MIME:
        raise error("PDF ファイルを選択してください。")

    content = google_drive.download_file(session, file_id, context="PDF のダウンロード")
    return content, meta


# --- 計算実装（wasm） --------------------------------------------------------


def wasm_response(request: Request) -> Response:
    """画面が編集中の計算に使う wasm を配る。

    サーバ自身が計算に使っているものと**同じバイト列**をそのまま返すので、
    「画面とサーバで実装が違う」状態が原理的に起こらない。URL には中身の
    ハッシュが付く（/config が配る）ため、内容が変わらないうちはブラウザの
    キャッシュから読ませ、変われば必ず取り直させる。

    この 226 kB ほどの取得は、画面が入力できるようになるまでの待ちに直接
    効くので、受け取れる相手には gzip（1/3 以下）で送る。縮めたものは
    起動時に 1 度だけ作って持っている（nail_core.wasm_gzip）。
    """
    headers = {
        "Cache-Control": "public, max-age=31536000, immutable",
        "ETag": f'"{nail_core.sha256()}"',
        # 同じ URL でも中身の符号化が 2 通りある（gzip / 生）ことを、
        # 途中のキャッシュへ知らせる。
        "Vary": "Accept-Encoding",
    }
    if "gzip" in request.headers.get("accept-encoding", ""):
        headers["Content-Encoding"] = "gzip"
        content = nail_core.wasm_gzip()
    else:
        content = nail_core.wasm_bytes()
    return Response(content=content, media_type="application/wasm", headers=headers)
