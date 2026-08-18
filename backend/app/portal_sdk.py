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
  TEMPLATE = Template(…)       →   Drive の雛形の設定（確認・保存・読み出し）
  resolve_pdf_destination(…)   →   「保存 / 別名で保存」の保存先の確認
  raise ToolError("…")         →   利用者に見せる日本語 + HTTP ステータス
"""

import re
from dataclasses import dataclass, field
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Header, Request, Response, UploadFile

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


# --- ファイル名 --------------------------------------------------------------
#
# 生成物に付ける名前の規則は、成果物が PDF でも xlsx でも同じ:
#
#   1. ファイル名に使えない文字を落とす
#   2. 拡張子を付ける
#   3. 空になったら既定値へ倒す
#
# ツールが渡すのは雛形（名前の作り方）と既定値だけ。
#
# 同じ規則は画面側（frontend/src/pdf-file-ops.js）にもある。wasm と違って
# 1 つの実装を共有できないので、**同じ入力に同じ答えを返すこと**を
# tests/file_name_cases.json で縛る（サーバと画面のテストが同じ表を読む）。

# ファイル名に使えない文字（Drive 上でも扱いづらいもの）。
_UNSAFE_FILE_NAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

# 差し込む値が空だったときに残る区切り（「証明書_.pdf」の「_」）。
_DANGLING_SEPARATOR = re.compile(r"_+(?=\.[^.]*$)|_+$")


def sanitize_file_name(name) -> str:
    """ファイル名に使えない文字と、前後の空白・ドットを落とす。"""
    return _UNSAFE_FILE_NAME_CHARS.sub("", str(name or "")).strip().strip(".").strip()


def ensure_file_name(name, default: str, extension: str = ".pdf") -> str:
    """整えたうえで拡張子を付ける。何も残らなければ既定値。"""
    cleaned = sanitize_file_name(name)
    if not cleaned:
        return default
    if cleaned.lower().endswith(extension.lower()):
        return cleaned
    return cleaned + extension


def build_file_name(
    template: str, values: dict, default: str, extension: str = ".pdf"
) -> str:
    """雛形に値を差し込んでファイル名を作る。

    差し込む値が空だと「証明書_.pdf」のように区切りだけが残るので、それも
    落とす（結果として、材料が無いときは既定値と同じ名前になる）。雛形が
    求める値が無いとき（KeyError）も既定値へ倒す。
    """
    try:
        name = template.format(**values)
    except (KeyError, IndexError):
        return default
    return ensure_file_name(
        _DANGLING_SEPARATOR.sub("", sanitize_file_name(name)), default, extension
    )


# --- 雛形の設定（Drive の「フォルダ + ファイル名」） --------------------------
#
# 雛形を Drive に置くツールは、ファイルの ID ではなく「親フォルダの ID +
# ファイル名」で覚える。同じフォルダへ同名で置き直せば、それが自動的に最新版に
# なるため。Picker から届くのはファイル ID だけなので、ゴミ箱・種類・親フォルダ
# の確認は必ず実行ユーザーの代理セッションから行う（本人に閲覧権限の無いファイル
# ID を送りつけても設定できない）。
#
# この段取りはツールによらず同じで、違うのは「許す種類」と、違うものが選ばれた
# ときの文言だけなので、それだけをツールが渡す。


@dataclass(frozen=True)
class Template:
    """Drive 上の雛形の設定。ツールは種類と文言だけを決める。

    ツールの側には、これを 1 つ作って 3 つのルートから呼ぶだけが残る。

      TEMPLATE = Template(tool_id=TOOL_ID, mime_type=…, error=…, …)

      GET  /template  →  TEMPLATE.status()
      PUT  /template  →  TEMPLATE.save(session, file_id)
      生成のとき      →  TEMPLATE.require(settings)

    settings を引数で受け取れるのは、1 リクエストの中で共有設定を 2 度読まない
    ため（読んだものをそのまま渡す）。省略すればここで読む。
    """

    tool_id: str
    #: 雛形として許すファイルの種類（.xlsx / Google ドキュメント）。
    mime_type: str
    #: このツールの失敗の型（利用者に見せる文言 + HTTP ステータス）。
    error: type = ToolError
    #: 違う種類のファイルが選ばれたときの文言。
    wrong_type_message: str = "選択できない種類のファイルです。"
    #: 雛形が未設定のまま生成しようとしたときの文言（409 で返す）。
    unconfigured_message: str = (
        "雛形が未設定です。画面の「雛形を設定」から、"
        "Google Drive 上の雛形ファイルを選択してください。"
    )

    def settings(self) -> dict:
        """このツールの共有設定を読む。"""
        return get_settings(self.tool_id)

    def status(self, settings: dict | None = None) -> dict:
        """設定の状態（GET /template の応答）。未設定でも失敗にはしない。"""
        settings = self.settings() if settings is None else settings
        file_name = settings.get("template_file_name", "")
        return {
            "configured": bool(settings.get("template_folder_id") and file_name),
            "fileName": file_name,
        }

    def require(self, settings: dict | None = None) -> tuple[str, str]:
        """雛形の置き場所を返す。未設定なら 409 で止める。"""
        settings = self.settings() if settings is None else settings
        folder_id = settings.get("template_folder_id", "")
        file_name = settings.get("template_file_name", "")
        if not folder_id or not file_name:
            raise self.error(self.unconfigured_message, 409)
        return folder_id, file_name

    def save(self, session, file_id) -> dict:
        """Picker で選ばれたファイルを確かめ、共有設定へ書く（PUT /template）。"""
        if not file_id or not isinstance(file_id, str):
            raise self.error("ファイルが選択されていません。")

        meta = google_drive.get_file_metadata(session, file_id)
        if meta.get("trashed"):
            raise self.error(
                "選択したファイルはゴミ箱に入っています。別のファイルを選択してください。"
            )
        if meta.get("mimeType") != self.mime_type:
            raise self.error(self.wrong_type_message)
        parents = meta.get("parents") or []
        if not parents:
            raise self.error(
                "選択したファイルの親フォルダを特定できませんでした。"
                "マイドライブ直下ではなくフォルダ内に雛形を置いてください。"
            )

        name = meta.get("name", "")
        set_settings(
            self.tool_id,
            {"template_folder_id": parents[0], "template_file_name": name},
        )
        return {"fileName": name, "folderId": parents[0]}


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


def save_pdf(session, destination: dict, pdf_bytes: bytes, **extra) -> dict:
    """PDF を保存し、画面へ返す形（保存方法と保存されたファイル）にして返す。

    extra はツールが添えるもの（証明書の warnings、計算書の verification）。
    """
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
    return {
        "mode": destination["mode"],
        "fileId": saved.get("id", ""),
        "fileName": saved.get("name", ""),
        "webViewLink": saved.get("webViewLink", ""),
        **extra,
    }


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


def pdf_parse_routes(
    router: APIRouter,
    path: str,
    parse,
    error=ToolError,
    default_name=lambda parsed: "",
) -> None:
    """成果物の PDF を読み戻す 2 本のルートを、そのツールの下に生やす。

    PDF そのものが保存形式になっているツール（証明書・計算書）は、どちらも
    「手元のファイルをアップロードする」と「Drive のファイルを開く」の
    2 経路で読み戻す。段取りはどちらも同じ——PDF を読み、解析し、開いている
    ファイルと次の保存に使う名前を添える——なので、ツールが渡すのは解析関数と、
    名前が分からないときの既定だけ。

      pdf_parse_routes(router, "/certificates", parse=…, error=…)
        →  POST <prefix>/certificates/parse        （アップロード）
           POST <prefix>/certificates/parse-drive  （Drive）
    """

    @router.post(f"{path}/parse")
    async def parse_uploaded(
        file: UploadFile = File(...), user: User = Depends(require_user)
    ):
        """アップロードされた PDF を解析してフォームデータへ変換する。"""
        parsed = parse(await read_upload(file, error))
        return {
            **parsed,
            # アップロードした PDF は Drive 上のファイルではないので上書き先にできない。
            "file": {"id": "", "name": file.filename or ""},
            "suggestedFileName": file.filename or default_name(parsed),
        }

    @router.post(f"{path}/parse-drive")
    async def parse_from_drive(request: Request, user: User = Depends(require_user)):
        """Drive 上の PDF を解析してフォームデータへ変換する。

        ここで返す file.id が、そのまま「上書き保存」の対象になる。
        """
        file_id = (await json_body(request)).get("fileId")
        session = delegated_session(user.email)
        content, meta = open_drive_pdf(session, file_id, error)
        return {
            **parse(content),
            "file": {"id": file_id, "name": meta.get("name", "")},
            "suggestedFileName": meta.get("name", ""),
        }


# --- 生成物をそのまま返す（ダウンロード） ------------------------------------


def download_response(
    content: bytes, file_name: str, media_type: str, headers: dict | None = None
) -> Response:
    """生成物をダウンロードさせる応答。

    ファイル名には日本語が入るので、RFC 5987 の filename* で渡す（素の
    filename= には非 ASCII を置けない）。headers は本文に入れられない
    情報を載せるツールのため（必要壁量ツールの突き合わせの結果）。
    """
    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(file_name)}",
            **(headers or {}),
        },
    )


# --- 画面とサーバの突き合わせ ------------------------------------------------
#
# 編集中の計算は画面（wasm）が行い、保存のときはサーバも同じ wasm で計算して
# 突き合わせる。この外枠——材料が届かないときの扱い・版の並記・差の打ち切り——
# はツールによらず同じで、違うのは**差の作り方**だけ。

# 突き合わせの結果に並べる差の上限（全項目が違うときに応答が膨れないように）。
MAX_REPORTED_DIFFERENCES = 20


def verify_claim(claim, differences) -> dict:
    """画面が出した値と、サーバが同じ wasm で出した値を突き合わせる。

    differences は「画面が送ってきた材料」を受け取って差の一覧を返す関数で、
    ツールが渡すのはこれだけ。材料が届かないとき（この仕組みより前の画面）に
    呼ばれないのは、無駄に計算しないため。

    ずれていても保存は止めない（成果物に入るのはサーバの値なので壊れない）。
    画面には警告として返し、利用者が気付けるようにする。
    """
    if not isinstance(claim, dict):
        # 画面が突き合わせの材料を送ってこない（＝この仕組みより前の版）。
        return {"checked": False, "ok": True, "differences": []}

    client_version = str(claim.get("coreVersion") or "")
    server_version = nail_core.version()
    found = list(differences(claim))

    return {
        "checked": True,
        "ok": not found and client_version == server_version,
        "coreVersion": {"client": client_version, "server": server_version},
        "differences": found[:MAX_REPORTED_DIFFERENCES],
        "omittedDifferences": max(0, len(found) - MAX_REPORTED_DIFFERENCES),
    }


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
