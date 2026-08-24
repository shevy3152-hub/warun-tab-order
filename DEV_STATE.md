# 開発状態

最終更新: 2026-08-24
対象: `C:\Users\user\Documents\ChatGPT\タブレットオーダーシステム`
ブランチ: `feature/sqlite-foundation`
HEAD: `db87eb32971c5b333b32b9ecb6c6a3a5d383ebb6`
直近commit: `fix: streamline sake serving selections`

## 現在の目標

safe-copyを対象に、客席注文、厨房表示、管理画面、pairing、認証、通信診断を既存のschema v4・注文API・注文snapshotで安全に運用する。本番DBは対象外とする。

## 完了した内容

- 日本酒は既存の提供方法ポップアップ内でvariantごとの温度制限を判定する。グラス・冷専用・燗専用は温度を自動選択して不要なボタンを出さず、冷／燗両対応だけ温度を選択する。サイズ・温度の選択だけでは追加せず、最後の追加操作でカートへ入れる。
- 日本酒のvariant名・容量・温度は注文snapshotへ保持し、厨房だけを`商品名（グラス・冷）`、`商品名（1合・燗）`、`商品名（2合・冷／燗）`の短縮表示にする。日本酒以外の厨房表示は変更しない。
- 焼酎は飲み方ポップアップでロック・水割り・ソーダ割り・お湯割りを個別数量選択できる。数量選択中はカートを変更せず、確定時だけ追加する。同じ飲み方は数量加算、異なる飲み方は別明細とする。数量0の確定はdisabled、キャンセル・×・背景クリックは破棄する。
- 焼酎数量操作へ`touch-action: manipulation`等を限定適用し、ページ全体のズーム禁止は行っていない。A90横画面向けにポップアップのフッターとタップ領域を維持する。
- 客席の「送信済みです。ご注文を承りました。」通知は4秒後に自動消去する。送信中・送信待ち・エラー通知は対象外とする。
- 日本酒の温度付き注文payload（schemaVersion 3）をHTTP境界で受理し、許可温度以外を拒否する。既存の冪等性、DB保存、厨房snapshot、客席履歴の経路は維持する。
- safe-copy専用厨房tokenを管理tokenと分離し、再起動後も保存値・DB hash・active kitchen deviceを照合して起動する。不一致時はランダムtokenで起動せず、safe-copy限定の明示provisionまたは起動停止とする。token平文は状態文書・ログ・レスポンスへ記録しない。
- 通信診断API、管理画面の折りたたみ診断欄、safe-copy起動経路、読み取り診断Skillを整備した。診断記録はrequest ID、endpoint、status、公開error code、処理段階、件数などに限定し、Authorization、token、QR本文、注文本文、個人情報を記録しない。
- A90実機受入はユーザー報告で、safe-copy認証、注文取得、日本酒の温度表示、variant別温度選択、焼酎UI、厨房短縮表示をALL PASS確認済み。既存の注文・履歴・pairing情報は変更していない。

## 主要な決定事項

- 商品データ、DB schema、注文API、注文snapshotのモデルを増やさず、既存のvariant・temperature・serving option snapshotを使う。
- 管理tokenを厨房tokenの代用にしない。厨房tokenは管理tokenと別値のまま維持する。
- 客席・厨房・管理画面のAPIは同一safe-copy originを基本とし、注文送信は既存の`POST /v1/orders`、厨房取得は既存の`GET /v1/snapshot`を使う。
- production DB、既存注文、既存履歴、pairing、QR、Sites保護対象ファイルをUI変更の対象にしない。
- 未確認のA90実通信やブラウザ表示を、コード照合や静的bundle確認だけでPASS扱いしない。実機確認済みの項目と、この環境で独立取得できない項目を分けて記録する。

## コアファイル

- 客席・厨房・管理UI: `prototype/src/App.jsx`, `prototype/src/styles.css`
- 注文payload・再送・通知: `prototype/src/order-outbox.js`, `prototype/src/customer-order-notice.js`
- 厨房・管理通信: `prototype/src/kitchen-api.js`, `prototype/src/admin-pairing.js`
- serverの注文境界・snapshot・診断: `server/src/http/json-body.mjs`, `server/src/http/http-server.mjs`, `server/src/events/snapshot-service.mjs`, `server/src/diagnostics/diagnostic-recorder.mjs`
- safe-copy起動・厨房認証: `server/start-safe-copy.ps1`, `server/scripts/provision-safe-copy-kitchen-token.mjs`
- 主な回帰テスト: `prototype/tests/customer-ui.test.mjs`, `prototype/tests/kitchen-api.test.mjs`, `prototype/tests/order-outbox.test.mjs`, `server/test/`
- 永続コンテキスト: `prototype/CONTEXT.md`

