# Cloud Run 用コンテナ。gcloud run deploy --source backend でもこの Dockerfile が使われる。
FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# 釘配列諸定数の唯一の計算実装（core/ をビルドした wasm）。コミットしていない
# ので、ビルドの前に core/build.sh が置いておく必要がある（ワークフロー参照）。
# 抜けたまま出来上がると、動かしてみるまで気付けない「計算だけ動かないイメージ」
# になるため、ここで落とす。
RUN test -f app/wasm/nail_array_core.wasm || \
    (echo "app/wasm/nail_array_core.wasm がありません。core/build.sh を実行してからデプロイしてください。" >&2; exit 1)

# Cloud Run は PORT 環境変数で待ち受けポートを指定してくる。
ENV PORT=8080
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
