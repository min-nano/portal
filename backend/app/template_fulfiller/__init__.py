"""雛形を編集して生成物を得るツールの、共通の段取り。

現況検査レポート・構造計算安全証明書・必要壁量 計算ツールは、どれも

    ① 雛形を手に入れる → ② 入力を正規化し確かめる → ③ 雛形へ記入する
    → ④ 生成物を渡す

という同じ流れをしている。違うのは流れそのものではなく、その流れに渡す
パラメータ（雛形がどこにあるか・入力がどんな形か・どこへどう書き込むか・
生成物をどう渡すか）だけ——というのがこのパッケージの前提で、設計は
docs/template-fulfiller.md にある。

**ここに置くのは段取りだけ**で、道具（xlsx エディタ・PDF ライター・Docs の
一括置換）は土台に、記述（レシピ）はツール側にある。この 3 つを混ぜないので、
将来このディレクトリを別リポジトリへ切り離すと決めたときに動かすのは、
ここだけで済む（docs/template-fulfiller.md §2）。

移行は 1 ツールずつ進める（同 §8）。いま揃っているのは ① の雛形設定で、
現況検査レポートと構造計算安全証明書の 2 つが使っている。
"""

from .template_settings import (
    GOOGLE_DOC,
    XLSX,
    TemplateKind,
    require_template,
    save_template,
    template_status,
)

__all__ = [
    "GOOGLE_DOC",
    "XLSX",
    "TemplateKind",
    "require_template",
    "save_template",
    "template_status",
]