## テスト結果

- 2026-08-24再確認: server全テスト `365/365`、prototype全テスト `77/77`。
- 既存記録でDirect Vite buildは `4580 modules transformed`、Sites workerは `4/4`。
- 日本酒温度付きHTTP E2E、焼酎の水割り1・ソーダ割り2のsnapshot E2E、厨房tokenの再起動境界・不一致safe-stop、通信診断APIのテストは成功済み。
- 今回の文書更新後の`git diff --check`は成功した。
- pnpm経由の一部build／Sites実行は、依存復元・ビルド承認に関する既存の環境ガードで停止したため、Direct Viteと直接Sites workerテストで確認している。依存やpnpm設定は変更していない。

## Gitと現在の作業状態

- `git status --short --branch`では、この更新による`DEV_STATE.md`だけが未stageの追跡差分で、stage済み差分はない。originとの差分表示は`ahead 8, behind 16`。
- 未追跡の`.codex-worktrees/pairing-js-fix/`は既存作業として保持し、stageしていない。
- 最新commitは上記4ファイルを対象としたcheckpointであり、push、pull、merge、rebase、resetは行っていない。
- 個人Skill `warun-connection-diagnostics`はリポジトリ外にあり、Git管理対象へ追加していない。

## 既知の問題・未確認事項

- この環境ではブラウザ接続資材の問題により、A90のアドレスバー・実viewport・ネットワークパネル・独立スクリーンショットを取得できない。A90実機PASSはユーザー確認として記録し、こちらの独立ブラウザ確認とは区別する。
- `Get-NetIPAddress` と `Get-CimInstance Win32_Process` はこの環境の権限制限で拒否されたため、PowerShellの詳細なNIC列挙と実プロセスのコマンドラインは未確認。`ipconfig`、`Get-Process`、runtime-state、health、待受の読み取り結果は一致している。
- Skill validatorは同梱環境のPyYAML不足で実行できず、frontmatter、命名、TODOなしを手動確認した。
- 本番環境の複数実機通信や本番DBでの運用保証は、このprototype／safe-copy検証の範囲外である。

## safe-copy読み取り診断 2026-08-24

- `warun-connection-diagnostics`の読み取り専用ヘルパーを実行した。POST、再起動、pairing、QR発行、接続解除、token変更、DB書込み、Git操作は行っていない。production DBも開いていない。
- 現在の実測は、ブランチ`feature/sqlite-foundation`、HEAD`db87eb32971c5b333b32b9ecb6c6a3a5d383ebb6`、Web/API`25173/28787`、共通待受PID`3404`、Node実体`C:\Program Files\nodejs\node.exe`、safe-copy DB`server/var/safe-copies/initial-menu-20260818.sqlite3`、LAN IPv4`192.168.1.5`、A90 URL`http://192.168.1.5:25173/customer/customer-01`である。
- healthはHTTP 200、`status=ready`、`db=ready`、schema v4、health PID`3404`。管理preflightはHTTP 200・admin認証valid・safe-copy。`GET /v1/admin/order-history`はHTTP 200・11件、`GET /v1/snapshot`はHTTP 200・activeOrders 2件・openSession 1件だった。
- 焼酎カタログ適用前のsafe-copy DB読み取り集計は`orders=13`、`order_items=22`、`event_log=96`、注文statusはcompleted 11件・new 2件で、履歴11件＋active snapshot 2件と整合する。この値は今回適用前の基準値である。
- `DEV_STATE.md`のブランチ、HEAD、DB target、ports、runtime-state、health、Git dirty状態は実測と整合した。旧基準点や旧PIDは現況ではなく、今回の実測値を正とする。

## 失敗した方案・採用しなかった対応

- 日本酒のサイズ選択時に即時追加する方式は採用せず、温度確定後の明示的な追加操作へ統一した。
- 焼酎の飲み方選択時に即時カート追加する方式は廃止し、一時数量と確定操作を分離した。
- 無効な厨房tokenを管理tokenへfallbackする方式、厨房tokenを削除して管理tokenを使う方式は採用していない。
- 未確認の実機エラーを401/403/409/422/500へ推測分類する方式、注文再送・再登録・QR再発行で確認する方式は採用していない。
- pnpmの環境ガードを依存変更で回避せず、既存node_modulesを使うDirect Vite・直接Sites worker検証へ切り替えた。

