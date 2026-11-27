"""利用者に見せられる失敗の、共通の形。

土台（認証・Drive・共有設定）もツール（生成・解析）も、失敗はこの形で
伝える。main.py の例外ハンドラが 1 つで足りるのはこのため——ツールが
増えてもハンドラは増えない。

この 1 つだけを別のモジュールに置いてあるのは、土台の中身（clerk_auth・
google_drive・settings_store）がこれを使う一方で、portal_sdk がその
土台を読み込むため（同じ場所に置くと循環する）。使う側は portal_sdk から
読めばよく、この位置を意識しなくてよい。
"""


class PortalError(Exception):
    """message はそのまま画面に出せる日本語、status は HTTP のステータス。

    code は、画面が文言ではなく種類で見分けたい失敗にだけ付ける目印
    （応答の本文に {"error": …, "code": …} として載る）。
    """

    def __init__(self, message: str, status: int = 400, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
