"""ポータル全体の設定（表示名とロゴ）の API テスト。

共有設定（Firestore）は conftest のフェイクに差し替えてある。
"""

import base64

import pytest

from app import site_settings

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
SVG = b'<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'


def data_url(content: bytes, mime_type: str) -> str:
    return f"data:{mime_type};base64,{base64.b64encode(content).decode()}"


def test_unset_settings_are_empty(client):
    resp = client.get("/api/site")

    assert resp.status_code == 200
    assert resp.json() == {"title": "", "logo": None}
    # 変更がすぐ届くよう、キャッシュさせない。
    assert resp.headers["cache-control"] == "no-store"


def test_settings_can_be_read_before_sign_in(anon_client, drive):
    """サインイン画面のヘッダーにも出すので、認証なしで読める。"""
    drive.site = {"title": "設計室ポータル"}

    resp = anon_client.get("/api/site")

    assert resp.status_code == 200
    assert resp.json()["title"] == "設計室ポータル"


def test_saving_requires_sign_in(anon_client, drive):
    resp = anon_client.put("/api/site", json={"title": "乗っ取り"})

    assert resp.status_code == 401
    assert drive.site == {}


@pytest.mark.parametrize(
    "content, mime_type",
    [(PNG, "image/png"), (SVG, "image/svg+xml")],
)
def test_save_and_read_back_title_and_logo(client, drive, content, mime_type):
    resp = client.put(
        "/api/site",
        json={"title": "  設計室   ポータル ", "logo": data_url(content, mime_type)},
    )

    assert resp.status_code == 200
    expected = {"title": "設計室 ポータル", "logo": data_url(content, mime_type)}
    assert resp.json() == expected
    # Firestore には種類と base64 に分けて置く。
    assert drive.site == {
        "title": "設計室 ポータル",
        "logo": {"mime_type": mime_type, "data": base64.b64encode(content).decode()},
    }
    assert client.get("/api/site").json() == expected


def test_saving_without_logo_removes_it(client, drive):
    drive.site = {"title": "a", "logo": {"mime_type": "image/png", "data": "AAAA"}}

    resp = client.put("/api/site", json={"title": "b", "logo": None})

    assert resp.json() == {"title": "b", "logo": None}
    assert drive.site == {"title": "b"}


def test_type_is_decided_by_content_not_by_the_declared_type(client, drive):
    """申告が PNG でも、中身が SVG なら SVG として保存する。"""
    resp = client.put("/api/site", json={"title": "", "logo": data_url(SVG, "image/png")})

    assert resp.status_code == 200
    assert drive.site["logo"]["mime_type"] == "image/svg+xml"


@pytest.mark.parametrize(
    "logo",
    [
        data_url(b"GIF89a....", "image/gif"),
        data_url(b"\xff\xd8\xff\xe0 jpeg", "image/jpeg"),
        data_url(b"<html><svg></svg></html>", "image/svg+xml"),
        "data:image/png;base64,***",
        "https://example.com/logo.png",
        123,
    ],
)
def test_rejects_what_is_not_png_or_svg(client, drive, logo):
    resp = client.put("/api/site", json={"title": "x", "logo": logo})

    assert resp.status_code == 400
    assert drive.site == {}


def test_rejects_a_logo_that_is_too_large(client, drive):
    content = PNG + b"\x00" * site_settings.MAX_LOGO_BYTES

    resp = client.put("/api/site", json={"title": "x", "logo": data_url(content, "image/png")})

    assert resp.status_code == 413
    assert "256KB" in resp.json()["error"]
    assert drive.site == {}


@pytest.mark.parametrize("title", ["あ" * (site_settings.MAX_TITLE_LENGTH + 1), 1, ["x"]])
def test_rejects_an_invalid_title(client, drive, title):
    resp = client.put("/api/site", json={"title": title})

    assert resp.status_code == 400
    assert drive.site == {}


def test_rejects_a_body_that_is_not_an_object(client, drive):
    resp = client.put("/api/site", content=b"[]", headers={"Content-Type": "application/json"})

    assert resp.status_code == 400


def test_broken_stored_logo_is_not_returned(client, drive):
    drive.site = {"title": 5, "logo": {"mime_type": "text/html", "data": "PGI+"}}

    assert client.get("/api/site").json() == {"title": "", "logo": None}