## 次の一手

今回のsafe-copy読み取り診断は完了した。新しい要件や障害が出るまで、完了済みのA90 UIを作り直さない。A90相当viewportの独立目視が必要になった場合は、safe-copyを再起動せず、注文送信・pairing・QR操作なしで確認する。

## 焼酎12商品カタログ対応 2026-08-24

- `docs/initial-menu-import-draft.md`の対象12商品へ、公式商品ページまたは現行メニュー原稿を根拠にした20〜35文字程度の売り文句と、根拠を確認できた蔵元・産地・味・香り・キレ・おすすめ情報を追加した。stable_id、商品名、税込価格、区分、sort_order、4種類のserving_options 48件は変更していない。
- safe-copy適用範囲を限定するため、既存importerと同じ形式の部分原稿`docs/shochu-catalog-import.md`を追加した。全体の初期原稿をdry-runした際、焼酎以外にも既存の古い説明との差分が検出されたため、今回の適用には使わず、12商品だけを指定する部分原稿を採用した。
- 機械処理用の画像対応表`docs/shochu-catalog-image-map.md`は既存形式の空表とした。公式画像候補は12件調査したが、再利用許諾を明示確認できた画像は0件、権利確認待ちは12件であり、画像ファイルの取得・加工・safe-copyへの取り込み・外部hotlinkは行っていない。現在の画像URIは12件ともnullのままである。
- 確認表`docs/shochu-catalog-review.md`に、商品名、stable_id、区分、税込価格、売り文句、公式出典、画像出典、利用条件、画像状態、要確認事項を記録した。月心と天誅は公式の商品詳細説明を追加確認できていないため、現行原稿を超える説明を創作していない。
- safe-copy DBを`server/var/safe-copies/backups/initial-menu-20260818-before-shochu-catalog-20260824.sqlite3`へ事前バックアップし、importer apply時にも`server/var/safe-copies/backups/initial-menu-20260818-before-shochu-catalog-importer-20260824.sqlite3`へバックアップした。本番DBには適用していない。
- 部分原稿のdry-runはcategory unchanged、商品12件 update、画像警告24件（商品画像12・detail画像12）、error 0。applyは成功した。適用後は`PRAGMA integrity_check=ok`、`orders=13`、`order_items=22`、`event_log=108`、注文status completed 11件・new 2件、12商品のactive serving_options各4件を確認した。適用前96件のevent_log全行、既存注文13件、注文項目22件は保持され、新たに`menu.updated` 12件だけが追加された。
- 認証済みsafe-copy管理APIの`GET /v1/menu`を再取得し、対象12件の売り文句・detail・画像URI nullを確認した。管理フォームは既存の画像URI、短い説明、詳細説明、詳細フィールド、4種serving_optionsを個別にPUTでき、管理catalog専用server testとprototypeのadmin-pairing/UIテストで契約を確認した。共有safe-copyへ同値PUTを追加実行してevent_logを不要に増やすことはしていない。
- 検証: importer関連9/9、server全365/365、prototype全77/77、Direct Vite 4580 modules、`pnpm run build`、Sites worker 4/4、production browser smoke（success/401/403/network failure）、`git diff --check`。sandbox内pnpm復元はregistry EACCESだったが、承認付きでlockfile固定依存を復元し、install scriptsを実行しない形でbuildを完了した。依存定義・lockfile・Sites保護対象ファイルは変更していない。
- 未確認: in-app browserで客席URLを開くと未登録端末のpairing画面となったため、QR本文やpairing codeを取得・入力せず、A90客席画面の独立スクリーンショットは取得していない。認証済みAPI再取得とbrowser smokeで代替確認した。実機A90の画像なし・売り文句・詳細モーダルの目視は未確認である。

## 次の一手

権利確認済みのローカル画像素材が得られた場合だけ、既存stable_id名のWebPを既存配置へ追加し、画像対応表へ行を追加して再度dry-run・safe-copy適用・A90表示確認を行う。許諾が得られない場合は、現在の画像なし表示を維持する。

## 焼酎添付画像候補確認 2026-08-24

