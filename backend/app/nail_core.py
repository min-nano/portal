"""釘配列諸定数の唯一の計算実装（wasm）を Python から呼ぶ。

計算そのもの・入力の解釈・表示する桁の丸めは、Rust で書いた 1 つの実装
（core/）に集約してある。ここはそれを wasm として読み込み、JSON を渡して
JSON を受け取るだけの薄い口。**画面（ブラウザ）が動かすのと同じバイト列**を
サーバも動かすので、実装が 2 つに分かれることがない。

  core/src/*.rs → core/build.sh → app/wasm/nail_array_core.wasm
                                    ├─ ここ（サーバ）が読み込む
                                    └─ /core.wasm で画面へ配る

.wasm はコミットしていない。テストとデプロイのたびに CI が作り直すので、
手元で動かすときは最初に 1 度 core/build.sh を実行すること。

呼び出しの手順（線形メモリの受け渡し）は core/src/abi.rs に書いてある。
"""

import gzip
import hashlib
import json
import threading
from pathlib import Path

from wasmtime import Engine, Instance, Module, Store

# core/build.sh が置く成果物。Cloud Run のイメージには app/ ごと入る。
WASM_PATH = Path(__file__).parent / "wasm" / "nail_array_core.wasm"

# 応答の先頭に付く「本体の長さ」（u32 リトルエンディアン）。
_LENGTH_PREFIX = 4


class CoreError(Exception):
    """計算実装が返した失敗。message はそのまま利用者に見せられる日本語。"""


class _Core:
    """読み込んだ wasm と、その呼び出し口。"""

    def __init__(self, wasm_bytes: bytes):
        self.wasm_bytes = wasm_bytes
        self.sha256 = hashlib.sha256(wasm_bytes).hexdigest()
        # 画面へ配るときは gzip で送る（wasm は 1/3 以下になる）。中身は
        # 起動のあいだ変わらないので、ここで 1 度だけ圧縮して持っておく
        # （リクエストごとに縮め直さない）。
        self.wasm_gzip = gzip.compress(wasm_bytes, 9)

        engine = Engine()
        self._store = Store(engine)
        exports = Instance(self._store, Module(engine, wasm_bytes), []).exports(self._store)
        self._memory = exports["memory"]
        self._alloc = exports["nac_alloc"]
        self._free = exports["nac_free"]
        self._call = exports["nac_call"]

        # wasmtime の Store は同時に 1 つの呼び出ししか扱えない。この API は
        # 数ミリ秒で終わるので、素直に直列化する。
        self._lock = threading.Lock()

        self.config = self.call({"op": "config"})
        self.version = self.config["version"]

    def call(self, request: dict) -> dict:
        """JSON の要求を渡し、JSON の応答を返す（失敗は CoreError）。"""
        payload = json.dumps(request, ensure_ascii=False).encode("utf-8")
        with self._lock:
            pointer = self._alloc(self._store, len(payload))
            try:
                self._memory.write(self._store, payload, pointer)
                response = self._call(self._store, pointer, len(payload))
            finally:
                self._free(self._store, pointer, len(payload))

            length = int.from_bytes(
                self._memory.read(self._store, response, response + _LENGTH_PREFIX),
                "little",
            )
            body = bytes(
                self._memory.read(
                    self._store,
                    response + _LENGTH_PREFIX,
                    response + _LENGTH_PREFIX + length,
                )
            )
            self._free(self._store, response, _LENGTH_PREFIX + length)

        result = json.loads(body.decode("utf-8"))
        if not result.get("ok"):
            raise CoreError(result.get("error") or "計算に失敗しました。")
        return result


_core: _Core | None = None
_load_lock = threading.Lock()


def core() -> _Core:
    """読み込み済みの計算実装を返す（最初の呼び出しで読み込む）。"""
    global _core
    if _core is None:
        with _load_lock:
            if _core is None:
                _core = _Core(_read_wasm())
    return _core


def _read_wasm() -> bytes:
    try:
        return WASM_PATH.read_bytes()
    except FileNotFoundError as error:
        # 成果物はコミットしていないので、作る前に動かすとここへ来る。
        # 何をすればよいかを、その場で言い切る。
        raise RuntimeError(
            f"計算実装（wasm）がありません: {WASM_PATH}\n"
            "リポジトリ直下で core/build.sh を実行して作成してください"
            "（要 rustup。README「計算の一元管理（Rust → wasm）」参照）。"
        ) from error


def call(request: dict) -> dict:
    return core().call(request)


def version() -> str:
    """計算実装の版（画面が使っているものと突き合わせる）。"""
    return core().version


def sha256() -> str:
    """配っている wasm のハッシュ。画面のキャッシュを版ごとに分けるのに使う。"""
    return core().sha256


def wasm_bytes() -> bytes:
    """画面へ配る wasm そのもの。"""
    return core().wasm_bytes


def wasm_gzip() -> bytes:
    """画面へ配る wasm を gzip で縮めたもの（Content-Encoding: gzip で返す）。"""
    return core().wasm_gzip


def config() -> dict:
    """計算実装が持つ上限値など（パターン数・釘本数の上限）。"""
    return core().config
