"""Drive 上の雛形を「フォルダ + ファイル名」で覚える（① 雛形の在り処）。

雛形を Drive から取るツールは、雛形そのものの ID ではなく **親フォルダの ID と
ファイル名**を共有設定に持つ。同じフォルダへ同名で置き直せば、それが自動的に
最新版として使われるためで、雛形の差し替えに設定の変更が要らない。

ファイルを選ぶのはブラウザ側の公式 Google Picker で、ここへ届くのは選ばれた
ファイル ID だけ。したがって種類・ゴミ箱・親フォルダの確認はすべてこちらで
行う。メタデータの取得は**実行ユーザーの代理**で行うので、本人に閲覧権限の
無いファイル ID を送っても通らない（GAS 版と同じ境界）。

この段取りは現況検査レポートと構造計算安全証明書で同一だった。違っていたのは
**許す種類とその文言だけ**なので、それを TemplateKind として外から渡す。
"""

from dataclasses import dataclass

from .. import google_drive, portal_sdk
from ..google_drive import GOOGLE_DOC_MIME, XLSX_MIME
from ..portal_sdk import ToolError


@dataclass(frozen=True)
class TemplateKind:
    """雛形として許す種類と、違うものが選ばれたときの文言。

    種類ごとに「なぜ駄目か」「どう直せばよいか」が違うので、MIME だけでなく
    文言もここに持たせる。自由な MIME 文字列ではなく名前つきの定数にして
    あるのは、種類が増えることは読み方・記入のしかたが増えることでもあり、
    レシピではなく段取りの側の変更になるのが正しいため。
    """

    mime: str
    wrong_kind_message: str


XLSX = TemplateKind(
    mime=XLSX_MIME,
    # Google スプレッドシートを選ぶとエクスポート形式が変わり、読み込みに
    # 失敗する。ネイティブ .xlsx だけを許す。
    wrong_kind_message=(
        "Google スプレッドシート等の形式はサポートされていません。"
        "Excel 形式 (.xlsx) のファイルを選択してください。"
    ),
)

GOOGLE_DOC = TemplateKind(
    mime=GOOGLE_DOC_MIME,
    wrong_kind_message=(
        "雛形は Google ドキュメントである必要があります。"
        "Word 形式などをアップロードしている場合は、Google ドキュメント形式へ変換してください。"
    ),
)


def template_status(tool_id: str) -> dict:
    """今の雛形設定の状態。画面の初期表示で使う。"""
    settings = portal_sdk.get_settings(tool_id)
    folder_id = settings.get("template_folder_id", "")
    file_name = settings.get("template_file_name", "")
    return {"configured": bool(folder_id and file_name), "fileName": file_name}


def save_template(
    tool_id: str, kind: TemplateKind, file_id, email: str, error=ToolError
) -> dict:
    """Picker で選ばれた雛形を確かめ、親フォルダ ID とファイル名を保存する。"""
    if not file_id or not isinstance(file_id, str):
        raise error("ファイルが選択されていません。")

    meta = google_drive.get_file_metadata(portal_sdk.delegated_session(email), file_id)
    if meta.get("trashed"):
        raise error(
            "選択したファイルはゴミ箱に入っています。別のファイルを選択してください。"
        )
    if meta.get("mimeType") != kind.mime:
        raise error(kind.wrong_kind_message)
    parents = meta.get("parents") or []
    if not parents:
        raise error(
            "選択したファイルの親フォルダを特定できませんでした。"
            "マイドライブ直下ではなくフォルダ内に雛形を置いてください。"
        )

    portal_sdk.set_settings(
        tool_id,
        {"template_folder_id": parents[0], "template_file_name": meta.get("name", "")},
    )
    return {"fileName": meta.get("name", ""), "folderId": parents[0]}


def require_template(settings: dict, message: str, error=ToolError) -> tuple[str, str]:
    """設定済みの雛形を (フォルダ ID, ファイル名) で取り出す。

    未設定は入力の不備ではなく「先に設定してください」という状態なので 409 で
    返す。案内の文言はツールによって指すものが違う（Excel の雛形 / 証明書の
    雛形）ため、呼び出し側から渡す。

    設定は 1 リクエストにつき 1 回だけ読めるよう、読んだ dict を受け取る。
    """
    folder_id = settings.get("template_folder_id", "")
    file_name = settings.get("template_file_name", "")
    if not folder_id or not file_name:
        raise error(message, 409)
    return folder_id, file_name