- 添付 `C:\Users\user\Pictures\shochu-menu-assets-14-bottles.zip` を作業用一時領域へ読み取り展開し、README、manifest、contact-sheet、画像寸法を確認した。thumbは14件すべて560×560 PNG、detailは14件すべて760×1320 PNGで透過だった。
- manifestは対象12商品に加えて伊佐美・薩摩茶屋を含む14商品。現行stable_idに対応する候補名は12件確認できたが、README/provenanceが「ユーザー撮影写真を基にしたAI再構成」で、ラベル細部が実物と完全一致しない可能性を明記している。先行要件のAI再生成ラベル禁止・現行ラベル／容量一致必須に抵触するため、採用可能画像は0件、候補保留12件、対象外2件とした。
- `docs/shochu-catalog-image-map.md` は既存importer形式のヘッダーだけを維持し、候補URI行を追加していない。画像ファイルはリポジトリ・safe-copyへコピーせず、外部hotlinkも行っていない。safe-copy DBのバックアップ、importer dry-run/apply、DB書き込みは画像候補について実施していない。
- 現行コードとの差異として、焼酎客席一覧がimageUriを持つ商品でも常に「画像なし」プレースホルダーを描画していたため、`prototype/src/App.jsx`を最小変更し、焼酎も既存の`product-image-button`経路でthumbを表示し、detail画像は既存詳細モーダルへ渡すようにした。既存の管理画面画像URI入力・認証付きPUT・DBカラムは変更していない。
- 変更後もstable_id、商品名、価格、区分、売り文句、4種類の飲み方、DBの注文・履歴・event_logを変更していない。現在のsafe-copy実測は`orders=13`、`order_items=22`、`event_log=110`、`PRAGMA integrity_check=ok`。過去の焼酎適用後記録108件との差分2件は、画像作業のdry-run/applyではなく、直近の別menu.updatedイベントだった。A90実機の画像表示目視は未確認で、画像採用待ちのためsafe-copy表示適用も未実施。commitは行っていない。
- 検証はimporter dry-run（category unchanged、warning 24、error 0）、importer関連7/7、server 365/365、prototype 77/77、Direct Vite 4580 modules、Sites worker 4/4、`git diff --check`。`pnpm run build`は既存の非TTY依存復元ガードで停止したため、依存・設定を変更せずDirect ViteとSites準備・inlineを実行した。

次: AI再構成でない権利確認済み・現行商品一致確認済み画像を受領した場合だけ、既存配置へthumb/detailを追加し、画像対応表のdry-run、safe-copyバックアップ/apply、A90実機確認後にcommitする。

## 焼酎実物元写真 仮画像v1適用 2026-08-24（最新）

