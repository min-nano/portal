# ツールをリポジトリごとに分ける（プラグイン構成）

このポータルは、ツールが増えるほど 1 つのリポジトリが大きくなる作りになっています。
ツールを 1 つ直すだけでも、リポジトリ全体を読み込む前提で作業することになり、
関係のないツールのコードまで目を通す必要が出てきます。

そこで **ツールを 1 つずつ別のリポジトリへ出し、portal はそれを組み込む土台にする**
という形へ移します。この文書は、その分け方・継ぎ目（契約）・版の固定のしかた・
更新の流れ・移行の順序をまとめたものです。

---

## 1. 分け方の原則

**「どのツールにも同じように効くもの」は portal に、「そのツールにしか出てこないもの」は
ツールのリポジトリに置く。**

この線を引くと、ツールを直すときに開くのはそのツールのリポジトリだけになり、portal を
開くのは「ツールを増やす・減らす」「版を上げる」「土台そのものを直す」ときだけになります。

そして分けるのは **画面だけではありません**。このポータルのツールは 1 つ 1 つが
**画面・API・計算の 3 層にまたがって**います。たとえば必要壁量 計算ツールは

| 層 | ファイル | 行数 |
| --- | --- | ---: |
| 画面 | `frontend/src/wall-quantity-calculator/` | 876 |
| API | `backend/app/wall_quantity.py` + `wall_quantity_mapping.json` + 配布物 | 500 + マッピング |
| 計算 | `core/src/wall_quantity.rs` + `column_strength.rs` | 1,971 |

という具合で、**画面だけを出しても大半が portal に残ります**。それでは「ツールを直すのに
portal を開かなくてよい」状態になりません。したがって **3 層をまとめて 1 つのリポジトリへ**
出します。

---

## 2. 全体像

```
                     min-nano/portal（土台）
  ┌───────────────────────────────────────────────────────────┐
  │ @min-nano/portal-ui   画面の土台（npm）                    │
  │   デザインシステム（色・寸法・部品の CSS）                  │
  │   Web Components・サインイン・API 呼び出し・Picker          │
  │   ページの入口の段取り・wasm の読み込み口                   │
  │                                                            │
  │ portal-sdk            API の土台（pip）                    │
  │   Clerk JWT 検証・代理アクセス（Drive / Docs）              │
  │   共有設定（Firestore）・PDF 組み立て・xlsx 編集            │
  │   wasm の実行・保存先の解決・エラーの返し方                 │
  │                                                            │
  │ portal-core           計算の土台（cargo）                   │
  │   JSON の読み書き・wasm の受け渡し口・有効桁の整形          │
  │                                                            │
  │ ホスト（組み立てと配布）                                    │
  │   ツール一覧のトップページ／Vite のビルド／FastAPI の組立   │
  │   Firebase Hosting・Cloud Run・CI/CD・PR プレビュー         │
  │   tools.json（どのツールのどの版を載せるか）                │
  └───────────────────────────────────────────────────────────┘
        ▲               ▲               ▲               ▲
        │ git tag       │ git tag       │ git tag       │ git tag
  ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐
  │ tool-     │   │ tool-     │   │ tool-     │   │ tool-     │
  │ excel-    │   │ structural│   │ timber-   │   │ wall-     │
  │ report-   │   │ -cert-    │   │ panel-    │   │ quantity- │
  │ formatter │   │ formatter │   │ shear-... │   │ calculator│
  └───────────┘   └───────────┘   └───────────┘   └───────────┘
   各リポジトリが「画面 + API + 計算 + テスト + ローカルプレビュー」を丸ごと持つ
```

### portal が持つもの / ツールが持つもの

