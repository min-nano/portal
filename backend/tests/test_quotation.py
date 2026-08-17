"""見積書の PDF の組み立てと解析、共有設定の整え。

金額の計算そのものを検証するのは core（cargo test）で、ここで見るのは
**そこから先**——PDF に何が載るか、開き直して復元できるか、共有設定として
保存できる形になっているか。

**このファイルに実在の氏名・住所・金額は出てこない**（見積書という書類の
性質と、公開リポジトリであることから。docs/contract-formatter.md §8）。
"""

import io
import json

import pytest
from pdfminer.high_level import extract_text

from app import quotation
from app.quotation import QuotationError

# 架空の見積書。事務所の実在の値ではない。
FIXTURE = {
    "number": "20260099",
    "issuedOn": "2026-08-17",
    "expiresOn": "2026-09-30",
    "subject": "架空邸 構造設計業務",
    "client": {
        "name": "架空建築設計事務所",
        "honorific": "御中",
        "postalCode": "999-0001",
        "address": "架空県架空市架空町1-2-3",
        "department": "設計部",
        "contactName": "架空 太郎",
        "contactHonorific": "様",
    },
    "issuer": {
        "name": "架空 二級建築士事務所",
        "postalCode": "999-0002",
        "address": "架空県架空市架空1766番地6",
        "tel": "000-0000-0000",
        "personName": "架空 花子",
    },
    "items": [
        {
            "templateId": "structural-design",
            "title": "新築木造軸組建築物の構造計算及び構造図作成",
            "body": "2階建て、構造床面積約238㎡\n仕様規定(壁量計算)による設計とします。",
            "unitPrice": 284000,
            "quantity": 1,
            "taxCategory": "standard",
        }
    ],
    "remarks": "（架空の文例）お支払い期限は業務完了日の翌月末とします。",
}


def build(**overrides):
    data = quotation.normalize_data({**FIXTURE, **overrides})
    return data, quotation.validate(data)


# --- 計算（wasm へ委譲した結果が、そのまま使える形で返る） -------------------


def test_the_totals_match_the_way_quotations_are_written():
    _, computed = build()
    totals = computed["totals"]
    assert totals["subtotalText"] == "284,000"
    assert totals["taxText"] == "28,400"
    assert totals["totalText"] == "312,400"
    assert [bucket["label"] for bucket in totals["buckets"]] == ["10%対象"]


def test_the_default_file_name_carries_the_date_client_and_amount():
    """電子帳簿保存法の検索要件（取引年月日・取引先・取引金額）への備え。"""
    _, computed = build()
    assert quotation.default_file_name(computed) == "20260817_架空建築設計事務所_312400.pdf"


def test_a_quotation_without_the_essentials_is_refused():
    with pytest.raises(QuotationError):
        quotation.validate(quotation.normalize_data({**FIXTURE, "number": ""}))
    with pytest.raises(QuotationError):
        quotation.validate(quotation.normalize_data({**FIXTURE, "issuer": {}}))


def test_the_suggestion_uses_the_terms_that_match_the_work():
    """事務所の定型文は業務の系統ごと。設計の文が耐震診断に付かない。"""
    data = quotation.normalize_data(
        {
            **FIXTURE,
            "items": [
                {"templateId": "structural-design", "spec": {"scale": "2階建て"}},
                {
                    "templateId": "seismic-diagnosis",
                    "spec": {"floorArea": 120, "diagnosisMethod": "一般診断法"},
                },
            ],
        }
    )
    suggestions = quotation.suggest(
        data, {"design": "設計の但し書き", "seismic": "耐震の但し書き"}
    )
    assert suggestions[0]["title"] == "新築木造軸組建築物の構造計算及び構造図作成"
    assert suggestions[0]["body"].endswith("設計の但し書き")
    assert suggestions[1]["title"] == "木造住宅の耐震診断"
    assert "一般診断法により耐震診断を行います。" in suggestions[1]["body"]
    assert suggestions[1]["body"].endswith("耐震の但し書き")