- `C:\Users\user\Downloads\shochu-original-photos-12.zip` の `README.md` と `manifest.csv` を確認した。元写真12枚はmanifestのstable_idと商品名に対応し、伊佐美・薩摩茶屋は含まれず、対象外商品への適用も行っていない。元写真のSHA-256、元写真名、加工画像名、加工後SHA-256は `docs/shochu-catalog-review.md` に記録した。
- 仮画像としてsafe-copyへ適用した商品は12件・24ファイル、恒久公開利用条件の確認待ちは12件。今回のsafe-copy反映はユーザー指示に基づく仮運用であり、恒久素材として扱う前に利用条件を別途確認する。
- AIによるラベル・ボトル生成、描き直し、generative fillは行っていない。`prototype/scripts/process-shochu-image-assets.py` でEXIF向き補正、軽微な手動傾き補正、明るさ・コントラスト補正、thumbのラベル中心トリミング、detailのボトル全体縦横比統一、縮小、WebP変換だけを行った。安全な背景除去で商品輪郭を損なう可能性があるため背景は元写真を保持した。出力は `prototype/public/menu-images/shochu/` のstable_id＋`-thumb-v1.webp`／`-detail-v1.webp`、各12枚、合計24枚で、thumb 560×560・detail 760×1320、画像内への文字焼き込みはない。
- 機械処理用対応表は既存importer形式の `docs/shochu-catalog-image-map.md` に24行を追加した。商品URIとdetail URIは別行・別ファイルで、Markdown原稿の売り文句・詳細情報とは分離されており、管理画面またはimport原稿から画像だけを版更新できる。
- safe-copy DB `server/var/safe-copies/initial-menu-20260818.sqlite3` の事前バックアップを `server/var/safe-copies/backups/initial-menu-20260818-before-shochu-images-v1-20260824.sqlite3` に作成した。importer apply時にも自動バックアップ `server/var/safe-copies/initial-menu-20260818.sqlite3.before-catalog-import-1787575389437.sqlite3` が作成された。dry-runはcategory unchanged、商品12件 update、warning 0、error 0。safe-copy applyは成功し、production DBは開いていない。
- 適用前に実DBで確認した基準は `integrity_check=ok`、`orders=13`、`order_items=22`、`event_log=113`、焼酎12商品、active serving_options 48件、焼酎画像URI nullだった。過去の本書記録にあるevent_log 110件とは不一致があるため、今回の実DB確認では実測113件を正とした。
- 適用後は `integrity_check=ok`、`orders=13`、`order_items=22`、`event_log=125`、焼酎thumb URI 12件、detail URI 12件、active serving_options 48件を確認した。事前バックアップとの比較で注文13件、order_items 22件、既存event_log 113行、全variant、日本酒variant 12件、焼酎serving_options 48行、商品情報（stable_id・商品名・区分・価格・売り文句・詳細フィールド）を保持した。追加イベントは対象12商品の `menu.updated` 12件で、注文・履歴の削除はない。
- 既存importerが画像だけの更新でも同一内容のserving_optionsのversion・更新時刻を進める差異を検出したため、`server/src/catalog/catalog-markdown-importer.mjs` を最小修正し、飲み方の名前・有効状態・順序に差がある場合だけ更新するようにした。safe-copyでは事前バックアップから飲み方48件のversion・更新時刻だけを復元し、内容変更なしを確認した。importer関連テストは8/8で、画像だけの更新で飲み方versionを進めない回帰テストを追加した。
- 検証済み: v1出力24枚のWebP形式・寸法・SHA-256、safe-copy importer dry-run、importer関連8/8、safe-copy integrity_check、注文・明細・既存event_log・variant・serving_options保持、server全367/367、prototype全77/77、Sites 4/4、Direct Vite build 4580 modules、Sites準備／inline、`git diff --check`。既存safe-copy Webポートのthumb/detail URLはHTTP 200で取得でき、URIは `/menu-images/shochu/...webp` のローカル配信で外部hotlinkではない。新しいserver側WebP MIME設定は専用テストで`image/webp`を確認した。
- 未確認: 現在稼働中のsafe-copyプロセスは再起動していないため、配信確認時のContent-Typeは既存プロセスの`application/octet-stream`だった（画像データはHTTP 200）。A90実機で一覧thumb、詳細detail、文字量、ボタン、スクロール、表示速度を独立目視していない。in-app browserを1280×800で開くと未登録端末のpairing画面となり、直URL画像はブラウザ側ポリシーでブロックされたため、QR本文・pairing codeは扱わない。実機A90の画像表示PASSを推測で補完しない。commitは行っていない。
- 最新Git状態はブランチ`feature/sqlite-foundation`、HEAD`db87eb32971c5b333b32b9ecb6c6a3a5d383ebb6`、`ahead 8 / behind 16`。既存変更と今回の画像・importer・MIME・テスト・文書差分は未stage、既存未追跡`.codex-worktrees/`は保持している。reset、pull、merge、rebase、commit、pushは行っていない。

次: safe-copyを再起動せず、利用可能なA90または同等の1280×800 viewportで客席一覧と詳細を目視確認し、画像の見切れ・文字・ボタン・スクロールを確認する。確認後もcommitはユーザーの実機確認PASS指示まで行わない。

## 焼酎thumb白帯の表示調整 2026-08-24

- 焼酎一覧の正方形thumbを縦長の商品画像枠へ`contain`表示した際に出ていた上下の余白を、`.shochu-menu-row .product-image-button img`だけ`object-fit: cover; object-position: center;`へ変更して解消した。detail画像、日本酒画像、画像URI、DB、商品情報は変更していない。
- 関連UI 21/21、prototype全77/77、Sites worker 4/4、Direct Vite build 4580 modules、inline、Sites準備、`git diff --check`を確認した。commitは未実施。

次: A90または同等viewportで焼酎一覧のラベル欠けがないことを目視確認する。

## 次回修正候補：焼酎一覧の視認性・レイアウト