| | portal（土台） | ツールのリポジトリ |
| --- | --- | --- |
| **画面** | 色・余白・字送りの原器（`tokens.css`）、素の要素（`base.css`）、骨組み（`layout.css`）、部品（`components.css`）、Web Components（`<portal-header>` 〜 `<portal-save-dialogs>`）、サインイン、`api.js`、`core.js`、Google Picker、`page-start.js`、デザインシステムの見本ページ | そのツールのページ（HTML）、`main.js` / `form-dom.js` / `form-logic.js`、**そのツールにしか出てこない CSS**（計測値の表・釘配列図・配布物にそろえた出力欄など）、そのツール専用の部品 |
| **API** | Clerk JWT の検証、代理アクセス（Drive / Docs）、共有設定（Firestore）、PDF ライター、xlsx エディタ、wasm の実行、PDF の保存先の解決、エラーの返し方、`/api/healthz`・`/api/me`・`/api/picker/**` | `/api/tools/<ツール名>/**` のルート、マッピング JSON、同梱する雛形・配布物、生成と解析 |
| **計算** | JSON の読み書き、wasm の受け渡し口（線形メモリ）、有効桁と 3 桁区切りの整形 | 式そのもの（グレー本 3.2・3.3、配布物の数式など）、入力の解釈、結果の組み立て |
| **配布** | Firebase Hosting・Cloud Run・Firestore ルール・CI/CD・PR プレビュー・ツール一覧・`tools.json` | ツール単体の CI（テスト）・タグ付け（リリース） |

> **デザインシステムは portal にしか無い。** ツール側で色や余白の生の値を書くことは
> ありません。ツールの CSS が使ってよいのは `tokens.css` の変数（`var(--s-3)` など）
> だけで、これが「全ツールの見た目がそろっている」ことを構造として保証します。

---

## 3. ツールリポジトリの構成

```
tool-wall-quantity-calculator/
  package.json              # @min-nano/tool-wall-quantity-calculator（npm パッケージ）
  web/
    tool.js                 # マニフェスト（このツールが何者かの名乗り）
    page.html               # ページの中身
    main.js                 # 画面の入口
    form-dom.js
    form-logic.js
    tool.css                # このツールにしか出てこない形
  api/
    pyproject.toml          # portal-tool-wall-quantity-calculator（pip パッケージ）
    portal_tool_wall_quantity/
      __init__.py           # TOOL（マニフェスト）と router を出す
      routes.py
      worksheet.py
      mapping.json
      templates/
  core/
    Cargo.toml              # portal-core に依存する cdylib
    src/lib.rs              # 呼び出し口（op の割り振り）
    src/wall_quantity.rs    # 式そのもの
  tests/                    # web（vitest）・api（pytest）・core（cargo test）
  dev/                      # ローカルプレビュー用のシェル（§6）
  .github/workflows/
    tests.yml               # 3 層のテスト
    release.yml             # タグを打つと wasm を作って検証し、リリースにする
```

**ツールのリポジトリだけで完結すること**（これが分割の目的そのものです）:

* `cargo test` … 式の検証
* `pytest` … 生成・解析・マッピング
* `vitest` … フォームの純粋ロジック・画面とデータの往復
* `npm run dev` … **portal を持ってこなくてもツールが動く**ローカルプレビュー（§6）

---

## 4. 3 つの継ぎ目（契約）

portal がツールを「知っている」形にすると、ツールを増やすたびに portal を書き換える
ことになります。そうではなく、**ツールが自分で名乗り、portal はそれを読む**形にします。

### 4.1 画面の継ぎ目 — マニフェスト

ツールの npm パッケージは、マニフェストを既定の書き出しとして持ちます。

```js
// web/tool.js
export default {
  id: 'wall-quantity-calculator',      // URL（/tools/<id>/）と API の接頭辞になる
  name: '小規模木造建築物 必要壁量 計算ツール',
  description: '日本住宅・木材技術センターが配布している…',  // トップページの説明
  page: './page.html',                  // ページの中身
  entry: './main.js',                   // 画面の入口
};
```

portal 側の Vite プラグイン（`frontend/tools-plugin.js`）が、これを読んで

1. `frontend/tools/<id>/index.html` に **ページを組み立てる**（ヘッダー・読み込み中の
   表示・サインインゲートという全ページ共通の外枠に、ツールの `page.html` を挟む）
2. その `index.html` をマルチページビルドの入口に加える
3. トップページ（`frontend/index.html`）の **ツール一覧を作る**

を行います。ツールを増やすときに portal で触るのは `tools.json` の 1 行だけになり、
`vite.config.js` にも `index.html` にもツールの名前は出てきません。

