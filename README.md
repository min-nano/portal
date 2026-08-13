# 社内ポータル (portal)

社内向けツールをまとめる Web ポータルです。GAS（Google Apps Script）で運用してきたツールを、デプロイ・URL 管理の制約が少ない構成へ移行していきます。

最初のツールとして、[gas-addon-excel-report-formatter](https://github.com/h-ikeda/gas-addon-excel-report-formatter) と同等の **現況検査レポート作成ツール**（傾斜測定 報告フォーム → Excel 出力）を実装しています。続いて **構造計算安全証明書 作成ツール**（第四号書式の証明書 → PDF を Drive へ保存 / 既存 PDF の編集）、[gas-timber-panel-shear-calculator](https://github.com/min-nano/gas-timber-panel-shear-calculator) から移植した **面材張り大壁 計算ツール**（グレー本 3.3・3.2 の計算 → 計算書 PDF）、**小規模木造建築物 必要壁量 計算ツール**（フォーム入力 → 日本住宅・木材技術センターの表計算ツールに記入した Excel を出力）を追加しました。

## 🏗 システム構成

| レイヤー | 技術 | 役割 |
| --- | --- | --- |
| フロントエンド | **Firebase Hosting** + Vite (vanilla JS) | モバイル最適化の入力フォーム。`/api/**` は Hosting のリライトで Cloud Run へ転送（同一オリジン） |
| 認証 | **Clerk**（Google ログインのみ有効化） | サインインとセッション JWT の発行 |
| バックエンド | **Cloud Run**（FastAPI / Python） | Clerk JWT の検証、Excel 生成（openpyxl）、PDF 生成・解析（Docs API + pypdf / pdfminer.six）、Drive アクセス |
| 計算 | **Rust → wasm**（`core/`） | 面材張り大壁と釘配列諸定数、必要壁量と柱の小径の計算・入力の解釈・表示の桁揃え。**同じ .wasm を画面とバックエンドの両方が動かす**（「計算の一元管理（Rust → wasm）」参照） |
| データ保存 | **Google Workspace の Drive** / Firestore / リポジトリ同梱 | Drive: Excel 雛形（社外秘フォーマット）・証明書の雛形（Google ドキュメント）・生成した PDF。Firestore: 全利用者共通の設定。同梱: 一般に配布されている必要壁量の表計算ツール（`backend/app/templates/`。誰でも同じものを配布ページから入手できるので、Drive に置かず版を固定して持つ） |

### セキュリティ / 権限モデル（GAS 版との対応）

GAS 版は「ウェブアプリにアクセスしているユーザーとして実行」する設定により、雛形の読み取りが実行ユーザー本人の権限で行われていました。本ポータルは同じ保証を次の 2 段で再現します。

1. **Clerk セッション JWT の検証**（バックエンド）
   - Clerk の JWKS で署名を検証し、`exp` / `iss` / `azp` を確認して、トークンからユーザーの **メールアドレス** を取り出す。
   - 許可ドメイン（`ALLOWED_EMAIL_DOMAINS`）以外のアカウントは 403。
2. **代理アクセストークン（domain-wide delegation）**
   - 確認したメールアドレスのユーザーとして、サービスアカウントが **読み取り専用スコープ** (`drive.readonly`) の代理トークンを取得し、Workspace の Drive API を呼ぶ。
   - つまり雛形の取得は常に **本人の Drive 権限の範囲内** で行われる。雛形にアクセス権の無いユーザーは、サインインできても雛形を読めない（GAS 版と同じ UX・同じ境界）。

ファイルを選ぶ画面は Google 公式の **Google Picker** です。Picker が使うアクセストークンも上と同じ代理アクセスで発行しますが、スコープは `drive.readonly` で、**選択画面を出すためだけ**のもの。ブラウザから届くのは選ばれたファイル ID だけなので、種類・ゴミ箱・親フォルダの確認と実際の読み書きは、サーバー側の代理アクセスで行います（「Google Picker」参照）。

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

## ✨ 現在の機能

### 現況検査レポート作成ツール

GAS 版の機能をそのまま移植しています。

* 物件名・複数部屋（追加/削除可能）・各部屋の計測点（床 X/Y/斜め・壁 上下/左右・柱 上下/左右）の入力
* 新しい部屋の階数は直前の部屋の値で初期化（最初の部屋は 1 階）
* 出力前の簡易バリデーション（警告のみ。しきい値等は `backend/app/mapping.json` の `validation`）
* `傾斜測定` シートへの正確なセルマッピング（`backend/app/mapping.json` で一元管理）
* 雛形（社外秘フォーマット）は Drive 上のファイルを参照。同フォルダに同名で差し替えると自動で最新版を使用
* 雛形は滅多に変えないため、設定はタイトル右の小さな「設定」ボタンにまとめてある（**公式の Google Picker**。Drive と同じ操作感でフォルダをたどれる。表示されるのは本人に閲覧権限のあるファイルだけ）
* 生成した xlsx のダウンロード

**GAS 版からの改善**: フォーム定義とバリデーション設定は `/api/tools/excel-report-formatter/config` が `mapping.json` から導出して配信するため、フロントエンドの定数（旧 `MEASUREMENT_GROUPS` / `VALIDATION`）を手動で同期する作業が不要になりました。`mapping.json` が単一の情報源です。

### 構造計算安全証明書 作成ツール

建築士法第 20 条第 2 項の「構造計算によって建築物の安全性を確かめた旨の証明書」（第四号書式）を作成します。

* 雛形は **Google ドキュメント**。記入欄は `{{委託者名}}` のような **プレースホルダー**で書いておく
* 雛形は現況検査レポート作成ツールと同じく Drive から（公式 Picker で）選択し、設定（フォルダ ID + ファイル名）は Firestore に保存。同じフォルダに同名で差し替えると自動で最新版を使用。設定はタイトル右の小さな「設定」ボタンにまとめてある
* フォーム入力でプレースホルダーを置換し、PDF へ書き出したうえで、**該当する選択肢に印を描き込む**。番号の選択肢（建築物の区分 / 構造計算の種類 / 構造計算の方法）は番号を **正円**で囲み、大臣認定の有無は **□ の中にレ点**を入れる
* 証明日は **日付ピッカー**で入力し、和暦（`{{年号年}} 年 {{月}} 月 {{日}} 日`）へ自動で変換する。元号と年数の間は半角スペースで区切る（`令和 8`）。新規作成では当日を初期値にし、印字される文字列を画面で確認できる
* **ファイル操作は通常のアプリと同じ考え方**（新規作成 / 開く / 保存 / 別名で保存）。保存先は共通設定として持たない
  * **開く**: 作成済みの PDF を Drive から選択、または手元からアップロードすると、内容を解析してフォームへ流し込む
  * **保存**: 編集中のファイル（Drive 上の PDF）への上書き。名前も場所も変わらないので何も尋ねない（Drive の版履歴が残る）
  * **別名で保存**（新規作成からの保存も同じ）: 「名前を付けて保存」にあたる保存ダイアログで、ファイル名と保存先フォルダを指定する。フォルダの選択だけを Picker に任せているのは、Picker が**ファイルを選ぶ画面**で、保存する名前を入力させられないため（Picker はモーダルダイアログの下に隠れてしまうので、開いている間だけダイアログを閉じて開き直す）
  * 未保存の入力があるまま新規作成・読み込みへ移ろうとしたときは、保存するかどうかを尋ねる
  * 上書きは同じファイルの内容差し替えで行うため、直前の版は Drive の版履歴から復元できます。`keepRevisionForever` は付けていないので、古い版は Drive の自動整理に任せ、一定期間が過ぎたら最新のものだけが残ります

生成の流れは「雛形を複製 → 複製に対して `replaceAllText` → PDF へ書き出し → 複製を削除 → ○ を重ねる → Drive へ保存」で、**雛形そのものは書き換えません**。すべて実行ユーザー本人の代理権限で行うため、本人が読めない雛形・書けないフォルダは扱えません。

読み込みの精度について: このツールが作った PDF は、フォーム入力そのものを PDF の文書情報に埋め込んでいるため **完全に復元** できます。それ以外の PDF は本文のレイアウトから推定するため、画面に「推定して読み込んだ」旨の注意が出ます（○ はベクター図形なので、選択肢は位置から復元できます。一方、雛形上で同じ行に並ぶ「建築物の名称」と「用途」は分離できないため、まとめて名称欄へ読み込みます）。

### 面材張り大壁 計算ツール

グレー本『木造軸組工法住宅の許容応力度設計』の **3.3 面材張り大壁の詳細計算法**（式 3.3.1〜3.3.11）に沿って、壁の面内せん断剛性 **K**・許容せん断耐力 **Pa** を求めます。その中で、壁を構成する面材 1 枚ごとに **3.2 面材張り耐力要素の詳細計算法で用いる釘配列諸定数の計算**（式 3.2.1〜3.2.7）を行い、**Ixy・Zxy・Cxy** を算定します。GAS 版 [gas-timber-panel-shear-calculator](https://github.com/min-nano/gas-timber-panel-shear-calculator) の移植（3.2）と、その先の拡張（3.3）です。

**入力の単位は壁 1 枚**です。実際の設計では面材の種類（と釘）が先に決まっていて、**面材の配置・釘の間隔・へりあきで耐力を調整する**ため、釘配列だけを先に決めて使い回す形にはしていません（面材 1 枚の入力欄も「面材と釘 → 面材の配置」の順に並びます）。

**面材と釘の仕様は面材 1 枚ごと**に決めます。1 枚の壁でも、上半分は N50・下半分は CN50 のように**張り分けることがある**ためです。壁が持つのは**階高 H・壁の幅 W・中間材（間柱等）の有無**だけで、面材の厚さ `t`・`GB`・釘の `k`・`δv`・`δu`・`ΔPv`・`τmax`・`E1`・`E2` は面材ごとの入力欄にあります（面材ごとの節の中に「面材と釘」と「面材の配置と釘配列」が入ります）。

**壁（3.3）**

* 階高 H・壁の幅 W と、面材ごとの**面材と釘の組合せ**を決めると、面材 1 枚ごとに回転剛性 `K0`（式 3.3.3・3.3.4）・降伏モーメント `My`（式 3.3.5）・終局モーメント `Mu`（式 3.3.6）・塑性率 `μ`（式 3.3.7）を**その面材の仕様で**求め、壁全体では K0・My・Mu を**和**、μ を**最小値**にまとめる
* 壁の面内せん断剛性 `K = K0 / H`（式 3.3.2）と、許容せん断耐力 `Pa = min{ My, K0/150, 0.2√(2μ−1)×Mu } / H`（式 3.3.1）、壁長さあたりの `ΔPa = Pa / W` を算定し、**Pa を決めた項**もそのまま示す
* 面材と釘の組合せは **グレー本 表 3.3.1「面材釘 1 本あたりの一面せん断の数値」の 12 通りを、面材ごとに一覧から読み込める**（表 3.3.2 の既定の規格も一緒に入るので、1 回の選択で検定まで数値がそろう）。表にない組合せは、グレー本 4.5 の試験で求めた `k`・`ΔPv`・`δv`・`δu` を直接入力できる。選んだ釘の**呼び径**（JIS A 5508）も画面と計算書に出す（へりあきを決める手がかり）。面材を追加すると、直前の面材の仕様を引き継ぐ（同じ仕様で張ることのほうが多いため。違う仕様にするときはその面材で選び直す）
* **面材ごとの面材と釘**（`t`・`GB`・`k`・`δv`・`δu`・`ΔPv`・`τmax`・`E1`・`E2`）を画面と計算書に表として並べ、どの面材がどの数値で計算されたのかを残す。壁の入力の控えには、全ての面材で同じ組合せならその名前を、混在していれば「面材ごとに異なる」と面材ごとの組合せ名を出す
* **面材のせん断破壊・せん断座屈の検定**（式 3.3.8〜3.3.11）を面材 1 枚ごとに行う。`τN = Cxy・Zxy・ΔPv / t` が、面材のせん断強度 `τmax` と臨界せん断座屈応力度 `τcr` の両方を下回ることを確かめ、a・b・β・τN・τmax・τcr を表にして残す
  * 座屈の式は**四周打ち**（式 3.3.11）のみ。面材張り大壁は適用範囲 3.3(1)⑤ で面材の四周を釘打ちすると定められているため、川の字打ちの式（3.3.10）が要るのは大壁以外の耐力要素だけです
  * `τmax`・`E1`・`E2` は **グレー本 表 3.3.2「面材のせん断強度及び曲げヤング係数」から面材ごとに読み込める**（構造用合板は JAS 1 級 / 2 級を選べる）。検定は面材ごとの `τmax` に対して行い、判定の行にはいちばん余裕の少ない面材の値を出す
  * ξ は中間材（間柱等）の有無で 2 / 1。a（繊維直交方向の長さ）と b（繊維平行方向の長さ）は、面材ごとに選ぶ繊維方向（既定は長辺方向）から決まる
* 適用範囲（3.3(1)）のうち機械的に判定できるものを検定する。**①許容せん断耐力の上限 13.72 kN/m** と、**④のうち面材の釘列に対するへりあき**（下記）の 2 つ。残り（面材と釘の組合せ・釘のピッチ・軸材の釘列に対する縁端距離・端部および継目の材の断面・中間材の配置）は設計者が確認する前提で、計算書の脚注に明記する

**面材の配置と釘配列諸定数（3.2）**

* 壁を構成する面材は、**1 枚ごとに面材と釘の仕様・寸法（→ 面材面積 Aw）・釘の配置**を決める。その場で `Ixy`（式 3.2.1）・`Zxy`（式 3.2.3）・`Cxy`（式 3.2.5）が求まり、そのまま上の壁の計算に入る
* 釘の配置は **3 通り**で入力できる（既定は「割り付け」）
  * **割り付け**: 配列の型（川型・山型・ロ型・日型）・間柱/根太ピッチ・釘ピッチ・**へりあき**から釘座標を組み立てる。実際の設計で動かすのはこの 4 つなので、これを既定にしている
  * **格子**: X と Y の座標リストの全組合せ
  * **座標を直接入力**: 「x, y」を 1 行に 1 本ずつ（不規則な配列の逃げ道）
* **へりあき**（面材の縁から釘の中心までの距離）は面材ごとの入力欄です。適用範囲 3.3(1)④ が「面材の釘列に対するへりあきは、**10mm 以上かつ接合具径 d [mm] × 5 以上**」と定めているので、**必要な値は選んだ釘の呼び径で決まります**（N-50 → 13.75 mm、N-65 → 15.25 mm、CN75 → 18.8 mm …）。
  * 面材と釘の組合せを選んだとき・表 3.2.1 の配列を読み込んだときは、その面材のへりあきが足りなければ**必要な値まで引き上げます**（設計者が広げた値は狭めません）。必要な値は面材ごとの釘で決まるので、判定にはいちばん余裕の少ない面材を名前つきで出します
  * 計算書と画面では、実際に置かれた釘の座標から測った**へりあきの最小値**を出し、3.3(1)④ に対して OK / NG を判定します（割り付け・格子・座標入力のどれでも同じ物差しで測ります）
  * 表 3.2.1 の配列そのものはへりあき 10 mm を前提としているため、表の値をそのまま使うと 3.3(1)④ の下限（呼び径 × 5）に届きません。グレー本 3.3(3) の計算例（釘 N-65）を再現した計算書でも、この行は NG と出ます
  * 軸材の釘列に対する縁端距離（20mm 以上かつ d × 5 以上）は軸材の断面が要るため、設計者が確認する前提です
* 面材の長辺方向に走る間柱の釘列は、3.3(1)⑧ により釘配列計算に含めません
* 途中経過（x0, y0, Ix, Iy, Zx, Zy, αx, Zpxy …）も式番号つきですべて表示し、計算のブラックボックス化を防ぐ（白箱化）
* **グレー本 表 3.2.1「標準的なサイズの面材の釘配列諸定数」の配列を、一覧から呼び出せる**（面材寸法・間柱/根太ピッチ・釘ピッチ・型の 106 通り）。呼び出すと上の割り付けの欄が埋まるので、そこから実際の設計に合わせて動かせる。解説（図 3.2.2）の計算例も、この一覧の「910×610 横置・川型（@455 / 釘 @150）」として呼び出せる

**共通**

* **1 ファイル = 1 物件**。物件の中の複数の壁をページ送りで切り替えて編集し、**計算書 PDF では壁ごとに「1 ページ = 1 面材（釘配列諸定数）」を並べ、続けて「1 ページ = その壁」**を置く（壁の計算の根拠になる釘配列諸定数が、必ずその直前のページにそろう）。面材のページには、その面材に使った**面材と釘**もそのまま載る
* 計算書には入力・釘配列諸定数・途中経過に加えて、**釘配列図**（面材の枠・釘・弾性中立軸）を描く
* **前の版で保存した PDF も開けます**。釘配列パターンを別に登録して壁から選んでいた形の入力は、読み込み時に「壁が面材そのものを持つ」今の形へ移し替えます（どの壁からも使われていなかったパターンは、面材 1 枚だけの壁として残るので、面材と釘の数値を入れ直してください）。面材と釘を**壁が 1 組だけ持っていた**形の入力も、読み込み時にその壁の全ての面材へ配ります（当時は壁の中で仕様が混在しえなかったので、計算はそのまま一致します）

**GAS 版からの変更**: GAS 版はスプレッドシートへ「現在値（パターン）＋履歴」を書き出していましたが、本ポータルでは**スプレッドシートを使いません**。証明書ツールと同じく **成果物の PDF そのものが保存形式**で、フォーム入力を PDF の文書情報に埋め込むため、保存した PDF を開き直せば入力を完全に復元して続きを編集できます。ファイル操作の考え方も証明書ツールと同じ「新規作成 / 開く（Drive・手元の PDF）/ 保存（上書き）/ 別名で保存」で、上書き保存の前の版は Drive の版履歴に残ります。

**雛形はありません**。計算書は帳票ではなく計算過程そのものなので、バックエンドが PDF を直接組み立てます（`backend/app/pdf_write.py`）。そのため、このツールには共有設定（雛形の場所）もありません。

**編集中の計算は画面の中で完結し、保存のときにサーバが確かめます**。実装は 1 つ（Rust の `core/`）で、それを wasm にしたものを画面もバックエンドも動かします。詳細は「計算の一元管理（Rust → wasm）」を参照してください。

> **計算書 PDF のフォントについて**: 本文のフォントは **Noto Sans JP**（SIL Open Font License 1.1）を `backend/app/fonts/` に同梱し、**その PDF で実際に使った文字だけを取り出したサブセットを埋め込みます**。閲覧側の環境に日本語フォントがあるかどうかに関係なく、いつでも同じ字形で表示されます。同梱フォントは 5.8MB ありますが、埋め込まれるのは使った文字だけなので計算書 1 通は数十 KB です（切り出しは fontTools が行い、生成 1 回あたり 0.1 秒程度）。

### 小規模木造建築物 必要壁量 計算ツール

公益財団法人日本住宅・木材技術センターが配布している **[壁量等の基準(令和7年施行)に対応した表計算ツール（多機能版）](https://www.howtec.or.jp/publics/index/441/)** に、フォームの入力をそのまま書き込んだ Excel ファイルを作ります。

この基準で必要壁量を出すと「その表計算ツールに値を入力して提出してほしい」と求められることがあり、そのときの提出物は**配布物そのもの**です。**出力する xlsx の中の計算は、配布物の数式がそのまま行います**（このツールは数式に手を入れません）。

そのうえで、**画面には入力に応じた「出力結果」をその場で出します**。配布物の数式を Rust へ写した実装（`core/src/wall_quantity.rs`）を wasm にして画面が動かすので、ダウンロードして Excel で開くまで結果を待たなくて済み、入力の取り違えにもその場で気付けます。

* 平屋建て / 2階建てをページの上で切り替える（配布物のシートに対応）
* 「0. 設計の用途」（住宅性能表示制度を利用 / 非住宅（事務所建築）/ 左記以外）、「2-1〜2-3」の算定方法は、**配布物のチェックボックスにそのまま反映**する
* 配布物のプルダウン（屋根・外壁の仕様、断熱材、太陽光発電設備等、標準せん断力係数など）はそのままの選択肢で出す。柱材の **JAS 規格 → 樹種等 → 等級等** は、配布物の `INDIRECT` と同じ連動で候補が絞られる
* 配布物が「入力が足りないと出力欄が空になる」形で示している条件（多雪区域なら垂直積雪量と積雪単位荷重、太陽光を「あり(任意入力)」にしたなら設備等の質量、断熱材を「任意入力」にしたなら密度と厚さ）を、**出力の前に日本語で確かめる**
* 入力できない欄（用途を選ぶまで出ない地震地域係数・多雪区域、使わない算定方法の欄）は、配布物の注意書きどおり**空のまま**にする
* **出力結果**（1. 単位面積当たりの必要壁量 Lw、2-1〜2-3 の柱の小径・柱の負担可能面積）を、入力のたびに計算して並べる。入力が足りないところ・表に無い樹種の組合せ（「該当なし」）・有効細長比が 150 を超える断面（「有効細長比150以上」）も、**配布物と同じ見え方**にする
* 保存（Excel 出力）のときは**サーバも同じ .wasm で計算し直し、画面に出ていた値と突き合わせます**。食い違えば警告を出します（生成は止めません。xlsx に入るのは入力値で、計算するのは Excel の数式なので、成果物が壊れることはありません）

**ダウンロードするのは Excel 形式（.xlsx）のままです**。Google スプレッドシート等へは変換しません。

**配布物は書き換えません**。リポジトリに同梱した原本（`backend/app/templates/wall-quantity/worksheet.xlsx`）を複製し、その複製の入力欄だけに値を書きます。チェックボックス・図・印刷設定・シート保護を含めて配布物のままなので、受け取る側には見慣れた表計算ツールが届きます。

> **なぜ openpyxl を使わないのか**: この配布物は、フォームコントロールのチェックボックス・EMF の図・VML・印刷設定を含んだブックです。openpyxl で読み書きすると、これらは復元されません（実測で `ctrlProps` / `vmlDrawing` / `drawing` / `media` / `printerSettings` / `sharedStrings` が丸ごと落ち、チェックボックスも図も消えます）。そこで、`backend/app/xlsx_fill.py` が **zip の中の XML を触る場所だけ書き換えます**。出来上がるファイルは、配布物と比べて「入力したシート・チェックボックスの状態・再計算の指示」以外は 1 バイトも変わりません。

**共有設定も Drive アクセスもありません**。雛形は Drive ではなくリポジトリに同梱してあるので、このツールを使うのに設定は要りません。同梱している版は画面のタイトル横に出ます（配布元へのリンク付き）。

**配布物の改訂には自動で気付きます**。`.github/workflows/howtec-worksheet-check.yml` が週に 1 度、配布ページを見に行きます。改訂で**数式**が変われば、写した Rust も直さなければならないので、配布物の数式そのものを控えておいてテストで突き合わせています。詳しくは「表計算ツールが改訂されたときの手順」を参照してください。

> **なぜ計算を写したのか**: この計算は今後、**配布物どおりではない計算**（配布物が想定していない形の建物など）へ広げる予定があります。そのとき「配布物に書き込むだけのツール」のままでは足場が無いので、まず**配布物と 1 桁も違わない状態**から始められるようにしました。写しが合っていることは、配布物に同梱されている「表計算ツール入力例」シート（入力と Excel が計算した結果の両方が入っています）を丸ごと突き合わせて確かめています（`backend/tests/test_wall_quantity_calculation.py`）。

### 画面のデザインシステム

画面の見た目は `frontend/src/styles/` にまとめてあります。**見本ページが `/design/` にあります**（サインイン不要。実際のツールと同じ CSS を読み込んで部品を並べているので、見本と実物がずれません）。ローカルでは `npm run dev` のあと http://localhost:5173/design/ で見られます。

守る決めごとは 3 つだけです。

1. **画面は「入力する面」「読む面」「操作するもの」の 3 つでできている。** 入力する場所は必ず枠のある升目（`--field-bg`）にして、周りの下地（`--surface-sunken`）と面の色で分けます。結果は白い枠の中に置き、数値は等幅・右そろえ（`--font-num` + `tabular-nums`）にして桁を見比べられるようにします。操作するものはボタンだけで、**主**（塗り／画面に 1 つ）・**副**（枠線）・**削除**（赤い枠線・塗らない）の 3 段階しかありません。
2. **緑と赤は判定にしか使わない。** 画面の中に緑か赤が見えたら、それは必ず計算結果の判定です。判定は「升目（`.verdict.ok` / `.verdict.ng`）→ 行 → 結果の節の見出しの帯」の 3 段階で同じ色になるので、**表を読まなくても NG の有無が分かります**。狭い画面では、右下の「結果へ飛ぶ」ボタンも同じ色になります。
3. **広い画面で増えた幅は、説明文ではなく入力欄に使う。** ページの最大幅は 1280px（`--shell-max`）ですが、説明文は 68 文字程度で頭打ち（`--prose-max`）です。増えた幅は「関係する入力欄を横に並べる」「結果を右の列に貼り付ける」ために使います。

| 骨組み | 使い方 |
| --- | --- |
| `.container` | ページ本体。この中に節を並べる |
| `portal-section.cert-section` | 入力の節。中身は自動で桝目（狭い画面では 1 列）に並ぶ |
| `.cert-field` / `.wq-field` | 入力欄 1 つ（ラベル + 欄 + 単位 + 補足）。`.field-row` + `.unit` で欄に単位をくっつける |
| `.choice-option` | 行ごと押せる選択肢（選んだものは下地と枠で残る） |
| `.has-dock` + `.result-dock` | 1080px 以上で「入力（左）・結果（右・貼り付き）」の 2 列にする。DOM の並びは変えないので、読み上げ順とタブ順は入力 → 結果のまま |
| `.verdict.ok` / `.verdict.ng` | 判定の升目。結果の帯と「結果へ飛ぶ」ボタンの色が、ここから決まる |

色・余白・文字の値は `src/styles/tokens.css` の**役割の名前**（`--surface`・`--text-2`・`--ng-600` など）だけを使い、画面側の CSS には生の値を書きません。明暗テーマは `light-dark()` でこのファイルの中だけにまとまっていて、部品側の CSS は 1 行も分岐しません（端末の設定に従い、`<html data-theme="light|dark">` で固定もできます）。新しい色を足したくなったら、まず既にある役割で言い表せないかを考えてください。

指で押すものの高さは `--tap`（44px）以上、入力欄の文字は 16px（iOS Safari が勝手に拡大しないため）、焦点は必ず見えるようにする、の 3 つは部品側で担保しています。

### 画面共通の部品（Web Components）

ページをまたいで同じものが出てくる部分は、`frontend/src/components/` に**カスタム要素**としてまとめてあります。フレームワークは入れていません（素の Web Components で足りているため。必要になったら、この境界のままフレームワークへ寄せられます）。

| 要素 | 役割 |
| --- | --- |
| `<portal-header>` | ヘッダー（ポータル名・サインイン中のアカウント欄） |
| `<portal-auth-gate>` | サインインゲート（Clerk のサインイン画面のマウント先） |
| `<portal-section>` | **折り畳めるセクション** |
| `<portal-section-controls>` | セクションの一括開閉（すべて展開 / すべて折りたたむ） |
| `<portal-edit-bar>` | 編集中のファイル（PDF ツール共通） |
| `<portal-save-bar>` | 保存欄（PDF ツール共通） |
| `<portal-save-dialogs>` | 未保存の確認・名前を付けて保存（PDF ツール共通） |

**入力・計算の量が増えたので、各ページの節は折り畳めます**。入力の済んだ節を閉じておけば、次に入力する箇所を見つけやすくなります。

* 既定はすべて開いた状態。見出しの行（つまみ・見出しのどこでも）を押すと開閉する
* フォームの右上の「すべて折りたたむ」で、節の見出しだけが並ぶ目次になる
* 折り畳んでも入力欄は画面の中に残る（保存・出力する内容は開閉で変わらない）
* 節の中に**入力漏れ**があるまま保存・出力しようとすると、その節は自動で開く
* 面材張り大壁ツールは**面材 1 枚ごと**、現況検査レポートは**部屋 1 つごと**にも折り畳める。閉じているあいだも、見出しの行には見分けが付く情報（面材名 / 部屋の階数・部屋名）を残す

部品を足すときの約束事は `frontend/src/components/index.js` の冒頭に書いてあります（要点は「名前は `portal-` で始める」「中身は原則 light DOM に作り、ページ共通の CSS と既存の id 参照をそのまま使えるようにする」「shadow DOM はページ側の CSS から隔てたい部分だけに使い、外から整えたいところは `part` で出す」）。

## 📁 リポジトリ構成

```
frontend/                     # Firebase Hosting に載せる SPA (Vite)
  index.html                  # ポータルトップ（ツール一覧）
  tools/excel-report-formatter/index.html
  tools/structural-cert-formatter/index.html
  tools/timber-panel-shear-calculator/index.html
  tools/wall-quantity-calculator/index.html
  design/index.html           # デザインシステムの見本（/design/。サインイン不要）
  src/styles.css              # 画面共通スタイルの入口（下の 5 つを読み込むだけ）
  src/styles/                 # デザインシステム
    tokens.css                # 色・余白・字送りの原器（明暗テーマもここだけ）
    base.css                  # 素の要素（body・見出し・焦点）の土台
    layout.css                # 骨組み（ヘッダー・ページ幅・入力と結果の 2 列）
    components.css            # 部品（ボタン・入力欄・節・結果・判定）
    tools.css                 # ツールごとの上乗せ（計測値の表・釘配列図・出力欄）
  src/design-system/          # 見本ページ（/design/）の入口と、そこだけで使う CSS
  src/components/             # 画面共通の部品（Web Components）
    index.js                  # 部品の読み込み口と、部品を足すときの約束事
    page-header.js            # <portal-header>（ヘッダー・アカウント欄）
    auth-gate.js              # <portal-auth-gate>（サインインゲート）
    collapsible-section.js    # <portal-section>（折り畳めるセクション）
    section-controls.js       # <portal-section-controls>（一括開閉）
    pdf-file-ui.js            # <portal-edit-bar> / <portal-save-bar> / <portal-save-dialogs>
  src/auth.js                 # Clerk（サインインゲート・トークン取得）
  src/api.js                  # Bearer 付き fetch ラッパー
  src/core.js                 # 計算実装（wasm）の読み込みと呼び出し（ツール共通）
  src/google-picker.js        # 公式 Google Picker（Drive のファイル選択）
  src/pdf-file-ops.js         # PDF ツール共通のファイル操作（保存の判断・文言）
  src/save-dialogs.js         # PDF ツール共通の保存 / 未保存確認ダイアログ
  src/excel-report-formatter/ # フォーム本体（GAS 版 index.html の移植）
  src/structural-cert-formatter/  # 構造計算安全証明書のフォーム・編集画面
  src/timber-panel-shear-calculator/  # 大壁と面材（釘配列）の入力・結果表示・釘配列図
  src/wall-quantity-calculator/   # 必要壁量 表計算ツールの入力フォームと出力結果
backend/                      # Cloud Run サービス (FastAPI)
  app/main.py                 # API ルート
  app/clerk_auth.py           # Clerk JWT 検証
  app/google_drive.py         # 代理トークン・Drive API
  app/google_docs.py          # Docs API（雛形のプレースホルダー置換）
  app/settings_store.py       # 共有設定（Firestore）
  app/excel_report.py         # Excel 生成（旧 functions/main.py の移植）
  app/mapping.json            # セルマッピング（単一の情報源）
  app/structural_cert.py      # 証明書の生成・PDF 解析
  app/structural_cert_mapping.json  # 証明書の雛形マッピング（単一の情報源）
  app/pdf_tools.py            # PDF の文字座標取得と ○ の描き込み
  app/nail_core.py            # 計算（唯一の実装＝wasm）を呼ぶ薄い口
  app/panel_shear.py          # 計算書 PDF の組み立てと読み戻し・保存時の突き合わせ
  app/pdf_write.py            # 日本語まじりの PDF を組み立てる最小限のライター
  app/wall_quantity.py        # 必要壁量 表計算ツールへの記入（配布物の複製に値を書く）・保存時の突き合わせ
  app/wall_quantity_mapping.json  # 表計算ツールの入力欄・選択肢・条件（単一の情報源）
  app/xlsx_fill.py            # xlsx を壊さずに指定セルだけ書き換える最小限のエディタ
  app/templates/wall-quantity/  # 配布物の表計算ツールとその出所（source.json）
  app/fonts/                  # 計算書 PDF に埋め込む日本語フォント（Noto Sans JP, OFL 1.1）
  app/wasm/                   # core/ をビルドした .wasm の置き場（コミットしない）
  .gcloudignore               # Cloud Build へ送るものの指定（app/wasm/ を落とさないため）
core/                         # ポータルの計算の唯一の実装（Rust → wasm）
  src/nail_array.rs           # グレー本 3.2 の式（3.2.1〜3.2.7）
  src/wall.rs                 # グレー本 3.3 の式（3.3.1〜3.3.11）と表 3.3.1・3.3.2
  src/wall_quantity.rs        # 必要壁量と柱の小径（配布物の表計算ツールの数式を写したもの）
  src/column_strength.rs      # 柱の圧縮の基準強度 Fc（平成12年建設省告示第1452号の表）
  src/layout.rs               # 釘の割り付け（型・ピッチ・へりあき → 釘座標）
  src/presets.rs              # グレー本 表 3.2.1 の標準的な釘配列（呼び出せる配列）
  src/report.rs               # 入力の解釈と、画面・PDF が共有する結果の組み立て
  src/format.rs               # 有効桁・3 桁区切り（画面と計算書で同じ文字列にする）
  src/json.rs                 # 受け渡しの JSON（外部クレートに依存しないため自前）
  src/abi.rs                  # wasm の呼び出し口（線形メモリの受け渡し）
  build.sh                    # ビルドして backend/app/wasm/ へ置く
firestore/                    # Firestore セキュリティルールとそのテスト
  firestore.rules             # クライアント SDK からのアクセスを全面拒否（deny-all）
  tests/rules.test.js         # エミュレータでルールを検証
firebase.json                 # Hosting 設定（/api/** → Cloud Run リライト）・Firestore ルールの参照
.github/workflows/            # tests.yml（CI）/ deploy.yml（本番 CD）/ preview.yml・preview-cleanup.yml（PR プレビュー）
                              # howtec-worksheet-check.yml（表計算ツールの改訂の定期確認）
.github/scripts/              # ワークフロー間で共有するスクリプト
  require-vars.sh             # 必須のリポジトリ変数が空でないことの確認
  clerk-issuer.sh             # Publishable Key から CLERK_ISSUER を導出
  coverage.py                 # カバレッジ XML のパス正規化と集計（テストのカバレッジ）
  check_howtec_worksheet.py   # 配布ページを見て表計算ツールの改訂を拾う
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
# docs.googleapis.com は構造計算安全証明書 作成ツール（雛形の Google ドキュメントの
# プレースホルダー置換）で使う。有効化を忘れると、スコープを正しく登録していても
# 置換の呼び出しが HTTP 403（SERVICE_DISABLED）で失敗する。
# picker.googleapis.com は画面から Drive のファイルを選ぶ Google Picker で使う（「4. Google Picker」）。
gcloud services enable run.googleapis.com iamcredentials.googleapis.com \
  drive.googleapis.com docs.googleapis.com firestore.googleapis.com \
  picker.googleapis.com \
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
   https://www.googleapis.com/auth/drive
   https://www.googleapis.com/auth/documents
   ```

   スコープの使い分けは次のとおりで、バックエンドは操作ごとに必要な方だけのトークンを取ります（`google_drive.delegated_session` / `delegated_write_session`）。

   | スコープ | 使う場面 |
   | --- | --- |
   | `drive.readonly` | 選ばれたファイルの確認と雛形の取得、編集する PDF の読み込み、Google Picker へ渡すトークン（現況検査レポート作成ツールはこれだけで完結） |
   | `drive` | PDF の Drive への保存（構造計算安全証明書・釘配列諸定数の計算書に共通） |
   | `documents` | 構造計算安全証明書の雛形（Google ドキュメント）のプレースホルダー置換 |

   ※ 書き込みスコープは代理するユーザー本人の権限の範囲でしか効きません（本人が書けない場所へは保存できません）。PDF を保存するツールを使わない場合は `drive.readonly` だけの登録で構いません。`documents` が要るのは証明書ツールだけです（釘配列諸定数の計算書は雛形を使わず、バックエンドが PDF を直接組み立てます）。

   **スコープを登録したのに HTTP 403 になる場合**: スコープ不足ではなく、GCP プロジェクトで API 自体が有効になっていない（`SERVICE_DISABLED`）ことがあります。特に Google Docs API は有効化を忘れやすいので、「2. GCP プロジェクト」の `gcloud services enable` に `docs.googleapis.com` が含まれているか確認してください。画面に出るエラーには Google からの応答がそのまま添えられるので、そちらでどちらの原因かを判別できます。

### 4. Google Picker（Drive のファイル選択 UI）

雛形・開く PDF・保存先フォルダを選ぶ画面には、Google 公式の **Google Picker** を使います（`frontend/src/google-picker.js`）。用意するのは **API キー 1 つだけ**です（Picker API の有効化は「2. GCP プロジェクト」で済んでいます）。

**認証情報 → API キー** を作成し、**アプリケーションの制限**を「HTTP リファラー」、**API の制限**を「Google Picker API」にします。リファラーはワイルドカードが使えるので、PR プレビューもまとめて許可できます:

```
https://<カスタムドメイン>/*
https://<サイトID>.web.app/*
https://<サイトID>--pr-*.web.app/*
http://localhost:5173/*
```

作成したキーは **リポジトリ変数 `GOOGLE_PICKER_API_KEY`** に設定します。本番・プレビューとも、デプロイのたびにワークフローがバックエンドの環境変数として渡します（「ランタイム環境変数の出どころ」参照）。キーはページに埋め込まれる公開情報で、悪用の防止は上のリファラー制限で行います。ビルドに焼き込まず `/api/picker/config` から配っているので、値を変えてもフロントエンドの再ビルドは不要です。未設定のときは画面が「Google Picker が未設定です」と環境変数名を挙げて案内します。

#### アクセストークンは代理アクセスで発行する

Picker は選択画面を描くために Drive を読むトークンを要求します。これは `/api/picker/token` が、既にある domain-wide delegation で **実行ユーザー本人の `drive.readonly` トークン** として発行します（`google_drive.delegated_access_token`）。そのため **OAuth クライアント ID は不要**です。

ブラウザ側で OAuth の同意を取る方式（Google Identity Services）を採らなかったのは、その場合に画面の URL を OAuth クライアントの「承認済みの JavaScript 生成元」へ登録する必要があるためです。この欄は**ワイルドカードが使えず、追加するための API も公開されていない**（Cloud Console からの手動操作のみ）ので、URL が毎回変わる PR プレビューでは登録が追いつきません。代理発行にすれば、本番・プレビュー・ローカルのどこでも登録なしに動き、利用者に追加の同意画面も出ません。

権限モデルは変わりません。渡すのは読み取り専用のトークンで、本人が既に Drive で見られる範囲を超えず、書き込みは従来どおりサーバー側でしか行いません。ブラウザから届くのは選ばれたファイル ID だけなので、種類・ゴミ箱・親フォルダの確認と実際の読み書きは、これまで通りバックエンドが代理アクセスで行います。

> **複数の Google アカウントでログインしている場合**: Picker の画面は Google 側の iframe で、ブラウザのログイン状態も参照します。サインイン中の業務アカウントとブラウザの既定アカウントが食い違っていると、意図しないアカウントのファイルが出る・エラーになることがあります。その場合は、業務アカウントを既定にするか、別プロファイル / シークレットウィンドウで開いてください。

### 5. 共有設定（Firestore）

GAS 版のスクリプトプロパティに相当する、全利用者共通の設定置き場です。人が直接編集できるファイルに置くと管理ユーザーの誤操作で設定が壊れる恐れがあるため、Firestore を使います。手動でのデータ投入は不要で、画面のタイトル右にある雛形の「設定」ボタンから保存されます。

```bash
# Firestore データベース（Native モード）を作成し、ランタイム SA に読み書き権限を付与
gcloud firestore databases create --location "$REGION" --project "$PROJECT_ID"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:$SA" \
  --role roles/datastore.user
```

#### 保存先（チャンネル）

同じデータベースの中を **チャンネル** 単位で分け、本番・開発・PR プレビューが互いのデータを踏まないようにしています。

| チャンネル | `SETTINGS_CHANNEL_PATH` | 使う環境 |
| --- | --- | --- |
| production | `static-channels/production` | `main`（本番の Cloud Run） |
| development | `static-channels/development` | **既定**。ローカル開発 |
| プレビュー | `preview-channels/pr-<番号>` | PR プレビュー（PR ごと） |

環境変数で指定するのは **チャンネルのドキュメントパスまで** です。その下に何を置くかはアプリ側の都合なので、`tool_settings/<ツール名>` は `settings_store.py` が付けます。実際の保存先は例えばこうなります:

```
static-channels/production/tool_settings/excel-report-formatter
static-channels/production/tool_settings/structural-cert-formatter
preview-channels/pr-29/tool_settings/excel-report-formatter
```

ツールごとに保存する内容は次のとおりです（いずれも画面から保存され、手動でのデータ投入は不要）。

| ツール | キー |
| --- | --- |
| `excel-report-formatter` | `template_folder_id` / `template_file_name` |
| `structural-cert-formatter` | `template_folder_id` / `template_file_name`（Google ドキュメントの雛形） |
| `timber-panel-shear-calculator` | （なし。雛形を使わないので共有設定を持たない） |

**未設定のときは development** を指し、本番を指すのは `SETTINGS_CHANNEL_PATH=static-channels/production` を明示的に設定した Cloud Run サービスだけです。環境変数の設定漏れ・ローカル開発・壊れたワークフローのいずれからも本番データに到達できないため、設定ミスの症状は必ず「設定が空に見える」であり、「本番を汚す」は起こりません。

値がチャンネル（ドキュメント）になっていない場合 — セグメント数が奇数、`tool_settings` まで含めてしまった、空 — は、Firestore に触る前にエラーで止まります。

`preview-channels` と `static-channels` を分けているのは後片付けのためでもあります。プレビューの削除（`preview-cleanup.yml`）は `preview-channels/pr-<番号>` の再帰削除だけを行い、本番データのある `static-channels` は削除処理の射程の外にあります。

**セキュリティルール**: Firestore にアクセスするのはバックエンド（IAM 認可のサーバークライアント。ルールの対象外）だけなので、クライアント SDK からのアクセスは `firestore/firestore.rules` で **全面拒否** しています。ルールは CI（`main` への push）で Hosting と一緒に自動デプロイされ、deny-all であることをエミュレータのテストで検証しています。ルールは `match /{document=**}` でネストしたパスまで覆うため、チャンネルを増やしてもルールの変更は不要です。

#### 既存データの移行（チャンネル導入時に一度だけ）

チャンネル分割の前は、共有設定がコレクション `tool_settings` の直下（`tool_settings/<ツール名>`）にありました。新しい配置へ移すには、**本番へデプロイする前に** 次の順で作業します。

1. 既存のドキュメントを `static-channels/production/tool_settings/` 配下へコピーする（ツールごとに 1 ドキュメントなので Firebase コンソールでの手作業で十分）。
2. その後に PR をマージする。`SETTINGS_CHANNEL_PATH=static-channels/production` は `deploy.yml` が本番サービスに渡すため、コードと設定は同じデプロイで同時に切り替わります。

順序が重要です。1 を先に済ませておけば、新コードが出た瞬間から正しいパスに中身があります。逆にコピーが後になると、本番が空のチャンネルを読み、雛形設定が消えたように見えます（データは失われず、コピーすれば復帰します）。移行が済んだら、旧パスの `tool_settings` コレクションは削除して構いません。

雛形ファイル自体は GAS 版と同じ運用です: ネイティブ .xlsx のままフォルダ内に置き、社内の閲覧可能者だけに共有する（SA への共有は不要。読むのは常に利用者本人の代理トークン）。

### 6. Cloud Run 初回デプロイ

初回だけ、**サービスの器を作る** ために手で 1 回デプロイします。ランタイム環境変数は CI（`deploy.yml`）が毎回渡すので、ここでは指定しません（「ランタイム環境変数の出どころ」参照）。

```bash
# Hosting のサイト ID（https://<SITE_ID>.web.app の <SITE_ID> 部分）。
# 通常はプロジェクト ID と同じだが、別のサブドメインになった場合はその値を使う。
# プレビュー URL（https://<SITE_ID>--pr-N-xxxx.web.app）もサイト ID が基準になる。
SITE_ID=<Hosting のサイト ID>

gcloud run deploy portal-api \
  --source backend \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --service-account "$SA" \
  --no-invoker-iam-check
```

* Firebase Hosting のリライトは Cloud Run を匿名で呼ぶため、呼び出しを許可する設定が要ります。ここでは **`--no-invoker-iam-check`（呼び出し側の IAM チェックの無効化）** を使い、`--allow-unauthenticated`（`allUsers` に `roles/run.invoker` を束縛する方式）は使いません。組織ポリシー `constraints/iam.allowedPolicyMemberDomains`（ドメイン制限共有）がある環境では、IAM ポリシーに `allUsers` を書けず `FAILED_PRECONDITION` で拒否されるためです。この構成では `gcloud run services get-iam-policy` は空（`etag` のみ）になります — バインディングが無いのが正常です。
* サービスは Cloud Run の URL からも到達できますが、認可はアプリ層の Clerk JWT 検証で行うため、JWT が無ければ 401 です。
* この時点ではまだ環境変数が空なので、Clerk の検証設定が無い状態で起動します。**`main` への最初の push で CI が環境変数を設定** し、そこから本番として機能します（認証不要の `/api/healthz` はこの時点でも応答します）。
* 動作確認:
  ```bash
  curl -s "https://$SITE_ID.web.app/api/healthz"   # → {"status":"ok"}
  ```

#### ランタイム環境変数の出どころ

バックエンドの環境変数は **本番・プレビューとも GitHub のリポジトリ変数を唯一の情報源** とし、デプロイのたびにワークフローが `--set-env-vars` で渡します（`deploy.yml` / `preview.yml`）。GCP 側に手で設定して覚えさせておく値はありません。

| 環境変数 | 用途 | 本番（`deploy.yml`）での値 |
| --- | --- | --- |
| `CLERK_ISSUER` | 許可する Clerk の Frontend API URL（JWT の `iss`。カンマ区切りで複数可）。本番サービスには **本番インスタンスのみ**（プレビューは PR ごとの別サービスが開発インスタンスを受け持つ） | `CLERK_PUBLISHABLE_KEY` から導出 |
| `CLERK_AUTHORIZED_PARTIES` | 許可するフロントエンドのオリジン（JWT の `azp` 検証。カンマ区切り、`*` ワイルドカード可） | `CANONICAL_HOST`（設定時のみ）と `SITE_ID` から組み立て。`https://<カスタムドメイン>,https://<サイトID>.web.app` |
| `ALLOWED_EMAIL_DOMAINS` | 利用を許可するメールドメイン（カンマ区切り） | 同名のリポジトリ変数 |
| `DWD_SERVICE_ACCOUNT_EMAIL` | 代理トークンに使う SA のメール（省略時は ADC から推定） | `RUNTIME_SA_EMAIL` |
| `SETTINGS_CHANNEL_PATH` | 共有設定を置くチャンネルの Firestore ドキュメントパス。**未設定だと development チャンネルを指す**（「共有設定（Firestore）」参照） | `static-channels/production` 固定（環境の別はワークフローが決めるので変数にしない） |
| `GOOGLE_PICKER_API_KEY` | Google Picker に渡す API キー（「Google Picker」参照）。未設定だと画面からファイルを選べない | 同名のリポジトリ変数。未設定なら渡さない（警告は出るがデプロイは続行） |
| `GOOGLE_PICKER_APP_ID` | （任意）Picker のアプリ ID（GCP のプロジェクト番号）。渡さなくても動く | 同名のリポジトリ変数。未設定なら渡さない |
| `FIRESTORE_DATABASE` | （任意）共有設定の Firestore データベース名。既定 `(default)` | 同名のリポジトリ変数。未設定なら渡さない |
| `CORS_ALLOWED_ORIGINS` | （任意）CORS 許可オリジン。既定 `http://localhost:5173` | 渡さない（Hosting のリライトで同一オリジンになるため本番では不要。ローカル開発用） |

`CLERK_ISSUER` と `CLERK_AUTHORIZED_PARTIES` に専用の変数を作らないのは、**同じ事実を 2 か所に書かない** ためです。issuer は Publishable Key から一意に決まり（`pk_<live|test>_<base64>` をデコードすると Frontend API のホスト名になる。`.github/scripts/clerk-issuer.sh`）、許可オリジンはフロントエンドが配信されるホスト名そのものです。プレフィックス（`pk_live_` / `pk_test_`）が期待と違えば、デプロイはエラーで止まります — 本番が開発インスタンスのトークンを受け付けたり、プレビューが本番インスタンスを向いたりしないように。

Hosting は `https://<サイトID>.firebaseapp.com` でも同じアプリを配信しますが、**許可オリジンには含めません**（使う入口を絞り、許可リストを実際に案内している URL に留めるため）。カスタムドメインを設定していれば、そちらへ来たアクセスは Clerk のロード前にリダイレクトされます（`frontend/src/canonical-host.js`）。設定していない場合、`.firebaseapp.com` から入るとサインインが `azp` の検証で弾かれます — `.web.app` を案内してください。

> **`--set-env-vars` は既存の環境変数を置き換えます。** そのため GCP コンソールや `gcloud run services update` で足した変数は、次のデプロイで消えます。値を変えるときは必ずリポジトリ変数側を直してください（`gh variable set <名前> --body <値>` の後、`main` に push するか `deploy.yml` を再実行）。
>
> **シークレット（GitHub の Secrets）は使っていません。** 上記はいずれも秘匿値ではないからです（Clerk の Publishable Key は公開前提でフロントエンドにも埋め込まれ、バックエンドの GCP 認証は WIF とランタイム SA の ADC で行うため API キーの類がありません）。将来どうしても秘匿値が要る場合は、GitHub Secrets から環境変数として渡すのではなく **Secret Manager に置いて `--set-secrets` で参照** してください。Cloud Run の環境変数はサービスの閲覧権限があれば誰でも読めます（`--set-env-vars` は `--set-secrets` の設定を消しません）。

### 7. Firebase Hosting

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

#### キャッシュの寿命（`firebase.json` の `headers`）

ビルドされた JS / CSS はファイル名に内容のハッシュが入る（中身が変われば URL も変わる）ため、`/assets/**` は 1 年 + `immutable` で配信します。一方、入口の HTML（`/` と `/tools/**`）は URL が固定で、その中に読み込む資産のハッシュが書かれています。ここが長くキャッシュされると、配信し直しても古い HTML が古い資産を指し続け、画面だけ古いまま API が新しい、という食い違いが起きます。そのため入口の HTML だけ `max-age=60` にしてあります（デプロイ後、最大 1 分で新しい画面に入れ替わります）。

`cleanUrls` で URL から拡張子が落ちるため、`headers` の `source` は拡張子ではなくページの場所（`/` と `/tools/**`）で指定しています。ページを増やす場所を変えたときは、ここも合わせてください。

### 8. GitHub Actions（CI/CD）

`main` への push で本番デプロイ（`.github/workflows/deploy.yml`）、PR で Hosting のプレビューデプロイ（`.github/workflows/preview.yml`。後述）が走ります。Settings → Secrets and variables → Actions に以下の **Variables** を設定してください。**Secrets は使いません**（理由は「ランタイム環境変数の出どころ」）。

フロントエンドのビルドとバックエンドのランタイム設定は、本番・プレビューともこの表の値だけから決まります。GCP 側に手で設定しておく値はありません。

| 変数 | 用途 | 使う環境 |
| --- | --- | --- |
| `PROJECT_ID` | デプロイ先 GCP プロジェクト ID | 両方 |
| `WIF_PROVIDER` | Workload Identity プールのプロバイダ名（`projects/.../providers/...`） | 両方 |
| `SA_EMAIL` | デプロイ実行用サービスアカウントのメール | 両方 |
| `RUNTIME_SA_EMAIL` | Cloud Run のランタイム SA のメール。サービスのランタイム SA と `DWD_SERVICE_ACCOUNT_EMAIL` に渡す | 両方 |
| `SITE_ID` | Hosting のサイト ID。許可オリジン（本番は `https://<サイトID>.web.app` 等、プレビューは `https://<サイトID>--pr-<番号>-*.web.app`）の組み立てに使う | 両方 |
| `ALLOWED_EMAIL_DOMAINS` | 利用を許可するメールドメイン（カンマ区切り） | 両方 |
| `CLERK_PUBLISHABLE_KEY` | Clerk Publishable Key（**本番インスタンス** `pk_live_...`）。本番ビルドに埋め込み、バックエンドの `CLERK_ISSUER` もここから導出する | 本番 |
| `CLERK_PUBLISHABLE_KEY_TEST` | Clerk Publishable Key（**開発インスタンス** `pk_test_...`）。プレビュービルドに埋め込み、プレビュー用バックエンドの `CLERK_ISSUER` もここから導出する | プレビュー |
| `CANONICAL_HOST` | 本番のカスタムドメイン（例 `portal.example.com`）。`.web.app` へのアクセスをここへリダイレクトし、許可オリジンにも加える。未設定ならどちらも行わない | 本番 |
| `PORTAL_TITLE` | ポータルの表示名（各ページのヘッダーと、トップページのタブ名）。ビルド時に `VITE_PORTAL_TITLE` として渡され HTML に埋め込まれる。未設定なら `社内ポータル` | 両方 |
| `FIRESTORE_DATABASE` | （任意）共有設定の Firestore データベース名。未設定なら既定の `(default)` | 本番 |
| `GOOGLE_PICKER_API_KEY` | Google Picker に渡す API キー（「Google Picker」参照）。未設定でもデプロイは通るが、画面からファイルを選べない | 両方 |
| `GOOGLE_PICKER_APP_ID` | （任意）Picker のアプリ ID（GCP のプロジェクト番号）。渡さなくても動く | 両方 |

`CLERK_ISSUER` と `CLERK_AUTHORIZED_PARTIES` に対応する変数が無いのは、他の変数から導出しているためです（「ランタイム環境変数の出どころ」参照）。

> **未設定・不正な変数があるとデプロイは失敗します**（設定の壊れに気付けるよう、意図的にスキップしない）。本番・プレビューとも、ワークフローの先頭で必要な変数が揃っているかを確認し、足りなければ変数名を挙げて落とします（`.github/scripts/require-vars.sh`）。**未設定の変数は空文字として展開され、`gcloud` はそれを「未指定」として受け入れてしまう** ためです（`--service-account ''` なら Compute 既定 SA が使われ、`CLERK_ISSUER=` なら認証設定が空のまま起動してしまう）。

JSON キーは使わず WIF（キーレス）で認証します。WIF とデプロイ用 SA は以下のように作成できます（Cloud Shell 等）:

```bash
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
GITHUB_REPO=<owner/repo>

# デプロイ専用 SA とロール
gcloud iam service-accounts create deployer --display-name "GitHub Actions deployer" --project "$PROJECT_ID"
DEPLOY_SA=deployer@"$PROJECT_ID".iam.gserviceaccount.com
# run.admin は run.developer の上位。プレビュー用サービスを CI から新規作成する
# 際の --no-invoker-iam-check に必要（このフラグは invoker-iam-disabled
# アノテーションを変更するため run.services.setIamPolicy を要求する。
# run.developer では PERMISSION_DENIED になる）。
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

### 9. PR プレビュー（`.github/workflows/preview.yml`）

PR を開く・push するたびに、その PR 専用の **プレビュー環境一式** を作り、URL を PR コメントに掲示します。フロントエンドだけでなくバックエンドと共有設定も本番から切り離されるため、プレビューでの操作が本番に影響することはありません。

| 環境 | Hosting | Clerk | バックエンド | 共有設定（Firestore） |
| --- | --- | --- | --- | --- |
| `main`（本番） | 本番チャンネル（`deploy.yml`） | 本番インスタンス（`CLERK_PUBLISHABLE_KEY`） | Cloud Run `portal-api` | `static-channels/production/…` |
| PR プレビュー | `pr-<番号>` チャンネル（`preview.yml`） | 開発インスタンス（`CLERK_PUBLISHABLE_KEY_TEST`） | Cloud Run `portal-api-pr-<番号>` | `preview-channels/pr-<番号>/…` |
| ローカル開発 | Vite dev サーバー | 開発インスタンス | ローカルの uvicorn | `static-channels/development/…`（既定） |

`preview.yml` の流れ:

1. フロントエンドを開発インスタンスのキーでビルドする。
2. **Cloud Run に `portal-api-pr-<番号>` をデプロイする。** 本番と同じく、ランタイム SA・環境変数を毎回すべて渡します（環境ごとに違うのは値だけ）。サービスが無ければ作成・あれば更新となるため、**初回に手動でサービスを作る必要はありません**。`SETTINGS_CHANNEL_PATH` にはこの PR 専用のチャンネル（`preview-channels/pr-<番号>`）を渡し、呼び出しは本番と同じく `--no-invoker-iam-check` で許可します。
3. `firebase.json` の `/api/**` リライト先をこの PR のサービスに書き換える。チャンネルのデプロイはそのときの `firebase.json` をリリースに焼き込むため、この書き換えはこの PR のチャンネルにだけ効きます（リポジトリの `firebase.json` は本番の `portal-api` を指したまま）。
4. プレビューチャンネル `pr-<番号>` へデプロイし、URL を PR にコメントする（最終デプロイから 7 日で失効）。

順序に意味があります。Hosting のリライト先サービスはチャンネルのデプロイ時点で存在している必要があるため、Cloud Run が先です。プレビュー URL のハッシュ部分はデプロイするまで分かりませんが、`https://<サイトID>--pr-<番号>-*.web.app` というパターンは PR 番号だけから決まるので、その PR のチャンネルだけに絞った `CLERK_AUTHORIZED_PARTIES` を先に設定できます。

PR クローズ時は `preview-cleanup.yml` が、チャンネル・Cloud Run サービス・そのサービスのコンテナイメージ・`preview-channels/pr-<番号>` 配下の Firestore データをまとめて削除します。

削除は **「もともと無い」と「消せなかった」を区別** します。既に失効・削除済みのものは正常として続行し、権限不足などで消せなかった場合はジョブを失敗させます。前者を正常扱いにしたことでワークフローは冪等になっているので、失敗した場合は原因を直して再実行すれば残りが片付きます（既に消えた分は素通りします）。

プレビューを動かすための前提:

1. **Clerk 開発インスタンス** にも本番と同じ設定を行う（Google のみ有効化・セッショントークンの `email` クレーム）。開発インスタンスは既定で任意のオリジンからの利用を許可するため、プレビュー URL のための追加設定は通常不要。オリジンを明示的に制限したい場合のみ、**Allowed origins** を Backend API で設定する（ダッシュボードに UI は無い。渡した配列で全置換される点に注意）:
   ```bash
   curl -X PATCH https://api.clerk.com/v1/instance \
     -H "Authorization: Bearer <開発インスタンスの Secret Key (sk_test_...)>" \
     -H "Content-Type: application/json" \
     -d '{"allowed_origins": ["https://<サイトID>--pr-*.web.app", "http://localhost:5173"]}'
   ```
   （サイト ID は Hosting の既定サイトのサブドメイン。プロジェクト ID と異なる場合がある。）
2. リポジトリ変数 `CLERK_PUBLISHABLE_KEY_TEST` / `SITE_ID` / `RUNTIME_SA_EMAIL` / `ALLOWED_EMAIL_DOMAINS` を設定する（前掲の表）。本番と同じく、`CLERK_ISSUER` は `CLERK_PUBLISHABLE_KEY_TEST` から導出されるので別途の設定は不要です。
3. ファイル選択（Google Picker）まで試すなら、リポジトリ変数 `GOOGLE_PICKER_API_KEY` を設定する。API キーのリファラー制限に `https://<サイトID>--pr-*.web.app/*` を入れておけば、プレビュー URL ごとの登録作業はありません（Picker のトークンは代理発行なので、OAuth クライアントへのオリジン登録も不要です）。未設定でもプレビューは作られますが（ジョブは警告のみ）、画面は「Google Picker が未設定です」と表示してファイルを選べません。
4. デプロイ用 SA に `roles/run.admin`・`roles/artifactregistry.repoAdmin`・`roles/datastore.user` があること（前掲のコマンドで付与済み）。`run.admin` は `--no-invoker-iam-check` に必要です — **このフラグは `run.services.setIamPolicy` を要求します**（`--allow-unauthenticated` と同じ権限。`roles/run.developer` では新規サービスの作成が `Changes to invoker_iam_disabled require run.services.setIamPolicy permissions` で失敗します）。残り 2 つは PR クローズ時の後片付けに使います。

   > 本番の `deploy.yml` は環境変数とランタイム SA こそ毎回渡しますが、このフラグだけは渡さず、サービスに設定済みの値をそのまま引き継ぎます（初回セットアップから変わらない値のため）。アノテーションを変更しないので `setIamPolicy` は不要です。

> プレビュー用サービスも本番と同じく `--no-invoker-iam-check` で呼び出しを許可します（「Cloud Run 初回デプロイ」参照）。`--allow-unauthenticated` は組織ポリシー `constraints/iam.allowedPolicyMemberDomains` のある環境では `FAILED_PRECONDITION: One or more users named in the policy do not belong to a permitted customer` で拒否されるため使いません。リライトが実際に届いているかは、ワークフローが毎回 `/api/healthz` への疎通確認で検証します。

> リポジトリ変数が未設定・不正な間は、プレビューのジョブは失敗します（本番と同じ確認。「GitHub Actions（CI/CD）」参照）。壊れたプレビューが「成功」として出来上がるのを防ぐためです。
>
> 例外は `GOOGLE_PICKER_API_KEY` で、こちらは警告にとどめてプレビューを作ります。渡さなければバックエンドが `configured: false` を返し、画面が「Google Picker が未設定です」と環境変数名を挙げて案内するため、壊れ方が黙って隠れることがないからです。ファイル選択以外の変更はそのまま確認できます。

> 同じ理由で、デプロイの成否だけでなく **プレビュー URL から `/api/healthz` に実際に届くか** を毎回確かめます。`gcloud run deploy` が成功しても、リライト先が届かなければプレビューは使い物になりません。それを URL を渡された人が最初に踏むのではなく、ジョブの失敗として先に出します。

> **注意**: 分離されるのは Hosting・Clerk・バックエンド・共有設定です。**Drive 上の雛形ファイルは本番と共有** されます（同じ Workspace の同じファイルのため）。プレビューの共有設定は空の状態から始まるので、雛形フォルダはプレビュー内で改めて指定してください。テスト用のフォルダを指定すれば、Drive も実質的に分離できます。

> PR ごとにコンテナをビルドするため、プレビューのデプロイは push ごとに数分かかります（`gcloud run deploy --source` が Cloud Build を経由するため）。

## 🧑‍💻 ローカル開発

```bash
# 計算実装（Rust → wasm）。最初に 1 度、そして core/ を触るたびに実行する。
# 要 rustup（toolchain は core/rust-toolchain.toml が指定する）。成果物は
# コミットしていないので、これを作らないとバックエンドもテストも動かない。
./core/build.sh

# バックエンド（要: SA の JSON 鍵 or gcloud ADC。Drive/Firestore を触らない範囲なら無くても起動する）
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
CLERK_ISSUER=https://xxxx.clerk.accounts.dev \
GOOGLE_APPLICATION_CREDENTIALS=~/keys/portal-api-dev.json \
GOOGLE_PICKER_API_KEY=<API キー> \
.venv/bin/uvicorn app.main:app --reload --port 8080
# SETTINGS_CHANNEL_PATH は未設定でよい。既定の development チャンネル
# （static-channels/development）を読み書きするため、ADC を持っていても
# 本番の共有設定には触れない。
# GOOGLE_PICKER_API_KEY はファイル選択（Google Picker）を試すときだけ必要。
# API キーのリファラー制限に http://localhost:5173/* を入れておくこと
# （「4. Google Picker」参照）。

# フロントエンド（/api は vite が localhost:8080 へプロキシ）
cd frontend
cp .env.example .env   # VITE_CLERK_PUBLISHABLE_KEY を設定
                       # 表示名を変えるなら VITE_PORTAL_TITLE も（省略可）
npm install
npm run dev
```

## 🧪 テスト

旧リポジトリのテスト（Cloud Function の pytest・GAS の jest）を新構成に移植しています。CI（`.github/workflows/tests.yml`）が push / PR ごとに実行します。

```bash
# 計算（Rust）: グレー本 3.2・3.3 の式、必要壁量と柱の小径、入力の解釈・表示の桁揃え。
# 計算そのものを検証するのはここだけ（画面もサーバもこの実装を wasm として
# 動かすため）。グレー本の計算例（図 3.2.2 と図 3.3.10）と、必要壁量の
# 表計算ツールに同梱されている入力例も、そのままテストにしてある。
cd core && cargo test

# 下の 2 つは、ビルドした .wasm（./core/build.sh）があることが前提。
# 無ければ、その旨のエラーで落ちる。

# バックエンド: API 経由の Excel 生成・証明書 PDF の生成と解析・計算書 PDF の往復と
# 保存時の突き合わせ・雛形設定・JWT 検証、必要壁量ツール（同梱した配布物へ実際に
# 書き込み、触っていない部品が 1 つも欠けないことまで確かめる。さらに配布物の
# 数式・入力例・圧縮基準強度の表と、写した計算を突き合わせる）
# （Drive/Docs/Firestore と認証はテスト内でフェイク）
cd backend && python -m pytest

# フロントエンド: フォームの純粋ロジック（バリデーション・数値正規化・ファイル名の組み立て・
# 釘配列図の縮尺）、画面とデータの往復、画面共通の部品（セクションの開閉・
# 各ページが id で探すマークアップ）、Google Picker の呼び出し、
# ビルドした .wasm を実際に読み込んでの計算
# （gapi / GIS / Picker はテスト内でフェイク）
cd frontend && npm test

# Firestore ルール: クライアント SDK からのアクセスが全面拒否されること
# （エミュレータを自動起動する。要 Java ランタイム）
cd firestore && npm ci && npm test
```

### カバレッジ

CI はテストを走らせるついでにカバレッジを測り、PR に貼り替え式のコメントとして 1 枚の表を出します（外部サービスは使わず GitHub Actions の中だけで完結します）。計測はテストの実行に相乗りするので、テストが 2 度走ることはありません。

| スイート | 計測 | 出力 |
| --- | --- | --- |
| Core（Rust） | `cargo llvm-cov`（cargo-llvm-cov） | `core/coverage.xml` |
| Backend（Python） | `pytest --cov`（pytest-cov） | `backend/coverage.xml` |
| Frontend（JS） | `vitest --coverage`（@vitest/coverage-v8。設定は `frontend/vite.config.js`） | `frontend/coverage/cobertura-coverage.xml` |

手元で測るときは、いつものテストのコマンドに次を足します。

```bash
cd core     && cargo llvm-cov --summary-only   # 要 cargo-llvm-cov（cargo install cargo-llvm-cov）
cd backend  && python -m pytest --cov=app --cov-branch --cov-report=term-missing
cd frontend && npm run test:coverage
```

3 つの道具はどれも Cobertura XML を出せますが、**書かれるファイルパスの基準がばらばら**（`src/report.rs` / `main.py` / `src/api.js`）なので、そのままでは 1 つの表にまとめられません。`.github/scripts/coverage.py` がそれをリポジトリのルート基準（`core/src/report.rs` 等）に直し（`normalize`）、まとめて数えます（`summary`）。パスが揃っているおかげで、**この PR が変えた行だけのカバレッジ**（diff-cover）も 3 スイートまたいで 1 回で出せます。

`tests.yml` の `coverage` ジョブはこの集計を表にして貼るだけで、ビルドもテストもしません。したがって **`coverage` の赤はしきい値割れ（表の 🔴）** であって、テストの失敗ではありません（テストの赤は各スイートのジョブに出ます）。しきい値はジョブ内の `THRESHOLDS` 1 か所にまとまっていて、`yellow` が「割ったら落とす下限」、`green` が「目指す水準」です。

- 画面（Frontend）の下限が低いのは、ブラウザの入口（各ツールの `main.js`・`auth.js`・`api.js` など）を単体テストが読み込まないためです。ロジックは `form-logic.js` / `form-dom.js` 側に寄せてあり、そちらはほぼ 100% 覆われています。**入口の配線だけを変える PR は差分カバレッジ（`Diff`）が落ちて赤くなり得ます**——その場合はテストを足すか、`THRESHOLDS.diff` を見直してください。
- Firestore ルールのテストはエミュレータ上でのルール評価なので行カバレッジという概念がなく、表には含めていません。
- 分岐（Branches）は参考値（常に ⚪）です。Rust の計測に分岐の情報が無く、スイートをまたぐと意味の違う数が混ざるためです。

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

## 📄 証明書マッピング (`backend/app/structural_cert_mapping.json`)

構造計算安全証明書は「雛形（Google ドキュメント）のどこに何を差し込むか」「どの選択肢のどの文字に ○ を付けるか」「PDF からどう読み戻すか」をこのファイルに集約しています。雛形が改訂された場合は、原則このファイルを編集するだけで（コード変更なしに）追従できます。画面のフォームも `/api/tools/structural-cert-formatter/config` がこのファイルから導出して配信するため、二重管理はありません。

| キー | 役割 |
| --- | --- |
| `text_fields` | 記入欄の定義。`placeholders` が雛形の `{{…}}` 文字列（複数書けるので表記ゆれにも対応できる） |
| `choice_groups` | 選択肢の定義。`anchor` が「その選択肢の行の先頭にある文字列」、`circle_length` が ○ で囲む文字数 |
| `sections` | 画面での並び順（証明書の記載順に合わせる）。項目は `field`（記入欄）・`choice`（選択肢）・`date`（日付ピッカー） |
| `parse_rules` | 既存 PDF を読み戻すときの抽出規則 |
| `circle` | ○ の余白と線の太さ |
| `output_file_name_template` | 既定のファイル名 |

### 雛形を作るとき・直すときの注意

* 記入欄は `{{建物名称}}` のように **二重波括弧** で書き、`text_fields[].placeholders` と一致させる。値が空の欄も置換されるので、プレースホルダーが証明書に残ることはありません。
* 雛形に無いプレースホルダーへ値を入力すると、保存は成功したうえで画面に「反映されていません」という警告が出ます（黙って欠落させません）。
* `anchor` と `parse_rules[].label` は **雛形の見た目どおり** に書けます（読み込み時に空白の除去と 1 文字ずつの NFKC 正規化を掛けて比較するため、全角数字・全角括弧・康熙部首の違いを気にしなくて構いません）。`parse_rules[].pattern` だけは正規表現なので、正規化後の表記（半角数字・半角括弧）で書いてください。
* `anchor` は雛形の中で **ちょうど 1 か所** に一致する必要があります。0 件（雛形が変わった）でも 2 件以上（区別できない）でも、○ の位置を誤らないようエラーで止まります。似た行がある場合は `anchor` を長くしてください。

### 実際の書き出し PDF での確認方法

```python
# 雛形を PDF へ書き出したもの（Drive の「ファイル → ダウンロード → PDF」でよい）を見て、
# anchor がどう抽出されるかを確認する。
from app import pdf_tools

pages = pdf_tools.read_layout(open("雛形.pdf", "rb").read())
for line in pages[0].lines:
    print(repr(line.text))          # ← ここに出る文字列がそのまま anchor に使える
```

テストでは雛形そのものを同梱せず（個人名・登録番号が入るため）、同じレイアウトの PDF を `backend/tests/pdf_util.py` がその場で組み立てています。

## 📐 必要壁量の表計算ツール (`backend/app/wall_quantity_mapping.json`)

必要壁量ツールが扱うのは、**リポジトリに同梱した配布物**（`backend/app/templates/wall-quantity/worksheet.xlsx`）です。書き込み先のセル・選択肢・条件・画面の並びは、すべて `wall_quantity_mapping.json` にあります。バックエンドはこれを `/api/tools/wall-quantity-calculator/config` でそのまま配り、画面はそれを読んでフォームを組み立てるので、**画面側に項目はありません**（`mapping.json` と同じ考え方）。

配布物の出所（配布ページ・版・sha256）は `backend/app/templates/wall-quantity/source.json` に控えてあります。更新の定期確認はこのファイルを基準にします。

### 表計算ツールが改訂されたときの手順

配布物は改訂されます（更新履歴シートに版と内容が載ります）。追従は次の 3 段で行います。

**1. 気付く（自動）**

`.github/workflows/howtec-worksheet-check.yml` が週に 1 度、配布ページを見に行きます。

| 見た結果 | すること |
| --- | --- |
| 同梱しているものと同じ | 何もしない（ログだけ） |
| 違うファイルが公開されている | 同梱ファイルと `source.json` を差し替えた **PR を出す** |
| ページが読めない・リンクを 1 つに絞れない | **issue を立てて**（同じ題の issue があればコメントを足す）、**実行を失敗にする** |

最後のものを成功のまま終えると、「緑だから最新版のままだ」と読めてしまい、**確認できていないこと自体に気付けません**。issue と併せて実行を赤くします。配布ページのリンクは `…/relays/download/441/1511/1312/6351/?file=/files/libs/6351/….xlsx` のように、拡張子が問い合わせ文字列の側にしか出てこない形なので、リンクの拾い方を変えるときはそこも見てください（`backend/tests/test_worksheet_check.py` が実物と同じ作りの HTML で押さえています）。

**2. 入力欄と計算がずれていないかを見る（自動）**

差し替えの PR には、**雛形の番人テスト**（`backend/tests/test_wall_quantity_template.py`）の結果が本文に書かれます。このテストは、マッピングが指しているセルに記録どおりのラベル・選択肢が入っているかを、新しいファイルに対して確かめます。

* ✅ 通っている → 入力欄の位置は変わっていません。更新履歴シートの内容だけ確かめてマージできます。
* 🔴 落ちている → 入力欄か選択肢が動いています。次の 3 を行ってからマージしてください。

**計算そのもの**は、`backend/tests/test_wall_quantity_calculation.py` が見ています。

* 配布物のシートに書かれている**数式**が、`wall_quantity_mapping.json` の `guard.formulas` に控えたものと 1 文字でも違えば落ちます。
* 配布物の「表計算ツール入力例」シート（入力と、Excel が計算した結果の両方が入っています）を丸ごと通し、`core/src/wall_quantity.rs` が同じ値を出すことを確かめます。
* 柱の圧縮基準強度の表が、配布物の隠しシートと同じであることも見ます。

ここが落ちたら、**計算が変わった**ということです。変わった数式を読み直し、`core/src/wall_quantity.rs` を直してから `guard.formulas` を更新してください（マッピングを直すだけでは計算は変わりません。数式の写しは Rust 側にあります）。

> GITHUB_TOKEN で作った PR では CI が自動で走らないため、この確認をワークフローの中で済ませて本文に書いています。

**3. マッピングを読み直す（手作業）**

見た目のラベルで判断すると解釈を誤ります。**配布物の「入力できるセル（保護が外れているセル）」を正として**、入力欄の位置を決めてください。配布物は全シートが保護されていて、**入力欄だけがアンロック**されているので、そこが機械的に分かります。

```python
# 入力欄（アンロックされているセル）と、その結合範囲・書式を並べる
import openpyxl
wb = openpyxl.load_workbook('backend/app/templates/wall-quantity/worksheet.xlsx')
ws = wb['表計算ツール（平屋建て）']
merged = {str(m).split(':')[0]: str(m) for m in ws.merged_cells.ranges}
for row in ws.iter_rows(max_col=23):
    for c in row:
        if c.protection.locked is False:
            print(c.coordinate, merged.get(c.coordinate, ''), c.number_format)

# プルダウン（選択肢の正）。formula1 が選択肢の在り処、sqref が対象のセル。
for dv in ws.data_validations.dataValidation:
    print(dv.sqref, dv.type, dv.formula1)
```

`INDIRECT(...)` を使ったプルダウン（柱材の樹種等・等級等）は、`柱の圧縮基準強度` シートの名前付き範囲を引いています。JAS 規格ごとの範囲は同シートの `I〜M` 列で、番人テストがその中身とマッピングの `species` / `grade` を突き合わせます。

チェックボックス（用途・算定方法）は、リンク先のセル（`W8` など）で見分けます。`xlsx_fill.py` が「リンクセルの値」「`ctrlProps` の `checked`」「VML の `<x:Checked>`」の 3 か所を揃えるので、マッピングに要るのは **リンクセルの参照だけ**です。

読み直したら `wall_quantity_mapping.json` の `guard` も新しい値に直します。ここは「次に配布物が変わったときに気付くための控え」なので、**中身を確かめたうえで**更新してください。

| `guard` の中身 | 何の控えか |
| --- | --- |
| `labels` | マッピングを書いたときに読んだラベル |
| `outputs` | 配布物の出力欄（オレンジの枠）と、画面に出す計算結果の key の対応 |
| `formulas` | 配布物のシートに書かれている数式そのもの（共有数式は先頭のセルだけ） |

## 🧮 計算の一元管理（Rust → wasm）

ポータルの計算は、**Rust で書いた 1 つの実装（`core/`）を wasm にして、画面とバックエンドの両方が動かします**。今のところ入っているのは、面材張り大壁と釘配列諸定数（グレー本 3.2・3.3）と、小規模木造建築物の必要壁量・柱の小径（配布物の表計算ツールの数式）です。

```
core/src/*.rs
  └─ core/build.sh ─→ backend/app/wasm/nail_array_core.wasm   ← ビルド成果物（コミットしない）
                        ├─ バックエンド（wasmtime）が読み込んで計算する
                        └─ GET /api/tools/<ツール>/core.wasm
                             └─ 画面がそのバイト列を受け取り、編集中の計算に使う
                                （面材張り大壁・必要壁量の両ツールが同じものを受け取る）
```

### なぜこうしたか

以前は「画面は入力のたびにバックエンドへ計算を問い合わせる」構成でした。実装が 1 つで済む代わりに、打鍵のたびに往復が発生し、計算量が増えるほど無視できない待ち時間になります。かといって画面側にも計算を書くと、実装が 2 つになって「画面の数値と計算書 PDF の数値が違う」を防げません。

そこで **実装は 1 つのまま、置き場所を両方にした**のがこの構成です。同じソースをそれぞれの言語へ移植するのではなく、**同じバイト列**（同じ `.wasm`）を両方が動かすので、片方だけ直す・片方だけ古い、が起こりません。式の意味を持つ処理はすべてここに入っています（グレー本 3.2・3.3 の式、釘の割り付け、表 3.2.1 の釘配列と表 3.3.1 の面材釘データ、入力欄の文字列の解釈、計算できない入力の説明文、有効桁の丸め、釘配列図の範囲と目盛の文字）。バックエンドと画面に残るのは、その結果を PDF に組む／DOM に並べる仕事だけです。

### 保存時の突き合わせ

編集中の値は画面が計算したものです。保存では**サーバがもう一度計算し、画面が送ってきた値と突き合わせます**（`panel_shear.verify` / `wall_quantity.verify`）。食い違いがあっても保存は止めず、画面に警告を出させます。

| ツール | 突き合わせるもの | 結果の返し方 |
| --- | --- | --- |
| 面材張り大壁（`POST …/reports`） | 壁と面材の計算結果（数値。相対差 `1e-9` まで許す） | 応答 JSON の `verification` |
| 必要壁量（`POST …/worksheets`） | 出力結果の升目（画面に出ている**表示文字列**そのもの） | 応答ヘッダ `X-Wall-Quantity-Verification`（本文は xlsx なので置き場所がここしかない） |

計算書 PDF に載るのは常にサーバの値なので、成果物が壊れることはありません。必要壁量の xlsx に入るのは入力値だけで、計算するのは Excel の数式なので、こちらも壊れません。

拾えるのは主に次の 2 つです。

* **画面が古い実装のまま動いている**（開きっぱなしのタブの裏で新しい版がデプロイされた）… 版番号（`core/Cargo.toml` の `version`）を突き合わせ、再読み込みを促します。
* **端末や処理系の差で末尾の桁が違う** … 相対差 `1e-9` を超えたら、どの壁・どの面材のどの項目かを挙げて知らせます。

同じ `.wasm` を動かしている以上ふつうは 1 ビットも違いません。それでも突き合わせるのは、「違わないはずのものが違ったとき」に黙って通さないためです。

### ビルドと配布

**`.wasm` はコミットしません**。CI がそのつどビルドします。

| いつ | どこで作るか |
| --- | --- |
| テスト（`tests.yml`） | Backend / Frontend の各ジョブが `core/build.sh` を実行してから走る |
| デプロイ（`deploy.yml` / `preview.yml`） | `gcloud run deploy --source backend` の前に `core/build.sh`。作った `.wasm` がイメージに入る |
| 手元 | 最初に 1 度 `core/build.sh`（`core/` を触るたびに再実行） |

`core/rust-toolchain.toml` で toolchain を固定してあり、この crate は外部クレートに依存していないため、**どこでビルドしても同じバイト列**になります（`cmp` で一致することを確認済み）。ジョブごとにビルドしても食い違いません。

`backend/.gcloudignore` は消さないでください。無い場合 gcloud は除外規則を自動で組み立てるため、`.gitignore` に載っている `app/wasm/` が Cloud Build へ送られず、**計算だけが動かないイメージ**が出来上がる余地があります。念のため `backend/Dockerfile` でも、`.wasm` が無ければイメージのビルド自体を失敗させています（動かしてみるまで気付けない壊れ方を作らないため）。

### 触るときの手順

```bash
cd core
cargo test          # 式ごとの検証（グレー本の計算例・各関数・入力検証）はここ
./build.sh          # wasm ビルド → backend/app/wasm/ へ配置
```

* 外部クレートには依存していません（JSON の読み書きも自前）。`.wasm` を小さく保ち、ビルドを再現しやすくし、計算の信頼性を crates.io の外に置かないためです。
* 計算の中身を変えたときは `core/Cargo.toml` の `version` も上げてください。保存時の突き合わせで「画面が古い」を検出できるのはこの値です。
* 必要壁量は、配布物（表計算ツール）の数式を写したものです。写しが合っていることは、配布物に同梱されている「表計算ツール入力例」シートを丸ごと突き合わせて確かめています（`backend/tests/test_wall_quantity_calculation.py`）。Excel の丸め（`ROUNDUP` / `ROUNDDOWN`）は 15 桁の十進表記で行われるので、`core/src/wall_quantity.rs` の `roundup` / `rounddown` もそれに合わせてあります。
* 画面が受け取る URL には中身のハッシュが付きます（`/config` が配る `core.url`）。内容が変われば URL が変わるので、古い実装がブラウザのキャッシュに残り続けることはありません。
* `.wasm` が無いまま動かすと、バックエンドも画面のテストも「`core/build.sh` を実行してください」と言って落ちます（黙って古い計算に落ちることはありません）。

## 🧮 計算書 PDF（面材張り大壁・釘配列諸定数）

証明書と違い、こちらは**雛形もマッピングも持ちません**。計算書は決まった書式の帳票ではなく計算過程そのものなので、レイアウトは `backend/app/panel_shear.py` の `_draw_panel_page`（面材 1 枚の釘配列諸定数）/ `_draw_diagram`（釘配列図）/ `_draw_wall_page`（大壁）に直接書いてあります。

* **書式は自由に変えてよい** ことにしています。読み戻しは本文の解析ではなく、PDF の文書情報に埋め込んだフォーム入力（`METADATA_KEY`）だけを見るためです。見出しの並べ替え・項目の追加・図の作り直しをしても、過去に保存した PDF は問題なく開けます。
* 逆に、**文書情報のキーと入力の形（`normalize_data` が返す構造）を変えると、過去の PDF は読めなくなります**。ここだけは互換性を意識してください（現状は暫定の形なので、必要なら作り直して構いません）。
* PDF の組み立ては `backend/app/pdf_write.py` の小さなライターで行います。使えるのは「文字を置く」「線・矩形・円を描く」だけです。座標は PDF の慣習どおり左下原点・単位はポイント（1/72 インチ）で、A4 縦を既定にしています。
* **フォントは同梱してサブセットを埋め込みます**（`backend/app/fonts/NotoSansJP-Regular.ttf`、SIL Open Font License 1.1。ライセンス全文は同じフォルダの `LICENSE.txt`）。字幅もこのフォントの実測値を使うため、右寄せ・中央寄せの位置は実際の描画と一致します。フォントを差し替えるときは `FONT_PATH` を変えるだけですが、**TrueType（glyf）形式**である必要があります（CFF/OTF は埋め込み方が変わります）。可変フォントの場合は、あらかじめ 1 つのウェイトに固定した静的フォントにしてから置いてください。
* 出来上がりを目で確かめたいときは、テストと同じ手順で PDF を書き出して開いてください。

```python
from app import panel_shear

# グレー本 3.3(3) の計算例（図 3.3.10）。面材 2 枚 ＋ 壁 1 枚の 3 ページになる。
data = panel_shear.example_wall_data()
open("大壁の計算書.pdf", "wb").write(panel_shear.build_pdf(data, panel_shear.validate(data)))

# 面材を差し替えるなら、壁の panels をいじる（例: グレー本 3.2 解説の計算例）。
data = panel_shear.normalize_data({
    "projectName": "○○邸 新築工事",
    "issuedOn": "2026-08-11",
    "walls": [{
        **panel_shear.material(panel_shear.EXAMPLE_WALL_MATERIAL),
        **panel_shear.EXAMPLE_WALL,
        "panels": [panel_shear.EXAMPLE_PANEL],   # グレー本 解説の計算例（図 3.2.2）
    }],
})
open("計算書.pdf", "wb").write(panel_shear.build_pdf(data, panel_shear.validate(data)))
```

## 🚀 ロードマップ

- [x] **Phase 1: ポータル基盤**
  - Firebase Hosting + Clerk + Cloud Run + 代理アクセスの基盤構築と CI/CD。
  - 現況検査レポート作成ツール（GAS 版と同等機能）の移植。
- [ ] **Phase 2: 移行の完了と拡張**
  - 旧 GAS 版からの利用切り替え・GAS の廃止。
  - 「非破壊検査」フォーマットへのマッピング対応、画像アップロード機能。
  - 面材張り大壁 計算ツール（グレー本 3.3 と、その中で使う 3.2 の釘配列諸定数）
    は完了。続きは真壁・床/屋根の水平構面
    （グレー本 3.4〜3.6）と、面材・釘・枠材のマスタからの選択
    （GAS 版 ROADMAP のフェーズ 1・3）。
  - 小規模木造建築物 必要壁量 計算ツール（配布物の表計算ツールへの記入）は完了。
- [ ] **Phase 3: AI（Gemini API）連携による自動化**
  - 手書き図面の画像から計測値を抽出し、フォームに初期値を自動設定。
- [ ] **Phase 4: 実運用向けチューニング**
  - 生成した Excel の Drive への自動保存など（代理の書き込みスコープは構造計算安全証明書 作成ツールの追加で導入済み）。