- 焼酎一覧のサムネイルをもう少し大きくできるか確認する。`object-fit: cover`によるラベル欠けがない範囲で、画像枠と行内余白を再調整する。
- 商品名にフリガナを表示できるよう、既存detailの`reading`フィールドを焼酎一覧にも接続する。stable_idやDB schemaは変更しない。
- 売り文句／説明文の文字がA90で小さすぎるため、特に`max-width:1350px`側の文字サイズ・行間・表示行数を見直す。
- 金額と「飲み方を選ぶ」ボタンが接近して潰れて見えるため、焼酎行のgrid列、gap、価格列幅、ボタンの最小幅・paddingを分離して再設計する。価格とボタンの視認性・タップ領域を1280×800で確認する。
- 次回はA90実機または同等viewportで、サムネイル、フリガナ、説明文、金額、飲み方ボタン、横スクロール／縦スクロールをまとめて目視確認する。今回のターンではこれらのUI変更は実施していない。

## 焼酎A90一覧調整 2026-08-24（最新）

- `C:\Users\user\Downloads\shochu-original-photos-12.zip` の同じ実物元写真12枚だけを使い、`prototype/scripts/process-shochu-thumb-assets.py`でthumb v2を作成した。許可範囲の向き／傾き、明るさ・コントラスト、620×760のラベル中心トリミング、560×700 WebP化だけで、AI生成・ラベル描き直し・detail再処理は行っていない。12商品の主ラベル主要文字が欠けていないことを画像で確認し、detail v1は変更していない。
- `prototype/public/menu-images/shochu/`に`*-thumb-v2.webp`を12枚追加し、SHA-256は`docs/shochu-catalog-review.md`へ記録した。`docs/shochu-catalog-image-map.md`の既存`target | image_uri`形式もthumb v2へ更新した。safe-copy DBは今回変更せず、客席一覧の表示時だけ`*-thumb-v1.webp`を`*-thumb-v2.webp`へ解決する。detail URI、管理画面の画像URI編集経路、stable_idは維持した。
- 焼酎行を番号／thumb／商品情報／価格／操作の固定列へ変更し、商品情報だけを`minmax(0, 1fr)`にした。通常幅は`68px 88px minmax(0, 1fr) 112px 172px`、列間12px、A90向けmax-width側は`48px 64px minmax(0, 1fr) 86px 148px`、列間12pxとし、価格と操作の間隔を確保した。thumb表示枠を拡大し、説明文字も焼酎行だけ15px・行間1.45へ調整した。操作文言は「飲み方選択」、`white-space: nowrap`、固定幅とし、既存のポップアップ選択・色変化・数量追加処理は変更していない。右注文欄と左折りたたみ帯、日本酒・他カテゴリは変更していない。
- 関連UI 22/22、prototype全78/78、Sites worker 4/4、Direct Vite build 4580 modules（`--configLoader runner`）、Sites準備／inline、`git diff --check`を確認した。thumb v2 12枚のWebP形式・寸法・SHA-256、detail v1 12枚の維持、一覧12行、v2 URI、価格／操作列幅、横スクロールなしはローカル確認した。
- safe-copy DB・production DBへの書込み、importer apply、DBバックアップ、注文送信、pairing、QR操作は今回行っていない。ブラウザはsafe-copy客席URLで未登録pairing画面となり、ブラウザ提供viewportも2560×1441固定で1280×800へ変更できなかったため、A90実機PASSは推測で補完していない。commit、push、pull、merge、resetは行っていない。

次: ユーザーのA90実機で12商品のラベル判別、白帯なし、説明文、価格と「飲み方選択」の非接触、横スクロールなしを確認し、PASS後にcommit可否を判断する。

## 客席商品行共通UI・一覧画像表示設定 2026-08-24（最新）