> **外枠を portal が組み立てるのはなぜか。** ヘッダー・読み込み中の表示・サインイン
> ゲートは、順序と `id` にまで意味があります（`page-start.js` のコメント参照）。
> これを 4 つのページに写して回ると必ずずれるので、ツールに書かせず portal が
> 差し込みます。ツールが書くのは `<div id="app">` の中身だけです。

### 4.2 API の継ぎ目 — ルーター

ツールの pip パッケージは、マニフェストと FastAPI のルーターを出します。

```python
# api/portal_tool_wall_quantity/__init__.py
from portal_sdk import Tool
from .routes import router

TOOL = Tool(
    id="wall-quantity-calculator",
    name="小規模木造建築物 必要壁量 計算ツール",
    router=router,          # /api/tools/<id> の下に載る
    wasm="wall_quantity",   # 使う .wasm（無ければ None）
)
```

portal の `backend/app/main.py` は、登録されたツールを順に載せるだけになります。
ツールごとの `if` も、ツール名の定数も持ちません。

ルーターの中でツールが使えるのは `portal_sdk` が出すものだけです:

| `portal_sdk` が出すもの | 中身 |
| --- | --- |
| `require_user` | Clerk JWT を検証して確定したメールアドレス |
| `delegated_session` / `delegated_write_session` | 本人の代理で Drive / Docs を触るセッション |
| `settings.get(tool_id)` / `settings.set(tool_id, …)` | 共有設定（チャンネルの分離込み） |
| `resolve_pdf_destination` / `save_pdf` | 「保存 / 別名で保存」の保存先の確かめと書き込み |
| `core(tool_id)` | そのツールの wasm（JSON を渡して JSON を受け取る） |
| `wasm_response(tool_id, request)` | `/core.wasm` の配り方（gzip・ETag・キャッシュ） |
| `ToolError` | 利用者に見せる日本語と HTTP 状態を持つ失敗 |

> **エラー型を 1 つにまとめます。** 今は `ReportError` / `CertificateError` /
> `PanelShearError` / `WallQuantityError` が同じ形（`message` + `status`）で 4 つ
> 並んでいて、`main.py` にそれぞれの例外ハンドラがあります。これを
> `portal_sdk.ToolError` の 1 つにすると、ツールが増えても portal は増えません。

### 4.3 計算の継ぎ目 — ツールごとの wasm

今は 1 つの `.wasm` に全ツールの計算が入っていて、面材張り大壁と必要壁量が
**同じバイト列**を受け取っています。分割後は **ツールごとに 1 つの `.wasm`** になります。

```
tool-xxx/core/src/*.rs
  └─ cargo build --target wasm32-unknown-unknown
       └─ <id>.wasm
            ├─ サーバ（portal_sdk が wasmtime で動かす）
            └─ GET /api/tools/<id>/core.wasm → 画面
```

**「画面とサーバが同じバイト列を動かす」という今の保証は変わりません。**
むしろ強くなります。分割後は、その `.wasm` を **ツールのリポジトリの CI が作り、
`tools.json` に SHA-256 を書いて固定する**ため、portal のバージョン上げ PR の差分に
「計算の中身が変わった」ことがハッシュとして現れます。

* `portal-core`（portal 側）… `json.rs`・`abi.rs`・`format.rs`。式を持たない土台
* ツール側 … 式そのもの・入力の解釈・結果の組み立て

保存時の突き合わせ（画面の値とサーバの値を照らす仕組み）はツール側に残ります。
版番号はツールの `Cargo.toml` の `version` になり、「画面が古い」の検出はこれまで
どおり機能します。

---

## 5. 版の固定と、取り込み方

### 5.1 `tools.json` が唯一の在り処

portal のリポジトリの根に、載せるツールと版を並べた 1 枚のファイルを置きます。

```json
{
  "tools": [
    {
      "id": "wall-quantity-calculator",
      "repo": "min-nano/tool-wall-quantity-calculator",
      "version": "1.4.0",
      "wasm_sha256": "9a75fe29…"
    }
  ]
}
```