def test_the_seismic_estimate_comes_from_the_notification():
    """告示第670号 別添二 別表第二（戸建木造住宅）による参考額。

    単価と率は架空の値（事務所の実際の設定値ではない）。
    """
    estimate = quotation.seismic_fee(
        {
            "work": "diagnosis",
            "structure": "detached-timber-house",
            "floorArea": 120,
            "settings": {
                "personnelUnitPrice": 8000,
                "technicalFeeRate": 10,
                "overheadMultiplier": 1.0,
            },
        }
    )
    assert estimate["applicable"] is True
    assert estimate["amount"] == 756000
    labels = [row["label"] for row in estimate["rows"]]
    # 告示第670号の費目は、第8号と違って検査費を持つ。
    assert "検査費" in labels
    assert "直接経費 + 間接経費" in labels


def test_the_seismic_estimate_stops_outside_the_table():
    outside = quotation.seismic_fee(
        {
            "work": "diagnosis",
            "structure": "detached-timber-house",
            "floorArea": 400,
            "settings": {"personnelUnitPrice": 8000},
        }
    )
    assert outside["applicable"] is False
    assert "別表第二" in outside["reason"]


# --- PDF ---------------------------------------------------------------------


def test_the_pdf_carries_what_a_quotation_has_to_show():
    data, computed = build()
    text = extract_text(io.BytesIO(quotation.build_pdf(data, computed)))

    for expected in (
        "御見積書",
        "20260099",
        "2026/08/17",
        "2026/09/30",
        "架空邸 構造設計業務",
        "架空建築設計事務所 御中",
        "架空 太郎 様",
        "架空 二級建築士事務所",
        "新築木造軸組建築物の構造計算及び構造図作成",
        "284,000",
        "312,400",
        "備考",
        "1 / 1",
    ):
        assert expected in text, f"{expected!r} が見積書に載っていない"


def test_a_quotation_that_does_not_fit_runs_onto_another_page():
    """合計欄が途中で切れた見積書を作らない（頁を足す）。"""
    items = [
        {
            "templateId": "seismic-diagnosis",
            "title": f"木造住宅の耐震診断（{index + 1}）",
            "body": "2階建て、延べ面積約120㎡\n一般診断法により耐震診断を行います。",
            "unitPrice": 250000,
        }
        for index in range(14)
    ]
    data, computed = build(items=items)
    text = extract_text(io.BytesIO(quotation.build_pdf(data, computed)))
    assert "1 / 2" in text
    assert "2 / 2" in text
    # 合計は最後の頁に必ずある。
    assert computed["totals"]["totalText"] in text


def test_the_input_survives_a_round_trip_through_the_pdf():
    data, computed = build()
    restored = quotation.parse_pdf(quotation.build_pdf(data, computed))
    assert restored == data


def test_a_pdf_from_somewhere_else_is_refused():
    with pytest.raises(QuotationError):
        quotation.parse_pdf(b"")
    with pytest.raises(QuotationError):
        quotation.parse_pdf(b"not a pdf")

    # PDF ではあるが、このツールが作ったものではない。
    from app import pdf_write

    document = pdf_write.Document()
    document.add_page().text(40, 700, "別の PDF")
    with pytest.raises(QuotationError) as error:
        quotation.parse_pdf(document.to_bytes())
    assert "このツールで作成した見積書 PDF ではない" in str(error.value)


def test_broken_embedded_input_is_reported_rather_than_crashing():
    from app import pdf_write

    document = pdf_write.Document()
    document.add_page().text(40, 700, "壊れた埋め込み")
    pdf = document.to_bytes({quotation.METADATA_KEY: "{壊れた"})
    with pytest.raises(QuotationError):
        quotation.parse_pdf(pdf)


# --- 突き合わせ --------------------------------------------------------------


def test_the_screens_amount_is_checked_against_the_servers():
    _, computed = build()
    claim = {
        "coreVersion": quotation.nail_core.version(),
        "totals": {"subtotal": 284000, "tax": 28400, "total": 312400},
    }
    assert quotation.verify(computed, claim)["ok"] is True

    wrong = {**claim, "totals": {**claim["totals"], "total": 999999}}
    result = quotation.verify(computed, wrong)
    assert result["ok"] is False
    assert result["differences"][0]["label"] == "合計"