- `prototype/src/App.jsx`の客席商品行を、商品名と「タップで明細」を中心とする共通表示へ整理した。焼酎一覧の長い売り文句、一覧のフリガナ、酒種は表示せず、既存のdetailデータは保持して詳細モーダルへ表示する。詳細モーダルは商品画像、商品名、フリガナ、売り文句、詳細フィールドを表示し、説明・おすすめを表示行数内に抑え、閉じるヘッダーを固定し、「一覧へ戻る」導線を追加した。
- 客席行は番号／画像／商品情報／価格／操作の固定列（商品情報だけ可変）へ統一した。画像OFF時は画像列・画像枠をDOMごと出さず、価格と操作の間を16px以上確保した。操作列は固定幅、＋ボタンも固定サイズ、日本酒の「提供方法を選ぶ」と焼酎の「飲み方選択」は1行表示を維持した。焼酎は既存実物写真由来のthumb v2を表示時に使用し、detail v1は変更していない。
- 現行schema v4とDB/APIを照合した結果、他カテゴリの一覧画像ON/OFFを永続化する既存項目はなかったため、`menu_item_details.show_image_in_list`を追加するschema v5 migration、catalog repository、HTTP DTO、認証付き管理PUT、Markdown importer、管理フォームのチェックボックスを最小構成で追加した。`detail.show_image_in_list`は省略時に既存値を保持し、新規はfalseとする。日本酒は既存表示、既存画像を持つ焼酎は既存互換で表示し、他カテゴリは明示ON時だけ表示する。
- schema v5はテスト用一時DBでのみmigration・整合性を確認した。現在稼働中のsafe-copyは読み取りGET `/v1/health`でschema v4のままであり、今回safe-copy DB・production DBへのmigration、データ書込み、再起動、importer apply、バックアップは行っていない。注文、order_items、event_log、stable_id、価格、variant、飲み方、注文snapshotは変更していない。
- 検証: server全367/367、prototype全78/78、Direct Vite build 4580 modules（`--configLoader runner`）、Sites worker 4/4、Sites準備／inline、`git diff --check`。関連catalog/APIテストも成功した。
- 未確認: A90実機の独立目視は未実施。in-app browserは未登録pairing画面となり、提供viewportは2560×1441固定で1280×800へ変更できなかったため、一覧12商品の文字判別、詳細モーダルの無スクロール、ビール／日本酒の画像OFF／variant表示、実機の横スクロールなしをPASS扱いしていない。ユーザーのA90実機確認が必要である。
- Gitは`feature/sqlite-foundation`、HEAD `db87eb32971c5b333b32b9ecb6c6a3a5d383ebb6`、origin比 `ahead 8 / behind 16`。既存未追跡`.codex-worktrees/`は保持し、reset、pull、merge、rebase、commit、pushは行っていない。

次: safe-copyを変更せず、A90実機または1280×800相当viewportで焼酎・詳細・ビール・日本酒を目視し、PASS後にのみcommit可否を判断する。

## 終了時点レビュー 2026-08-24

- 照合結果: 現在のコード、Git差分、HEAD、`DEV_STATE.md`、`prototype/CONTEXT.md`を再照合した。実リポジトリを正とし、HEADは`db87eb32971c5b333b32b9ecb6c6a3a5d383ebb6`、ブランチは`feature/sqlite-foundation`、origin比は`ahead 8 / behind 16`のまま。既存変更と未追跡`.codex-worktrees/`は保持している。
- 本日の実装: 客席商品行の共通固定列、一覧の「タップで明細」、詳細モーダル、画像表示ON/OFFの管理フォーム接続、catalog repository／HTTP DTO／Markdown importerのschema v5対応を実装した。stable_id、価格、variant、飲み方、注文snapshot、履歴、event_logは変更していない。
- 検証結果: server 367/367、prototype 78/78、Direct Vite build 4580 modules、Sites worker 4/4、Sites準備／inline、`git diff --check`を実行済み。変更・新規テキストの機密情報パターン検査は実施済みで、検出0件。
- A90実機: 大幅に改善したが微調整が必要。完全PASSとはしない。A90独立目視、詳細モーダルの無スクロール、他カテゴリ画像OFF、実機での横スクロールなしは未検証である。
- `show_image_in_list`はschema v5までコード実装済み。ただし稼働中safe-copyはschema v4で、DB書き込み・再読込・v4→v5 migrationは未実施かつ未検証。safe-copy再起動も行っていない。
- 終了時点でsafe-copy／production DB、バックアップ、ログ、dist、runtime-state、機密情報、注文送信、QR・pairingには変更・操作を行っていない。これらと`.codex-worktrees/`はcommit対象に含めない。commit、push、pull、merge、rebase、resetも未実施。

### 次回タスク

- A90で商品一覧・詳細モーダルを微調整する。
- safe-copyをバックアップしてschema v4→v5 migrationを検証する。
- 管理画面で「一覧に画像を表示」の保存・再読込を確認する。
- 管理編集一覧のカテゴリ分け、編集後に元のカテゴリ・位置へ復帰する処理、編集画面の閉じる／キャンセルを確認・修正する。
- 焼酎区分と並び順の不具合を修正する。
- フリガナの保存・表示経路を確認する。