ここから 3 つの取り込み経路が導かれます（生成スクリプトが `package.json` と
`requirements.txt` の該当行を書き換えるので、人が触るのは `tools.json` だけです）。

| 層 | 取り込み方 |
| --- | --- |
| 画面 | `npm` の git 依存 … `"@min-nano/tool-x": "github:min-nano/tool-x#v1.4.0"` |
| API | `pip` の git 依存 … `portal-tool-x @ git+https://github.com/min-nano/tool-x@v1.4.0#subdirectory=api` |
| 計算 | タグのリリース成果物 `<id>.wasm` を取得し、`wasm_sha256` と照合する |

**なぜ git タグ直参照か。** npm レジストリや PyPI を用意せず、認証も要らず、
タグを打った時点で版が確定します。バージョン上げ PR は `tools.json` の
数行の差分になり、何が変わったのかがそのまま読めます。

### 5.2 循環しないようにする

ツールは portal の土台（`portal-ui` / `portal-sdk` / `portal-core`）に依存し、
portal はツールに依存します。素直に書くと循環しますが、**土台を peer 依存にする**
ことで解けます。

| 層 | ツール側の宣言 | 実際に使われるもの |
| --- | --- | --- |
| 画面 | `peerDependencies: { "@min-nano/portal-ui": "^2" }`（`devDependencies` にも同じ版を置く） | portal のビルドでは **portal 自身の portal-ui**。ツール単体では dev 依存のもの |
| API | `dependencies = ["portal-sdk>=2,<3"]` | pip が 1 つに解決する |
| 計算 | `portal-core = "2"` | cargo が semver 互換の版を 1 つにまとめる |

この形なら、デザインシステムが二重に読み込まれることも、ツールごとに違う版の
土台が混ざることもありません。**ツールは「土台のこの版の範囲で動く」ことだけを
宣言し、実際にどの版で動くかは portal が決めます。**

---

## 6. ツール単体でのテストとローカルプレビュー

分割の目的は「ツールを直すのに portal を開かなくてよい」ことなので、
**ツールのリポジトリだけでプレビューできる**必要があります。

```bash
# ツールのリポジトリで
npm run dev        # http://localhost:5173/ にそのツールのページが出る
```

これを成立させるのが `dev/` のシェルです。中身は portal のホストとほぼ同じで、
違うのは 2 つだけです。

1. **載せるツールが 1 つだけ**（`tools.json` の代わりに、自分自身を相対パスで指す）
2. **サインインと Drive を省略できる**

サインインの省略は `portal-ui` / `portal-sdk` の開発モードで行います。

| | 通常 | `PORTAL_DEV_AUTH=1` |
| --- | --- | --- |
| 画面 | Clerk のサインインゲート | ゲートを飛ばし、固定の利用者として始める |
| API | JWT を検証してメールを確定 | 固定のメールアドレスを返す |

これで **Clerk の鍵が無くてもツールの画面と API を動かせます**。Drive・Docs・
Firestore に実際に触る部分（雛形の取得・PDF の保存）は、今と同じく認証情報が
要ります。触らずに済むツール（必要壁量 計算ツールなど）は、鍵が 1 つも無い状態で
最後まで動かせます。

> **開発モードは portal の本番ビルドには存在しません。** `PORTAL_DEV_AUTH` を
> 読むのは `portal-sdk` の開発用の入口（`portal_sdk.dev`）だけで、本番の
> `backend/app/main.py` はこの入口を読み込みません。画面側も同じく、開発用の
> 分岐はビルド時の定数で落とします。設定漏れで認証が外れることが構造として
> 起こらないようにするためです。

---

## 7. 更新の流れ

```
① ツールのリポジトリ
     PR → レビュー → main へマージ
     タグ v1.4.0 を打つ
       └─ release.yml が wasm を作り、SHA-256 を添えてリリースにする

② portal のリポジトリ
     tools.json の version と wasm_sha256 を書き換える PR
       └─ preview.yml が PR ごとのプレビュー環境を作る
            Hosting: pr-<番号> チャンネル
            Cloud Run: portal-api-pr-<番号>
            Firestore: preview-channels/pr-<番号>

③ プレビュー URL で確認 → マージ → 本番へデプロイ
```

