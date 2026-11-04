"""PR の判定を出すスクリプト（5xx での出し直し）の検証。

スクリプト本体は .github/scripts/claude-review-submit.sh にあるが、
テストを走らせる場所がここしか無いのでここに置く。

ネットワークは使わない。PATH の先頭に偽の gh を置き、レビューを出す
呼び出し（POST）への応答を順に決め、レビューの一覧は固定の JSON を返す。
"""

import json
import os
import shutil
import subprocess

import pytest

_SCRIPT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    ".github",
    "scripts",
    "claude-review-submit.sh",
)

pytestmark = pytest.mark.skipif(
    shutil.which("bash") is None or shutil.which("jq") is None,
    reason="bash と jq が要る",
)

# FAKE_CREATED_BY が n なら、n 回目の POST の後から一覧に created.json を
# 返す（5xx でもレビューが作られていた場合）。
#
# 応答は FAKE_POSTS（空白区切り）を先頭から 1 つずつ使う:
#   ok        成功
#   502       JSON の本文つきの 5xx（gh: 〈message〉 (HTTP 502)）
#   502-html  本文が JSON でない 5xx（gh: HTTP 502）
#   422       4xx
_FAKE_GH = r"""#!/usr/bin/env bash
if [[ "$*" == *--paginate* ]]; then
  n=$(cat "$FAKE_DIR/posts" 2> /dev/null | wc -l)
  if [ -n "$FAKE_CREATED_BY" ] && [ "$n" -ge "$FAKE_CREATED_BY" ]; then
    cat "$FAKE_DIR/created.json"
  else
    cat "$FAKE_DIR/reviews.json"
  fi
  exit 0
fi
printf '%s\n' "$*" >> "$FAKE_DIR/posts"
n=$(wc -l < "$FAKE_DIR/posts")
read -ra r <<< "$FAKE_POSTS"
case "${r[$((n - 1))]}" in
  ok) exit 0 ;;
  502) echo 'gh: Server Error (HTTP 502)' >&2; exit 1 ;;
  502-html) echo 'gh: HTTP 502' >&2; exit 1 ;;
  422) echo 'gh: Unprocessable Entity (HTTP 422)' >&2; exit 1 ;;
esac
"""

SINCE = "2026-11-04T10:00:00Z"


def review(state="APPROVED", body="body", sha="abc", at="2026-11-04T10:35:20Z",
           user="github-actions[bot]"):
    return {"user": {"login": user}, "commit_id": sha, "state": state,
            "body": body, "submitted_at": at}


@pytest.fixture
def submit(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    gh = bin_dir / "gh"
    gh.write_text(_FAKE_GH)
    gh.chmod(0o755)

    def run(event, posts, reviews=(), body="body", created_by=None):
        (tmp_path / "reviews.json").write_text(json.dumps(list(reviews)))
        (tmp_path / "created.json").write_text(json.dumps([review()]))
        env = {
            **os.environ,
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "FAKE_DIR": str(tmp_path),
            "FAKE_POSTS": " ".join(posts),
            "GITHUB_REPOSITORY": "o/r",
            "PR": "228",
            "HEAD_SHA": "abc",
            "SINCE": SINCE,
            "RETRY_DELAY": "0",
            "FAKE_CREATED_BY": str(created_by or ""),
        }
        result = subprocess.run(["bash", _SCRIPT, event, body], env=env,
                                capture_output=True, text=True, check=False)
        log = tmp_path / "posts"
        calls = log.read_text().splitlines() if log.exists() else []
        return result.returncode, calls, result.stderr

    return run


def test_posts_once_on_success(submit):
    code, calls, _ = submit("APPROVE", ["ok"])
    assert code == 0
    assert len(calls) == 1
    assert "event=APPROVE" in calls[0] and "commit_id=abc" in calls[0]


def test_4xx_fails_without_retry(submit):
    code, calls, err = submit("APPROVE", ["422"])
    assert (code, len(calls)) == (1, 1)
    assert "HTTP 422" in err


@pytest.mark.parametrize("failure", ["502", "502-html"])
def test_5xx_is_retried(submit, failure):
    code, calls, _ = submit("REQUEST_CHANGES", [failure, "ok"])
    assert (code, len(calls)) == (0, 2)


def test_5xx_that_still_created_the_review_is_not_posted_again(submit):
    code, calls, err = submit("APPROVE", ["502"], [review()])
    assert (code, len(calls)) == (0, 1)
    assert "付いていました" in err


@pytest.mark.parametrize("other", [
    review(state="CHANGES_REQUESTED"),
    review(body="other"),
    review(sha="old"),
    review(at="2026-11-04T09:00:00Z"),
    review(user="someone"),
])
def test_only_the_same_verdict_from_this_run_counts_as_posted(submit, other):
    code, calls, _ = submit("APPROVE", ["502", "ok"], [other])
    assert (code, len(calls)) == (0, 2)


def test_persistent_5xx_gives_up_with_code_2(submit):
    code, calls, err = submit("APPROVE", ["502"] * 4)
    assert (code, len(calls)) == (2, 4)
    assert "5xx を返しました" in err


def test_review_created_by_the_last_failed_attempt_counts(submit):
    # 4 回目（最後）の POST も 502 だが、レビューは作られていた。
    code, calls, _ = submit("APPROVE", ["502"] * 4, created_by=4)
    assert (code, len(calls)) == (0, 4)


def test_unknown_event_is_rejected(submit):
    code, calls, _ = submit("COMMENT", ["ok"])
    assert (code, calls) == (1, [])
