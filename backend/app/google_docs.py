"""Google ドキュメント API（プレースホルダーの一括置換）。

構造計算安全証明書の雛形は Google ドキュメントで、記入欄は {{…}} の
プレースホルダーになっている。雛形そのものは書き換えず、複製に対して
replaceAllText を掛けてから PDF へ書き出す。

Drive と同じく実行ユーザーの代理トークンで呼ぶため、雛形に編集権限が
無いユーザーでも「自分のドライブに複製して置換する」ところまでは行える。
"""

from google.auth.transport.requests import AuthorizedSession

from .google_drive import DriveError, api_error_detail

_DOCUMENTS_URL = "https://docs.googleapis.com/v1/documents"


def replace_all_text(
    session: AuthorizedSession, document_id: str, replacements: dict
) -> dict:
    """プレースホルダーを一括置換し、置換件数（プレースホルダーごと）を返す。

    件数を返すのは、雛形の改訂でプレースホルダーが消えたときに
    「置換されないままの欄がある」ことを呼び出し側が検知できるようにするため。
    """
    if not replacements:
        return {}

    placeholders = list(replacements)
    requests = [
        {
            "replaceAllText": {
                "containsText": {"text": placeholder, "matchCase": True},
                "replaceText": replacements[placeholder],
            }
        }
        for placeholder in placeholders
    ]

    resp = session.post(
        f"{_DOCUMENTS_URL}/{document_id}:batchUpdate", json={"requests": requests}
    )
    if not resp.ok:
        detail = api_error_detail(resp)
        message = f"雛形の書き換えに失敗しました (HTTP {resp.status_code})。"
        if resp.status_code in (401, 403):
            # 403 は「スコープが無い」だけでなく「GCP プロジェクトで Google Docs
            # API が有効になっていない」でも起きる。どちらかは Google の応答に
            # しか書かれていないため、必ずそれを添える。
            message = (
                f"雛形の書き換えが拒否されました (HTTP {resp.status_code})。"
                "GCP プロジェクトで Google Docs API (docs.googleapis.com) が"
                "有効になっているか、domain-wide delegation に Google ドキュメントの"
                "スコープ (https://www.googleapis.com/auth/documents) が登録されて"
                "いるかを確認してください。"
            )
        raise DriveError(f"{message}（Google からの応答: {detail}）" if detail else message, 502)

    replies = resp.json().get("replies") or []
    counts = {}
    for placeholder, reply in zip(placeholders, replies):
        detail = (reply or {}).get("replaceAllText") or {}
        counts[placeholder] = detail.get("occurrencesChanged", 0)
    return counts