**ツール側の CI が見るのはそのツールだけ、portal 側の CI が見るのは組み合わせだけ**
という分担になります。ツールのテストが portal で走り直すことはありません（同じ
テストを 2 回走らせても、分かることは増えないため）。portal の CI が確かめるのは
「その版の組み合わせでビルドが通り、画面が出て、API が応えるか」です。

②の PR は手で作っても 3 行の差分ですが、ツール側の `release.yml` から自動で
起こすこともできます（portal への書き込み権限を持つトークンが要ります）。
まずは手で起こし、回数が増えてから自動化するのがよいと考えています。

---

## 8. トレードオフ（正直なところ）

分割には costs があります。採用する前に把握しておくべきものを挙げます。

**得られるもの**

* ツールを直すときに読む範囲が、そのツールだけになる
* ツールごとに CI が回るので、他のツールの失敗に巻き込まれない
* 「どのツールがどの版で動いているか」が `tools.json` に残る
* ツールの追加・削除が、portal の 3 行の差分になる

**払うもの**

* **土台を直すと N 回の追従が要る。** `portal-ui` の部品の形を変えると、影響を
  受けるツールのリポジトリでそれぞれ PR を起こすことになります。今は 1 回で
  済んでいます。→ 土台の変更は後方互換を保ち、破壊的変更はメジャー版を上げて
  ツール側が自分の都合で追従できるようにします。
* **横断的な変更が跨ぐ。** 「全ツールの保存ダイアログの文言を直す」は 5 リポジトリの
  作業になります。→ 文言や振る舞いの共通部分は極力 `portal-ui` 側へ寄せます。
* **リリースの手数が増える。** タグを打つ・版を上げる、が 1 往復増えます。
  → これは意図した往復でもあります（プレビューで確認する場が明示的にできる）。

**分割しない選択肢との比較。** 「1 リポジトリのままディレクトリを整理し、
`CLAUDE.md` で読む範囲を導く」でも、読み込み量はある程度減らせます。分割が
それより優れているのは、**構造として保証される**点です（別リポジトリにあるものは
そもそも読み込めない）。一方で、上に挙げた払うものは分割にしか発生しません。
ツールが 4 つの今は拮抗していますが、増える見通し（グレー本 3.4〜3.6、真壁、
水平構面…）を踏まえると分割側が有利と判断しています。

---

## 9. 移行の順序

一度に全部は動かしません。**継ぎ目を先に作り、確かめてから、1 ツールずつ外へ出します。**

| | やること | 状態 |
| --- | --- | --- |
| **第 1 段** | **portal 側に受け口を作る。** ツールがマニフェストを名乗り、Vite のビルド入口・トップページのツール一覧・API のルートがそれを読む形にする。ツールは portal の中に置いたまま、**境界だけ先に確定させる** | この PR |
| 第 2 段 | 土台を 3 つのパッケージ（`portal-ui` / `portal-sdk` / `portal-core`）として切り出し、portal 自身がそれを使う形にする。まだ外へは出さない | 次 |
| 第 3 段 | いちばん依存の少ないツール（現況検査レポート作成ツール。計算を持たず、API も 4 本）を別リポジトリへ出し、`tools.json` から取り込む。**ここで往復が一巡する** | |
| 第 4 段 | 残り 3 つを 1 つずつ出す。計算を持つ 2 つ（面材張り大壁・必要壁量）は、`core/` の分割を伴う | |
| 第 5 段 | portal からツールのコードが無くなる。README をツールごとに分け、portal の README は土台と組み立ての説明だけにする | |

第 1 段（この PR）で確定するのは次の 3 点です。

* ツールは `web/tool.js` 相当のマニフェストで自分を名乗る
* ツールのページは、portal が組み立てる共通の外枠に挟まる
* ツールの API は 1 本の `APIRouter` にまとまり、`/api/tools/<id>` に載る

この 3 点が満たされていれば、あとの段でファイルを別リポジトリへ動かす作業は
**移動と依存の付け替えだけ**になり、設計の作り直しは起こりません。