def test_a_screen_running_an_older_core_is_flagged():
    _, computed = build()
    stale = {
        "coreVersion": "0.0.1",
        "totals": {"subtotal": 284000, "tax": 28400, "total": 312400},
    }
    assert quotation.verify(computed, stale)["ok"] is False


# --- 共有設定 ----------------------------------------------------------------


def test_the_repository_ships_no_office_specific_defaults():
    """公開リポジトリに事務所の値を置かない（docs/contract-formatter.md §8）。

    法定の消費税率と、告示第670号 第四 ロ の標準の倍数だけが既定を持つ。
    """
    settings = quotation.default_settings()
    assert settings["office"] == {
        "name": "",
        "postalCode": "",
        "address": "",
        "tel": "",
        "personName": "",
    }
    assert settings["terms"] == {"design": "", "seismic": ""}
    assert settings["remarks"] == ""
    assert settings["fee"]["personnelUnitPrice"] == 0
    assert settings["fee"]["technicalFeeRate"] == 0.0
    assert settings["fee"]["taxRate"] == 10.0
    assert settings["fee"]["overheadMultiplier"] == 1.0


def test_settings_are_normalised_before_they_are_stored():
    stored = quotation.normalize_settings(
        {
            "office": {"name": "  架空 二級建築士事務所  ", "unknown": "捨てる"},
            "terms": {"design": "設計の但し書き   \n\n"},
            "fee": {
                "taxRate": "8",
                "taxRounding": "とんでもない値",
                "personnelUnitPrice": "-100",
                "technicalFeeRate": "abc",
            },
            "somethingElse": 1,
        }
    )
    assert stored["office"]["name"] == "架空 二級建築士事務所"
    assert "unknown" not in stored["office"]
    assert stored["terms"]["design"] == "設計の但し書き"
    assert stored["terms"]["seismic"] == ""
    assert stored["fee"]["taxRate"] == 8.0
    assert stored["fee"]["taxRounding"] == "floor"
    assert stored["fee"]["personnelUnitPrice"] == 0
    assert stored["fee"]["technicalFeeRate"] == 0.0
    assert "somethingElse" not in stored


def test_the_tax_terms_belong_to_the_quotation_not_the_settings():
    """設定を変えても、作成済みの見積書の税額は変わらない。"""
    data, computed = build(tax={"taxRate": 8, "taxRounding": "ceil"})
    assert computed["totals"]["taxText"] == "22,720"
    # 書き出した PDF を読み戻しても、その条件のまま。
    restored = quotation.parse_pdf(quotation.build_pdf(data, computed))
    assert restored["tax"]["taxRate"] == 8
    assert restored["tax"]["taxRounding"] == "ceil"


def test_the_form_definition_comes_from_the_calculation_core():
    config = quotation.form_config("/api/tools/quotation-formatter/core.wasm")
    ids = [template["id"] for template in config["templates"]]
    assert "structural-design" in ids
    assert "seismic-diagnosis" in ids
    assert "seismic-retrofit-design" in ids
    # 耐震の 2 つだけが、告示第670号の別表の行を名乗る。
    seismic = {
        template["id"]: template["seismicWork"]
        for template in config["templates"]
        if template["seismicWork"]
    }
    assert seismic == {
        "seismic-diagnosis": "diagnosis",
        "seismic-retrofit-design": "retrofit-design",
    }
    assert config["core"]["url"].startswith("/api/tools/quotation-formatter/core.wasm?v=")


def test_file_names_are_kept_usable_on_drive():
    assert quotation.ensure_pdf_extension("見積書") == "見積書.pdf"
    assert quotation.ensure_pdf_extension("a/b:c") == "abc.pdf"
    assert quotation.ensure_pdf_extension("  ") == quotation.DEFAULT_FILE_NAME
    assert quotation.ensure_pdf_extension("x.PDF") == "x.PDF"


def test_the_embedded_input_is_json_the_tool_can_read_back():
    data, computed = build()
    pdf = quotation.build_pdf(data, computed)
    from app import pdf_tools

    raw = pdf_tools.read_metadata_value(pdf, quotation.METADATA_KEY)
    assert json.loads(raw) == data
