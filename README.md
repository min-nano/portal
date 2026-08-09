# 社内ポータル (portal)

社内向けツールをまとめる Web ポータルです。GAS（Google Apps Script）で運用してきたツールを、デプロイ・URL 管理の制約が少ない構成へ移行していきます。

最初のツールとして、[gas-addon-excel-report-formatter](https://github.com/h-ikeda/gas-addon-excel-report-formatter) と同等の **現況検査レポート作成ツール**（傾斜測定 報告フォーム → Excel 出力）を実装しています。

## 🏗 システム構成

| レイヤー | 技術 | 役割 |
| --- | --- | --- |
| フロントエンド | **Firebase Hosting** + Vite (vanilla JS) | モバイル最適化の入力フォーム。`/api/**` は Hosting のリライトで Cloud Run へ転送（同一オリジン） |
| 認証 | **Clerk**（Google ログインのみ有効化） | サインインとセッション JWT の発行 |
| バックエンド | **Cloud Run**（FastAPI / Python） | Clerk JWT の検証、Excel 生成（openpyxl）、Drive アクセス |
| データ保存 | **Google Workspace の Drive** / Firestore | Drive: Excel 雛形（社外秘フォーマット）。Firestore: 全利用者共通の設定 |

### セキュリティ / 権限モデル（GAS 版との対応）

GAS 版は「ウェブアプリにアクセスしているユーザーとして実行」する設定により、雛形の読み取りが実行ユーザー本人の権限で行われていました。本ポータルは同じ保証を次の 2 段で再現します。

1. **Clerk セッション JWT の検証**（バックエンド）
   - Clerk の JWKS で署名を検証し、`exp` / `iss` / `azp` を確認して、トークンからユーザーの **メールアドレス** を取り出す。
   - 許可ドメイン（`ALLOWED_EMAIL_DOMAINS`）以外のアカウントは 403。
2. **代理アクセストークン（domain-wide delegation）**
   - 確認したメールアドレスのユーザーとして、サービスアカウントが **読み取り専用スコープ** (`drive.readonly`) の代理トークンを取得し、Workspace の Drive API を呼ぶ。
   - つまり雛形の取得・検索は常に **本人の Drive 権限の範囲内** で行われる。雛形にアクセス権の無いユーザーは、サインインできても雛形を読めない（GAS 版と同じ UX・同じ境界）。

全利用者共通の設定（雛形フォルダ ID・ファイル名。GAS 版のスクリプトプロパティ相当）は **Firestore** に保存します。人が直接編集できる Drive 上の JSON ファイルと違い、管理ユーザーの誤操作で設定が壊れるリスクがなく、アクセスはランタイム SA の IAM（`roles/datastore.user`）だけで完結します。delegation のスコープも広げません。保存先は環境（チャンネル）ごとに分かれています（「共有設定（Firestore）」参照）。

```
ブラウザ (Firebase Hosting)
  │  Authorization: Bearer <Clerk セッション JWT>
  ▼
Firebase Hosting  ──  /api/** リライト  ──▶  Cloud Run (portal-api)
                                              │ 1. Clerk JWKS で JWT 検証 → email 確定
                                              │ 2. 共有設定（雛形の場所）を Firestore から取得
                                              │ 3. email の代理トークンで Drive から雛形取得
                                              │ 4. openpyxl で報告書生成 → xlsx を返却
                                              ▼
                                Google Workspace Drive / Firestore
```

## ✨ 現在の機能（現況検査レポート作成ツール）

GAS 版の機能をそのまま移植しています。

* 物件名・複数部屋（追加/削除可能）・各部屋の計測点（床 X/Y/斜め・壁 上下/左右・柱 上下/左右）の入力
* 新しい部屋の階数は直前の部屋の値で初期化（最初の部屋は 1 階）
* 出力前の簡易バリデーション（警告のみ。しきい値等は `backend/app/mapping.json` の `validation`）
* `傾斜測定` シートへの正確なセルマッピング（`backend/app/mapping.json` で一元管理）
* 雛形（社外秘フォーマット）は Drive 上のファイルを参照。同フォルダに同名で差し替えると自動で最新版を使用
* 「雛形を設定」から雛形ファイルを検索して選択（Google Picker の代替。本人に閲覧権限のあるファイルだけが候補になる）
* 生成した xlsx のダウンロード

**GAS 版からの改善**: フォーム定義とバリデーション設定は `/api/tools/excel-report-formatter/config` が `mapping.json` から導出して配信するため、フロントエンドの定数（旧 `MEASUREMENT_GROUPS` / `VALIDATION`）を手動で同期する作業が不要になりました。`mapping.json` が単一の情報源です。

## 📁 リポジトリ構成

```
frontend/                     # Firebase Hosting に載せる SPA (Vite)
  index.html                  # ポータルトップ（ツール一覧）
  tools/excel-report-formatter/index.html
  src/auth.js                 # Clerk（サインインゲート・トークン取得）
  src/api.js                  # Bearer 付き fetch ラッパー
  src/excel-report-formatter/ # フォーム本体（GAS 版 index.html の移植）
backend/                      # Cloud Run サービス (FastAPI)
  app/main.py                 # API ルート
  app/clerk_auth.py           # Clerk JWT 検証
  app/google_drive.py         # 代理トークン・Drive API
  app/settings_store.py       # 共有設定（Firestore）
  app/excel_report.py         # Excel 生成（旧 functions/main.py の移植）
  app/mapping.json            # セルマッピング（単一の情報源）
firestore/                    # Firestore セキュリティルールとそのテスト
  firestore.rules             # クライアント SDK からのアクセスを全面拒否（deny-all）
  tests/rules.test.js         # エミュレータでルールを検証
firebase.json                 # Hosting 設定（/api/** → Cloud Run リライト）・Firestore ルールの参照
.github/workflows/            # tests.yml（CI）/ deploy.yml（本番 CD）/ preview.yml・preview-cleanup.yml（PR プレビュー）
```

## ⚙️ セットアップ

### 1. Clerk

1. Clerk でアプリケーションを作成する。**本番（production）インスタンス** は `main` のデプロイに、**開発（development）インスタンス** は PR プレビューに使う。
2. **両インスタンス** で以下を設定する:
   - **SSO connections で Google のみを有効化** し、Email/Password などその他のサインイン手段はすべて無効にする。
   - **Sessions → Customize session token** に以下を設定する（バックエンドがメールアドレスを取り出すために必須）:
     ```json
     {"email": "{{user.primary_email_address}}"}
     ```
3. API Keys から **Publishable Key** を控える。本番（`pk_live_...`）はリポジトリ変数 `CLERK_PUBLISHABLE_KEY`、開発（`pk_test_...`）は `CLERK_PUBLISHABLE_KEY_TEST` に設定する（ローカル開発ではどちらかを `VITE_CLERK_PUBLISHABLE_KEY` として渡す）。
4. 本番ドメイン（Firebase Hosting の URL / カスタムドメイン）を本番インスタンスに登録する。開発インスタンスにはプレビュー URL のパターン（後述の「PR プレビュー」参照）を Allowed origins に登録する。

> Secret Key はこの構成では使いません（バックエンドは JWKS 公開鍵で検証するだけ）。

### 2. GCP プロジェクト

```bash
PROJECT_ID=<your-gcp-project-id>
REGION=asia-northeast1

# 必要な API を有効化
gcloud services enable run.googleapis.com iamcredentials.googleapis.com \
  drive.googleapis.com firestore.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com \
  --project "$PROJECT_ID"

# ランタイム用サービスアカウント（Cloud Run にアタッチし、代理トークンにも使う）
gcloud iam service-accounts create portal-api --project "$PROJECT_ID"
SA=portal-api@"$PROJECT_ID".iam.gserviceaccount.com

# 鍵ファイルなしで代理トークンを作るため、SA が自分自身の署名権限を持つようにする
gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --member "serviceAccount:$SA" \
  --role roles/iam.serviceAccountTokenCreator \
  --project "$PROJECT_ID"

# ソースデプロイ（gcloud run deploy --source）のビルドは既定で Compute Engine の
# デフォルト SA として実行される。新しめのプロジェクトではこの SA に Editor が
# 付かないため、ビルドに必要なロールを明示的に付与する（ソース zip の読み取り・
# ログ書き込み・Artifact Registry への push をカバー。CI からのデプロイにも効く）。
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role roles/cloudbuild.builds.builder
```

### 3. Domain-wide delegation（代理アクセス）

1. サービスアカウントの詳細画面で **一意の ID（クライアント ID）** を控える。
2. Google Workspace 管理コンソール → セキュリティ → アクセスとデータ管理 → **API の制御 → ドメイン全体の委任** で、そのクライアント ID に対して次のスコープを登録する:
   ```
   https://www.googleapis.com/auth/drive.readonly
   ```
   ※ 読み取り専用のみ。委任スコープはこれ以上広げない。

### 4. 共有設定（Firestore）

GAS 版のスクリプトプロパティに相当する、全利用者共通の設定置き場です。人が直接編集できるファイルに置くと管理ユーザーの誤操作で設定が壊れる恐れがあるため、Firestore を使います。手動でのデータ投入は不要で、画面の「雛形を設定」から保存されます。

```bash
# Firestore データベース（Native モード）を作成し、ランタイム SA に読み書き権限を付与
gcloud firestore databases create --location "$REGION" --project "$PROJECT_ID"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:$SA" \
  --role roles/datastore.user
```

#### 保存先（チャンネル）

同じデータベースの中を **チャンネル** 単位で分け、本番・開発・PR プレビューが互いのデータを踏まないようにしています。ドキュメント ID はツール名（例: `excel-report-formatter`）です。

| チャンネル | パス | 使う環境 |
| --- | --- | --- |
| production | `static-channels/production/tool_settings/<ツール名>` | `main`（本番の Cloud Run） |
| development | `static-channels/development/tool_settings/<ツール名>` | **既定**。ローカル開発 |
| プレビュー | `preview-channels/pr-<番号>/tool_settings/<ツール名>` | PR プレビュー（PR ごと） |

どのチャンネルを使うかは環境変数 `SETTINGS_ROOT`（コレクションパス）で決まります。**未設定のときは development** を指し、本番を指すのは `SETTINGS_ROOT=static-channels/production/tool_settings` を明示的に設定した Cloud Run サービスだけです。環境変数の設定漏れ・ローカル開発・壊れたワークフローのいずれからも本番データに到達できないため、設定ミスの症状は必ず「設定が空に見える」であり、「本番を汚す」は起こりません。

`preview-channels` と `static-channels` を分けているのは後片付けのためでもあります。プレビューの削除（`preview-cleanup.yml`）は `preview-channels/pr-<番号>` の再帰削除だけを行い、本番データのある `static-channels` は削除処理の射程の外にあります。

**セキュリティルール**: Firestore にアクセスするのはバックエンド（IAM 認可のサーバークライアント。ルールの対象外）だけなので、クライアント SDK からのアクセスは `firestore/firestore.rules` で **全面拒否** しています。ルールは CI（`main` への push）で Hosting と一緒に自動デプロイされ、deny-all であることをエミュレータのテストで検証しています。ルールは `match /{document=**}` でネストしたパスまで覆うため、チャンネルを増やしてもルールの変更は不要です。

#### 既存データの移行（チャンネル導入時に一度だけ）

チャンネル分割の前は、共有設定がコレクション `tool_settings` の直下（`tool_settings/<ツール名>`）にありました。新しい配置へ移すには、**本番へデプロイする前に** 次の順で作業します。

1. 既存のドキュメントを `static-channels/production/tool_settings/` 配下へコピーする（ツールごとに 1 ドキュメントなので Firebase コンソールでの手作業で十分）。
2. 本番の Cloud Run に `SETTINGS_ROOT` を設定する。CI は本番サービスに環境変数を渡さない方針のため、ここは手動で一度だけ行う:
   ```bash
   gcloud run services update portal-api \
     --region "$REGION" --project "$PROJECT_ID" \
     --update-env-vars SETTINGS_ROOT=static-channels/production/tool_settings
   ```
3. その後に PR をマージする。

順序が重要です。2 を先に済ませておけば、旧コードは未知の環境変数を無視するだけなので無害で、新コードが出た瞬間から正しいパスを読みます。逆に新コードが先に出ると、本番が既定の development チャンネル（空）を読み、雛形設定が消えたように見えます（データは失われず、`SETTINGS_ROOT` を設定すれば復帰します）。移行が済んだら、旧パスの `tool_settings` コレクションは削除して構いません。

雛形ファイル自体は GAS 版と同じ運用です: ネイティブ .xlsx のままフォルダ内に置き、社内の閲覧可能者だけに共有する（SA への共有は不要。読むのは常に利用者本人の代理トークン）。

### 5. Cloud Run 初回デプロイ

```bash
# Hosting のサイト ID（https://<SITE_ID>.web.app の <SITE_ID> 部分）。
# 通常はプロジェクト ID と同じだが、別のサブドメインになった場合はその値を使う。
# プレビュー URL（https://<SITE_ID>--pr-N-xxxx.web.app）もサイト ID が基準になる。
SITE_ID=<Hosting のサイト ID>

# 値にカンマ（複数指定）を含むため、区切り文字を ; に変える ^;^ 記法でまとめて渡す。
# （@ や , は SA のメールアドレス・複数指定の値に含まれるため区切り文字に使えない）
gcloud run deploy portal-api \
  --source backend \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --service-account "$SA" \
  --allow-unauthenticated \
  --set-env-vars "^;^CLERK_ISSUER=https://<本番の Clerk Frontend API>;CLERK_AUTHORIZED_PARTIES=https://<your-hosting-domain>,https://$SITE_ID.web.app;ALLOWED_EMAIL_DOMAINS=<your-workspace-domain>;DWD_SERVICE_ACCOUNT_EMAIL=$SA;SETTINGS_ROOT=static-channels/production/tool_settings"
```

* Firebase Hosting のリライト経由で呼び出すため `--allow-unauthenticated` が必要です（アプリ層の認可は Clerk JWT 検証で行う。Cloud Run の URL を直接叩かれても JWT が無ければ 401）。
* 2 回目以降のデプロイは CI が `gcloud run deploy --source backend` を実行するだけで、環境変数・SA・公開設定は引き継がれます。

| 環境変数 | 用途 |
| --- | --- |
| `CLERK_ISSUER` | 許可する Clerk の Frontend API URL（JWT の `iss`。カンマ区切りで複数可）。本番サービスには **本番インスタンスのみ** を設定する（プレビューは PR ごとの別サービスが開発インスタンスを受け持つ） |
| `CLERK_AUTHORIZED_PARTIES` | 許可するフロントエンドのオリジン（JWT の `azp` 検証。カンマ区切り、`*` ワイルドカード可）。本番サービスには本番のオリジンのみを設定する |
| `ALLOWED_EMAIL_DOMAINS` | 利用を許可するメールドメイン（カンマ区切り） |
| `DWD_SERVICE_ACCOUNT_EMAIL` | 代理トークンに使う SA のメール（省略時は ADC から推定） |
| `SETTINGS_ROOT` | 共有設定を置く Firestore のコレクションパス。本番は `static-channels/production/tool_settings`。**未設定だと development チャンネルを指す**（「共有設定（Firestore）」参照） |
| `FIRESTORE_DATABASE` | （任意）共有設定の Firestore データベース名。既定 `(default)` |
| `CORS_ALLOWED_ORIGINS` | （任意）CORS 許可オリジン。既定 `http://localhost:5173` |

### 6. Firebase Hosting

1. **同じ GCP プロジェクト** に Firebase を追加し、Hosting の既定サイトを作成する。コンソールからでも、CLI（Cloud Shell 等）からでもよい:
   ```bash
   firebase login --no-localhost   # 初回のみ（gcloud とは認証が別）
   firebase projects:addfirebase "$PROJECT_ID"
   gcloud services enable firebasehosting.googleapis.com
   firebase hosting:sites:create "$PROJECT_ID" --project "$PROJECT_ID"  # 既定サイト（通常はプロジェクト ID と同名）
   ```
   サイト ID はグローバルに一意のため、プロジェクト ID が使えず **別のサブドメインになる場合がある**。実際のサイト ID は `firebase hosting:sites:list` で確認し、`CLERK_AUTHORIZED_PARTIES` のプレビュー URL パターン等にはその値を使うこと。プロジェクトに複数サイトを作る場合は `firebase.json` の `hosting` に `"site": "<サイトID>"` を明示する（1 サイトのみなら省略可）。
2. `.firebaserc` の `default` をプロジェクト ID に書き換える。
3. 初回は手動デプロイで確認できる:
   ```bash
   cd frontend && VITE_CLERK_PUBLISHABLE_KEY=pk_... npm ci && npm run build && cd ..
   npx firebase-tools deploy --only hosting,firestore:rules --project "$PROJECT_ID"
   ```
4. カスタムドメインを使う場合は、Firebase コンソール → Hosting → 「カスタムドメインを追加」で接続する（所有権確認と DNS 設定はコンソールのみ）。接続したら、リポジトリ変数 `CANONICAL_HOST` にそのホスト名（例 `portal.example.com`）を設定する。本番ビルドに埋め込まれ、`<サイトID>.web.app` / `.firebaseapp.com` へのアクセスをカスタムドメインへリダイレクトする（`frontend/src/canonical-host.js`）。

   > Firebase Hosting のリダイレクト設定はパスにしかマッチできずホスト名で振り分けられないため、この寄せ替えはフロントエンド側で行っている。PR プレビュー（`<サイトID>--pr-N-xxxx.web.app`）とローカル開発はリダイレクト対象外。

`firebase.json` の `rewrites` により `/api/**` が Cloud Run の `portal-api`（asia-northeast1）へ転送されます。サービス名やリージョンを変えた場合はここも合わせてください。

### 7. GitHub Actions（CI/CD）

`main` への push で本番デプロイ（`.github/workflows/deploy.yml`）、PR で Hosting のプレビューデプロイ（`.github/workflows/preview.yml`。後述）が走ります。Settings → Secrets and variables → Actions に以下の **Variables** を設定してください。

| 変数 | 用途 |
| --- | --- |
| `PROJECT_ID` | デプロイ先 GCP プロジェクト ID |
| `WIF_PROVIDER` | Workload Identity プールのプロバイダ名（`projects/.../providers/...`） |
| `SA_EMAIL` | デプロイ実行用サービスアカウントのメール |
| `CLERK_PUBLISHABLE_KEY` | 本番ビルドに埋め込む Clerk Publishable Key（**本番インスタンス** `pk_live_...`） |
| `CLERK_PUBLISHABLE_KEY_TEST` | プレビュービルドに埋め込む Clerk Publishable Key（**開発インスタンス** `pk_test_...`） |
| `CANONICAL_HOST` | 本番のカスタムドメイン（例 `portal.example.com`）。`.web.app` へのアクセスをここへリダイレクトする。未設定ならリダイレクトしない |
| `SITE_ID` | Hosting のサイト ID。プレビュー用 Cloud Run の許可オリジン `https://<サイトID>--pr-<番号>-*.web.app` の組み立てに使う |
| `RUNTIME_SA_EMAIL` | Cloud Run のランタイム SA のメール（本番の `portal-api` と同じもの）。プレビュー用サービスの作成時に渡す |
| `CLERK_ISSUER_TEST` | Clerk **開発インスタンス** の Frontend API URL。プレビュー用バックエンドの `CLERK_ISSUER` になる |
| `ALLOWED_EMAIL_DOMAINS` | 利用を許可するメールドメイン（カンマ区切り）。プレビュー用バックエンドに渡す（本番はサービスに設定済みの値を使う） |

JSON キーは使わず WIF（キーレス）で認証します。WIF とデプロイ用 SA は以下のように作成できます（Cloud Shell 等）:

```bash
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
GITHUB_REPO=<owner/repo>

# デプロイ専用 SA とロール
gcloud iam service-accounts create deployer --display-name "GitHub Actions deployer" --project "$PROJECT_ID"
DEPLOY_SA=deployer@"$PROJECT_ID".iam.gserviceaccount.com
# run.admin は run.developer の上位。プレビュー用サービスを CI から新規作成する
# 際の --allow-unauthenticated（run.services.setIamPolicy）に必要。
# artifactregistry.repoAdmin と datastore.user は、PR クローズ時にイメージと
# プレビューの共有設定を削除するために必要（writer / なし では消せない）。
for role in roles/run.admin roles/storage.admin roles/cloudbuild.builds.editor \
  roles/artifactregistry.repoAdmin \
  roles/datastore.user \
  roles/serviceusage.serviceUsageConsumer roles/firebasehosting.admin \
  roles/firebaserules.admin roles/firebase.viewer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:$DEPLOY_SA" --role "$role" --condition=None
done
gcloud iam service-accounts add-iam-policy-binding "portal-api@$PROJECT_ID.iam.gserviceaccount.com" \
  --member "serviceAccount:$DEPLOY_SA" --role roles/iam.serviceAccountUser --project "$PROJECT_ID"

# ソースデプロイのビルドは Compute デフォルト SA として実行されるため、
# deployer にはビルド SA を使う権限（actAs）も必要
gcloud iam service-accounts add-iam-policy-binding \
  "${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --member "serviceAccount:$DEPLOY_SA" --role roles/iam.serviceAccountUser --project "$PROJECT_ID"

# Workload Identity プール + GitHub OIDC プロバイダ（このリポジトリからのみに制限）
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com --project "$PROJECT_ID"
gcloud iam workload-identity-pools create github --location global \
  --display-name "GitHub Actions" --project "$PROJECT_ID"
gcloud iam workload-identity-pools providers create-oidc github-actions \
  --location global --workload-identity-pool github \
  --issuer-uri "https://token.actions.githubusercontent.com" \
  --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition "assertion.repository == '$GITHUB_REPO'" \
  --project "$PROJECT_ID"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --member "principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$GITHUB_REPO" \
  --role roles/iam.workloadIdentityUser --project "$PROJECT_ID"

# リポジトリ変数に設定する値
echo "WIF_PROVIDER = projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github-actions"
echo "SA_EMAIL     = $DEPLOY_SA"
```

リポジトリ変数は GitHub の Settings 画面のほか、`gh` CLI（`gh variable set <名前> -R <owner/repo> --body <値>`）でも設定できます。

### 8. PR プレビュー（`.github/workflows/preview.yml`）

PR を開く・push するたびに、その PR 専用の **プレビュー環境一式** を作り、URL を PR コメントに掲示します。フロントエンドだけでなくバックエンドと共有設定も本番から切り離されるため、プレビューでの操作が本番に影響することはありません。

| 環境 | Hosting | Clerk | バックエンド | 共有設定（Firestore） |
| --- | --- | --- | --- | --- |
| `main`（本番） | 本番チャンネル（`deploy.yml`） | 本番インスタンス（`CLERK_PUBLISHABLE_KEY`） | Cloud Run `portal-api` | `static-channels/production/…` |
| PR プレビュー | `pr-<番号>` チャンネル（`preview.yml`） | 開発インスタンス（`CLERK_PUBLISHABLE_KEY_TEST`） | Cloud Run `portal-api-pr-<番号>` | `preview-channels/pr-<番号>/…` |
| ローカル開発 | Vite dev サーバー | 開発インスタンス | ローカルの uvicorn | `static-channels/development/…`（既定） |

`preview.yml` の流れ:

1. フロントエンドを開発インスタンスのキーでビルドする。
2. **Cloud Run に `portal-api-pr-<番号>` をデプロイする。** 本番（`deploy.yml`）と違い、ランタイム SA・公開設定・環境変数を毎回すべて渡すので、サービスが無ければ作成・あれば更新となり、**初回に手動でサービスを作る必要はありません**。`SETTINGS_ROOT` にはこの PR 専用の Firestore パスを渡します。
3. `firebase.json` の `/api/**` リライト先をこの PR のサービスに書き換える。チャンネルのデプロイはそのときの `firebase.json` をリリースに焼き込むため、この書き換えはこの PR のチャンネルにだけ効きます（リポジトリの `firebase.json` は本番の `portal-api` を指したまま）。
4. プレビューチャンネル `pr-<番号>` へデプロイし、URL を PR にコメントする（最終デプロイから 7 日で失効）。

順序に意味があります。Hosting のリライト先サービスはチャンネルのデプロイ時点で存在している必要があるため、Cloud Run が先です。プレビュー URL のハッシュ部分はデプロイするまで分かりませんが、`https://<サイトID>--pr-<番号>-*.web.app` というパターンは PR 番号だけから決まるので、その PR のチャンネルだけに絞った `CLERK_AUTHORIZED_PARTIES` を先に設定できます。

PR クローズ時は `preview-cleanup.yml` が、チャンネル・Cloud Run サービス・そのサービスのコンテナイメージ・`preview-channels/pr-<番号>` 配下の Firestore データをまとめて削除します。

プレビューを動かすための前提:

1. **Clerk 開発インスタンス** にも本番と同じ設定を行う（Google のみ有効化・セッショントークンの `email` クレーム）。開発インスタンスは既定で任意のオリジンからの利用を許可するため、プレビュー URL のための追加設定は通常不要。オリジンを明示的に制限したい場合のみ、**Allowed origins** を Backend API で設定する（ダッシュボードに UI は無い。渡した配列で全置換される点に注意）:
   ```bash
   curl -X PATCH https://api.clerk.com/v1/instance \
     -H "Authorization: Bearer <開発インスタンスの Secret Key (sk_test_...)>" \
     -H "Content-Type: application/json" \
     -d '{"allowed_origins": ["https://<サイトID>--pr-*.web.app", "http://localhost:5173"]}'
   ```
   （サイト ID は Hosting の既定サイトのサブドメイン。プロジェクト ID と異なる場合がある。）
2. リポジトリ変数 `CLERK_PUBLISHABLE_KEY_TEST` / `SITE_ID` / `RUNTIME_SA_EMAIL` / `CLERK_ISSUER_TEST` / `ALLOWED_EMAIL_DOMAINS` を設定する（前掲の表）。
3. デプロイ用 SA に `roles/run.admin`・`roles/artifactregistry.repoAdmin`・`roles/datastore.user` があること（前掲のコマンドで付与済み）。`--allow-unauthenticated` を伴う新規サービス作成には `run.services.setIamPolicy` が要るため、`roles/run.developer` のままだと最初のプレビューで権限エラーになります。

> 組織ポリシー `constraints/iam.allowedPolicyMemberDomains` が `allUsers` を禁止している環境では、公開の Cloud Run サービスを作れません。本番の `portal-api` が公開で動いていれば、このプロジェクトでは通っています。

> デプロイ用のリポジトリ変数（`WIF_PROVIDER` など）が未設定・不正な間は、プレビューのジョブは失敗します（設定の壊れに気付けるよう、意図的にスキップしない）。

> **注意**: 分離されるのは Hosting・Clerk・バックエンド・共有設定です。**Drive 上の雛形ファイルは本番と共有** されます（同じ Workspace の同じファイルのため）。プレビューの共有設定は空の状態から始まるので、雛形フォルダはプレビュー内で改めて指定してください。テスト用のフォルダを指定すれば、Drive も実質的に分離できます。

> PR ごとにコンテナをビルドするため、プレビューのデプロイは push ごとに数分かかります（`gcloud run deploy --source` が Cloud Build を経由するため）。

## 🧑‍💻 ローカル開発

```bash
# バックエンド（要: SA の JSON 鍵 or gcloud ADC。Drive/Firestore を触らない範囲なら無くても起動する）
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
CLERK_ISSUER=https://xxxx.clerk.accounts.dev \
GOOGLE_APPLICATION_CREDENTIALS=~/keys/portal-api-dev.json \
.venv/bin/uvicorn app.main:app --reload --port 8080
# SETTINGS_ROOT は未設定でよい。既定の development チャンネル
# （static-channels/development/tool_settings）を読み書きするため、
# ADC を持っていても本番の共有設定には触れない。

# フロントエンド（/api は vite が localhost:8080 へプロキシ）
cd frontend
cp .env.example .env   # VITE_CLERK_PUBLISHABLE_KEY を設定
npm install
npm run dev
```

## 🧪 テスト

旧リポジトリのテスト（Cloud Function の pytest・GAS の jest）を新構成に移植しています。CI（`.github/workflows/tests.yml`）が push / PR ごとに実行します。

```bash
# バックエンド: API 経由の Excel 生成・雛形設定・JWT 検証（Drive/Firestore と認証はテスト内でフェイク）
cd backend && python -m pytest

# フロントエンド: フォームの純粋ロジック（バリデーション・数値正規化）
cd frontend && npm test

# Firestore ルール: クライアント SDK からのアクセスが全面拒否されること
# （エミュレータを自動起動する。要 Java ランタイム）
cd firestore && npm ci && npm test
```

## 🗺 セルマッピング (`backend/app/mapping.json`)

「フォームの入力値を Excel のどのセルに書き込むか」「フォームの計測点・選択肢・バリデーション」は `backend/app/mapping.json` に集約しています。フォーマットが微修正された場合は、原則このファイルを編集するだけで（フロントエンド・バックエンドのコード変更なしに）追従できます。ファイル先頭の `_readme` とマッピングの考え方は旧リポジトリから引き継いでいます。

### フォーマット改訂時の読み取り・マッピング更新手順（重要）

見た目のラベルで判断すると解釈を誤ります。必ず以下の客観的な情報源を順に確認してください。

1. **データ入力規則（プルダウン）を最優先の正とする。** プルダウンが付いているセルが「記入欄」、付いていない文字は「印字済みラベル」。
2. **結合セルでブロックの繰り返し構造と記入欄の左上アンカーを把握する。** 繰り返しの先頭行の並びが `block_start_rows`、ブロック内の相対行が `row_offset`。
3. **数式・区切り文字・分母などの固定値は記入欄ではない。** マッピングに含めず、書き込み・クリアの対象にしない。

`openpyxl` での抽出スニペット:

```python
from openpyxl import load_workbook

wb = load_workbook("新しい雛形.xlsx")            # 数式も見たいので data_only=False（既定）
ws = wb["傾斜測定"]

# 1) プルダウン（記入欄と選択肢の正）。formula1 が選択肢、sqref が対象セル範囲。
for dv in ws.data_validations.dataValidation:
    print("options=", dv.formula1, "| cells=", dv.sqref)

# 2) 結合セル（ブロック構造・記入欄のアンカー）。
for mc in sorted(ws.merged_cells.ranges, key=lambda r: (r.min_row, r.min_col)):
    print(mc)

# 3) 値のあるセル（ラベル・記入例・数式の確認）。
for row in ws.iter_rows():
    for c in row:
        if c.value not in (None, ""):
            print(c.coordinate, repr(c.value))
```

反映の原則:

* `select.col` / `select.options` はプルダウンの列・選択肢を **そのまま** 写す（並び順・記号も雛形通り。勝手に選択肢を足さない。`―` は U+2015）。
* 選択値は数値化・正規化せず文字列のまま書き込み、プルダウン候補と完全一致させる。
* 変更後は `backend/tests/` の期待値（mapping.json から自動解決される）が通ることを確認する。フロントエンドは `/config` 経由で自動追従するため変更不要。

## 🚀 ロードマップ

- [x] **Phase 1: ポータル基盤**
  - Firebase Hosting + Clerk + Cloud Run + 代理アクセスの基盤構築と CI/CD。
  - 現況検査レポート作成ツール（GAS 版と同等機能）の移植。
- [ ] **Phase 2: 移行の完了と拡張**
  - 旧 GAS 版からの利用切り替え・GAS の廃止。
  - 「非破壊検査」フォーマットへのマッピング対応、画像アップロード機能。
- [ ] **Phase 3: AI（Gemini API）連携による自動化**
  - 手書き図面の画像から計測値を抽出し、フォームに初期値を自動設定。
- [ ] **Phase 4: 実運用向けチューニング**
  - 生成した Excel の Drive への自動保存（delegation スコープの見直しが必要）など。
