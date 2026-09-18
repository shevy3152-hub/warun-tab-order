# 開発状態

## 2026-09-18 フード料理説明＋サムネイル対応 checkpoint

実装commitは`274a459`（`feat: show food descriptions in customer menu`）。フード商品名の直下へ既存`description`を料理説明として表示し、客席の商品行を画像有無に対応した構造へ整理した。管理画面の商品説明欄は、フードでは「料理説明」、ドリンクでは「商品説明／一言コメント」と表示する。

- フード料理説明は最大2行。空欄時は要素・余白を生成しない。
- 画像がある商品だけサムネイル枠を表示し、画像なしでは文字領域を拡張する。
- detail画像なしの商品は詳細を開かない。詳細画面のdescription全文表示は維持する。
- ドリンクコメント、予約限定、串カツ、黒焼きvariantの回帰を確認した。
- A90料理説明表示PASS。実画像付きフード商品のサムネイル目視は、画像登録時に確認する。
- safe-copyはschema v8、event_log 339。DB、商品情報、注文データは不変。production未反映。
- 検証: prototype 102/102、Sites 4/4、Vite build、`git diff --check`。server差分なしのため既存379/379を採用した。
- production DB、pairing、注文送信、push/pull/merge/rebaseは未実施。`prototype/CONTEXT.md`と既存未追跡ファイルは保全した。

### 未完了タスク

1. runtime-state.json権限エラー
2. 左赤レールの名称・位置・折り畳み表示改善
3. 本日の営業時間編集
4. 半身焼きを名物へ移すか決定
5. production環境の特定・反映

## 2026-09-18 商品単位予約限定・ドリンク一言コメント checkpoint

実装commitは`6aa39aa`（`feat: add reservation-only ordering and drink comments`）。実装対象を確認し、schema v7→v8、商品単位の`ordering_mode`、管理APIの取得・保存・不正値拒否、予約限定商品の注文前422拒否、客席の注文操作非表示、カテゴリー名編集、名物fallback／初期データ、ドリンク一覧の一言コメントを反映した。

- schema v8。既存商品は`normal`、半身焼き・ホールの2件だけ`reservation_only`。
- 客席の予約限定表示は「予約限定」のみ。＋ボタン、数量選択、variant／飲み方選択は表示しない。
- 直接注文は保存前に422で拒否し、文言は「この商品は予約限定のため注文できません」。
- 管理画面のカテゴリー名編集は正式APIへ保存し、再取得後のstate更新と再読込保持を維持する。正式名称は「名物」。
- ドリンク一覧は既存`description`を「商品説明／一言コメント」欄から表示する。detail画像がある場合は「タップで明細」と一言コメントを同一行に表示し、画像がない場合はコメントのみとする。長文はコメント側だけを1行省略し、詳細画面では全文を表示する。
- safe-copyの焼酎画像layout混入イベント307–322は履歴を保持したまま、正式APIで対象11商品のlayoutを復旧した。復旧直後のlayoutは10行、event_log最新IDは333。その後、今回のcommit処理とは別の管理操作由来とみられる`menu.updated` 4件（334: 黒霧島、335: 黒霧島、336: W、337: 茶豆）がread-only確認で見つかり、現在のevent_log最新IDは337。layoutは10行のまま。
- safe-copy最終確認: schema v8、menu_items 90、normal 88、reservation_only 2、orders 20、order_items 33、table_sessions 6、event_log 333、integrity_check `ok`、foreign key違反0件。PID 12752は稼働継続中。
- 検証: prototype 101/101、server 379/379、Sites 4/4、Vite build、`git diff --check`。
- A90は過去の客席レイアウト受入記録ではALL PASS。ただし今回の予約限定表示・ドリンク一言コメント追加後のA90実画面再読込は、この環境で操作対象ブラウザが取得できず未確認。今回の追加分をALL PASSとは記録しない。
- production DB、pairing、注文送信、push/pull/merge/rebaseは未実施。`prototype/CONTEXT.md`、既存未追跡ファイル、safe-copy DB／WAL／SHM、DBバックアップ、runtime-state.json、QA画像、ログ、build生成物はcommit対象外とした。

### 未完了タスク

1. フード料理説明＋サムネイル対応レイアウト
2. 半身焼きを名物へ移すか決定
3. runtime-state.json権限エラー
4. production環境の特定・反映

## 2026-09-18 客席下部レイアウト診断・最小修正 checkpoint（A90受入ALL PASS）

実際のリポジトリ状態を優先して現況を整理した。branchは`feature/sqlite-foundation`、開始時HEADは`f1083b5d3f14daa94e0dbc4e40c5f9946d1c48bf`、実装commitは`42633a9`。開始時のtracked差分は`prototype/CONTEXT.md`のみで、既存未追跡ファイルは変更・整理していない。今回の実装差分は`prototype/src/App.jsx`、`prototype/src/styles.css`、および新しいgrid行を確認する`prototype/tests/customer-ui.test.mjs`である。

- 客席mainのgrid行を、通知なし時は`header / minmax(0, 1fr) / footer`、通知あり時だけ通知行を含む構成へ整理した。footerは実際の最小高さに追従する`auto`行とし、商品一覧と注文内容パネルの既存flex／`min-height: 0`／内部スクロールを維持した。
- 1280×800の隔離pairing環境で、予約限定（2行）と焼酎（13行）、左レール開閉の4条件を修正後に確認した。全条件でfooterとINFORMATION上罫線はtop 760.007 / bottom 800.000付近、document/bodyはscrollHeight 800・scrollWidth 1280。長い一覧のみ`.menu-list`が内部スクロールし、焼酎はscrollHeight 1541、clientHeight 627（レール閉）/541（レール開）だった。
- 修正後の注文内容パネルは、予約限定でtop 13.988 / bottom 748.016（レール閉）、top 99.988 / bottom 748.016（レール開）。焼酎でも同じ利用可能領域に伸び、確定ボタンはtop 675.236 / bottom 733.234に配置された。商品行の高さ・位置・間隔、商品・カテゴリー・予約限定仕様は変更していない。
- INFORMATIONは画面下端へ配置し、注文内容パネルは利用可能高さまで拡張した。長い一覧は商品領域内だけをスクロールさせた。A90実機で客席レイアウトをALL PASSとして受入確認した。
- 白画面の原因はsafe-copyサーバー停止であり、今回のUI修正が原因ではない。正式safe-copyをPID `11424`で復旧し、production DBへは反映していない。
- 隔離DBは`server/var/safe-copies/isolated-layout-preview-20260918-155802/preview.sqlite3`へ物理複製し、正式管理画面のpairing／claimだけを実施した。pairing後は隔離DBのdevicesのみ11→12、categories 16、menu_items 88、orders 20、order_items 33、table_sessions 6、event_log 298、integrity_check `ok`、foreign_key違反0件。隔離サーバー・一時web root・ブラウザプロファイルは停止・削除済み。
- live safe-copyは開始・終了でmain `AA57F8FE96170DAF5D8C6882FE614C67FE8D891266A52D6AEFD5A904035C7AE4`、WAL `7C2B66843809F3648EDA425AA13AAF2F80A3ADF681BFEF0B8D793055C2C808DC`、SHM `4A59806F5805BF7B2412C77467E8A86FD037173A20BCA4ED4D0EA167082C7123`が一致した。live件数はcategories 16、menu_items 88、orders 20、order_items 33、table_sessions 6、event_log 298、integrity_check `ok`、foreign_key違反0件で不変。live safe-copyのhealth待受は開始・終了とも確認していない。
- 検証はSites 4/4、注文outbox 24/24、Vite build（4581 modules）、`git diff --check`、修正後console error/warning 0件。修正前後の予約限定・焼酎、左レール開閉のスクリーンショットを取得した。
- 今回変更していない範囲: `prototype/CONTEXT.md`、既存未追跡ファイル、DB／API／schema、live safe-copy／production DB、商品・カテゴリー・並び順、半身焼き・ホールの予約限定仕様、pairing以外の注文処理、A90実装、push/pull/merge/rebase。
- 次回タスク:
  1. 半身焼き・ホールの商品単位の予約限定／注文不可
  2. 半身焼きを名物へ移すか決定

最終更新: 2026-09-18
対象: `C:\Users\user\Documents\ChatGPT\タブレットオーダーシステム`

## 2026-09-16 カテゴリー管理・商品並び順 checkpoint

schema v7 migration、カテゴリー管理、商品並び順保存、客席カテゴリー動的生成、および左レール開閉時のカテゴリー文字サイズ調整を実装した。実装commitは`304054a`（`feat: add category and menu ordering controls`）。

- 管理画面で中カテゴリーの追加・編集、所属レール、表示状態、表示順の変更と、カテゴリー内商品のドラッグ・上下ボタンによる並び替えが可能になった。左赤レールはドリンク、フード、冬季限定、季節・気まぐれの固定構成を維持する。
- 串カツはDB上で1商品＋4variantを維持し、客席側の4仮想行表示を保つ。カテゴリー間の商品移動、カテゴリー削除、左赤レール管理は対象外とした。
- 「すぐ出る・冷菜」はsafe-copyの正式管理API経由で「とりあえず」へ復元し、管理画面・客席データの取得値で確認した。商品所属と並び順は変更していない。
- 左レール閉鎖時の中カテゴリー文字サイズは20px、展開時は18pxとし、ボタン寸法・折り返し・paddingを維持した。
- safe-copyでカテゴリーと商品の保存・再読込・元順番への復元を確認済み。注文・セッションは変更していない。production DBへは反映していない。
- 最終検証: prototype 99/99、server 374/374、Sites 4/4、Vite build、`git diff --check`。A90での今回の最終客席確認は未実施。
- 食事メニュー記載価格は概算であり、正式価格は未確定。
- 次回タスク:
  1. INFORMATION領域を画面下部へ配置
  2. 注文内容パネルを下端まで伸ばす
  3. 半身焼き・ホールを商品単位の予約限定・注文不可にする
  4. 半身焼きを名物へ移すか決定
  5. production環境の正式特定と反映

## 2026-09-16 管理画面フード商品編集永続化 checkpoint

管理画面の商品編集永続化と、食事商品への日本酒variant欄誤表示修正を受入済みとした。実装commitは`0db3eae`（`feat: persist food menu admin edits`）。

- 認証済み正式管理画面（safe-copy）で、茶豆説明の一時保存・通常再読込保持・正式APIによる元値復元を確認した。
- 串カツ塩レモン税込価格の181円一時保存・通常再読込保持・客席データ反映・正式APIによる180円復元を確認した。
- 串カツ4variantのIDは不変。商品画像URIとimage layoutは不変。
- 食事variantを持たない食事商品では日本酒variant編集欄を表示しない。黒焼きは小・中・大、串カツは塩レモン・ソース・おろしポン酢・味噌を編集できる。
- 保存成功後は管理APIの正式データとversionを再取得して画面stateを更新する。保存中の二重送信を防止し、API失敗・競合時は成功扱いにしない。
- safe-copy最終値: `orders=20`、`order_items=33`、`table_sessions=6`、`event_log=291`、`integrity_check=ok`、`foreign_key_check=0`。
- 正式価格は未確定で、production DBへ反映していない。production DB、pairing、注文送信は未操作。
- 最終検証: customer-ui 40/40、prototype 97/97、server 371/371、Vite build、`git diff --check`。正式管理画面の最終再読込も正常表示を確認した。
- 次工程は商品ドラッグ並び替えと中カテゴリー追加・編集。

## 食事メニュー最小実装・串カツUI acceptance checkpoint

食事メニュー最小実装と串カツUIの受入をA90実機でALL PASSとした。実装commitは`277a023`（`feat: add food menu customer flow`）。

- 食事45商品と、フード、名物、冬季限定、季節・気まぐれを含むカテゴリー構成をsafe-copyへ反映した。名物は左レールではなくフード内中カテゴリーとして表示する。
- 「とりあえず」、鶏料理、串カツ・揚げ物、岐阜の味、鉄板・一品、名物、予約限定をフード内に表示する。
- 冬季限定は常時表示し、冬季外も閲覧可能だが注文確定不可とする。自動日付判定、季節DB項目、管理画面一括切替は未実装で、当面は手動運用とする。
- 茶豆は「とりあえず」、若鳥のケイチャン焼は「岐阜の味」に配置した。
- 名物ひね鶏黒焼きは既存variant構造でサイズvariantを使用する。
- 串カツは1商品＋4variant（塩レモン、ソース、おろしポン酢、味噌）を維持し、客席一覧では4仮想行として表示する。各variantは2本以上とし、server側でも1種類2本未満を拒否する。
- 串カツ本数モーダルはvariantを変更せず、選択中の味、税込単価、各種2本から、本数操作、味名なしの数量CTAを表示する。A90で実画面の表示・操作・レイアウトを受入済みとする。
- 画像あり商品のみ詳細表示を有効にし、画像なし商品では詳細誘導を表示しない。
- 記載価格は画面確認用の概算であり、正式価格は未確定。正式価格として扱わず、production DBへ反映していない。今回の反映先はsafe-copyのみ。
- 最終検証: customer-ui 40/40、prototype 97/97、server 371/371、Vite build（4581 modules）、`git diff --check`。safe-copyはorders=20、order_items=33、table_sessions=6、`integrity_check=ok`、foreign key違反0件。
- production DB、schema migration、画像、pairing、注文送信は今回変更・実施していない。
- 次工程は正式価格・商品画像の確定と、管理画面からの季節商品の販売可否切替である。

## 2026-09-15 画像角度調整・房島屋透過PNG checkpoint

画像構図エディターの角度調整を復旧し、Escapeを保存なしのキャンセル経路として追加した。角度復旧とEscape対応は `6abb6f6`（`fix: restore image-only rotation controls`）へ確定した。

- thumbnail／detailを独立して編集できる。
- frameは固定し、contain／cover、position、scale、ドラッグ、1px／5px微調整、reset、save、cancelを維持した。
- 回転transformは内側の画像要素だけへ適用し、透過PNGでは瓶だけが回転する。frame、背景、モーダル、商品情報、操作欄は回転しない。
- Escapeはキャンセル扱いで、保存APIを呼ばずDBを更新しない。listenerはエディター終了時に解除する。
- 背景込みJPEGでは写真の矩形外周も回転して見えるため、回転を使う商品は透過PNGを推奨する。

房島屋 `sake-fusashimaya` について、元写真品質に由来する限界を踏まえて透過PNG方式を暫定受入とした。透過PNG方式、枠固定、瓶だけの回転は技術的PASS。後から管理画面で位置・大きさ・角度を調整できる。正式画像追加は `cb1d790`（`feat: add transparent Fusashimaya menu images`）へ確定した。

- detail画像: `prototype/public/menu-images/sake/sake-fusashimaya-detail.png`（760×1320、RGBA PNG、SHA-256 `86BC04F49DDEAB9051A128F8EE0726C9A60CAF3132264621F221366224C37D1C`）。
- thumbnail画像: `prototype/public/menu-images/sake/sake-fusashimaya-thumb.png`（560×560、RGBA PNG、SHA-256 `79F34621B8441CA95C22F10273D21A0C68E05051AB15BA552BDDD441C73397E8`）。
- 旧房島屋JPEGは保全し、原本PNGはGitへ追加していない。
- safe-copyでは房島屋のimage URIをthumbnail PNG、detail URIをdetail PNGへ更新済み。現在のread-only確認ではthumbnail `contain / scale 2.02 / X 0.0226688233 / Y -0.2223721706 / rotation 0.4`、detail `contain / scale 1.05 / X -0.1615159379 / Y 0.0156621089 / rotation 0`。今回のcheckpoint commit中にDBは変更していない。
- safe-copyはhealth `ready`／`db=ready`／schema v6、`integrity_check=ok`、foreign key違反0件。注文20、order_items 33、table_sessions 6。production DBは未変更。
- A90実機では房島屋を目視し、元写真品質を踏まえて暫定受入とした。残り3商品の透過PNG展開は後続記録へ更新した。
- prototype 94/94 PASS、Vite build PASS、`git diff --check` PASS。

今回、残り3商品（W・醴泉・三千盛）についても、元PNGの実画素を用いた決定的なalphaマスク処理と規格化を行い、透過PNG方式を正式採用した。4商品すべてで透過PNG方式、枠固定、瓶だけの回転を受入対象とする。A90では日本酒4商品の表示をユーザー目視でALL PASSとした。元写真品質に由来する限界は残るが、位置・大きさ・角度は管理画面から後調整できる。

- W: `prototype/public/menu-images/sake/sake-w-detail.png`（760×1320、RGBA PNG、SHA-256 `CBF87FC94093CB83CA936A35EA199E8F5F075EB9314830828DC0298E503B2972`）、`prototype/public/menu-images/sake/sake-w-thumb.png`（560×560、RGBA PNG、SHA-256 `56425873702519B03BB9563A3BD497A6BD3820BAFE66A88963B2777E4AE68674`）。
- 醴泉: `prototype/public/menu-images/sake/sake-reisen-detail.png`（760×1320、RGBA PNG、SHA-256 `2A0454A4C37534AABE86ADCF7987B0FC9A46ECC5381C1CC0ECE9E3E698FFDBC4`）、`prototype/public/menu-images/sake/sake-reisen-thumb.png`（560×560、RGBA PNG、SHA-256 `EBA4DD94CEF606BAFE0E6FD7D24D7513E340E1803D7A5330034A0752530AE246`）。
- 三千盛: `prototype/public/menu-images/sake/sake-sanshimori-detail.png`（760×1320、RGBA PNG、SHA-256 `CCFDEA3F650E04422D4AF3F39EF908F8C748107137619A3F421E2E73F36063F5`）、`prototype/public/menu-images/sake/sake-sanshimori-thumb.png`（560×560、RGBA PNG、SHA-256 `481EB83FD5E39D2E3D8878A2CC409459A563B244374CCB0422F096530E0DC1BC`）。
- safe-copyでは3商品のthumbnail/detail URIを上記PNGへ反映し、thumbnail/detailとも `contain / scale 1 / X 0 / Y 0 / rotation 0` とした。房島屋、注文、セッション、他商品は変更していない。反映後はsafe-copy `event_log=217`、`orders=20`、`order_items=33`、`table_sessions=6`、`integrity_check=ok`、foreign key違反0件、schema v6を確認した。
- production DBは未反映。A90のpairing・注文操作は行っていない。
- prototype 94/94 PASS、Vite build PASS、`git diff --check` PASS。

### 未完了タスク

- 左赤レール画像のアップロード・位置・大きさ調整機能。
- 左赤レールの制作ガイド表示。
- 管理画面の商品カテゴリー横並び・商品行コンパクト化。
- 食事メニュー登録用Markdownは未作成。
- 実フード商品での画像エディター確認。
- production環境の正式確定。
- `/admin`から正式管理URLへのredirectと起動ショートカット整備。

## 2026-09-15 rotation一時無効化 checkpoint（履歴）

画像構図エディターの未解決回転表示問題を切り離すため、rotation操作を一時無効化し、Commit 1 `76f1208`（`fix: temporarily disable image rotation`）へ確定した。

- 角度スライダー、角度表示、±0.1°／±1°操作は画面から非表示とした。
- 保存済みのrotation値は保持し、画像描画時にはrotationを適用しない。
- position、scale、contain、cover、ドラッグ、微調整、reset、save、cancel、thumbnail／detail独立設定は維持した。
- schema v6とAPIのrotation項目は互換性のため維持し、DB内のrotation値は変更していない。
- prototype 94/94 PASS、Vite build PASS。production DB／safe-copy DBは未変更。
- 角度調整の正しい再実装は後続タスクとする。

後続の「画像角度調整・房島屋透過PNG checkpoint」で、角度調整復旧、透過PNG方式、受入結果、現在の未完了タスクを更新した。

## 2026-09-14 共通画像構図エディター checkpoint

共通画像構図エディターを `cb6008d`（`feat: add menu image layout editor`）へ確定した。対象は商品カテゴリではなく、全メニュー商品の画像用途 `thumbnail`／`detail` である。

- schema v6で `menu_item_image_layouts` を追加。元画像、既存商品データ、注文データは変更しない。
- thumbnail／detailを独立して保存し、`contain`／`cover`／手動調整を選択できる。
- 手動調整はドラッグ（Pointer Events）、ホイールズーム、ズームスライダー、回転スライダー、1px／5px相当の位置微調整、0.1度／1度の回転微調整、リセット、保存、キャンセルに対応する。
- positionは表示枠に対する正規化値で保存し、画像の縦横比を維持する。未設定商品は従来表示を維持する。
- 管理APIは `PUT /v1/admin/catalog/menu-item/image-layouts`。管理認証、数値範囲検証、競合検出、トランザクション保存を行う。
- 1313×820の管理画面で、モーダル内スクロールとsticky操作部により保存・キャンセル・リセットへ到達できることを確認した。
- safe-copyの `sake-reisen` 設定：thumbnailは `scale 1.65 / positionX 0 / positionY -0.12 / rotation 0 / fit contain`。detailは既定値（`1 / 0 / 0 / 0 / contain`）。production DBは変更していない。
- safe-copyはschema v6、`integrity_check=ok`、`foreign_key_check=0`。注文20、注文項目33、セッション6を確認した。
- prototype 93/93 PASS、server 370/370 PASS、Vite build PASS、`git diff --check` PASS。
- フード実商品での視覚確認は保留。safe-copyにフードカテゴリ／商品が存在しないため、仮商品・仮データは作成していない。最初のフード登録時に確認する。
- A90実機、pairing、注文送信、APK、production DB、画像加工は実施していない。
- Commit 1から画像、QAスクリーンショット、safe-copy DB、backup DB、ログ、node_modules、pnpm-lock、旧試行スクリプト、既存未追跡ファイルを除外した。

## 2026-09-13 seasonal customer rail theme checkpoint

- `standard`は従来の無地赤背景、`camellia`は展開時だけ完成PNGを1枚表示するテーマ基盤を実装した。
- 収納時は既存の`customer-app--category-collapsed`で椿画像を非表示にし、`background-image: none`と`var(--red)`へ戻す。再展開時は1枚だけ復帰する。
- 完成画像は`prototype/public/customer-rail-washi-camellia-accepted.png`（426x1587）。椿2組、開花2輪、つぼみ2輪。途中画像は未追跡のまま保全している。
- ユーザー目視受入: 展開、収納、再展開、操作性、レイアウトはPASS。
- prototype全体テスト93/93 PASS、Vite build PASS、`git diff --check` PASS。
- A90、pairing、注文、DB、server、Android release基盤は変更していない。
- code checkpoint: `23c7caf`（`feat: add seasonal customer rail themes`）。

## 2026-09-12 A90 release PIN acceptance checkpoint（現行正本）

A90の正式release版更新とスタッフPIN解除の実機受入を完了扱いとする。生成済みrelease APKを再ビルドせず、同一正式署名で`adb install -r`を1回実行し、pairing、PIN、アプリデータを保持した。

- A90正式release版: versionCode `3` / versionName `1.0.1`
- APK SHA-256: `2abbf57a30d2b4ebd32de9e0fb27bb935d6accdcff6e7dea8b1cb6ecd678f9c2`
- 署名証明書SHA-256: `d700b5187985bc025914481fd9d278921afcf372ae0494530a993423f75fe46a`
- `debuggable=false`
- 同一正式署名による`adb install -r`: 成功
- pairing、PIN、アプリデータ: 保持
- table 1客席メニュー表示: 成功
- PIN設定画面終了後の不要なWebView再読み込みを抑止する修正を反映し、黒画面の再発なし
- 7回タップ＋4桁PIN解除: ユーザー確認PASS
- PIN解除後のHOME復帰、通常起動、再pairingなしのtable 1復帰: PASS
- 白画面、黒画面、再試行画面、debug overlay: なし
- safe-copy health: localhost／LANともHTTP 200、`ready`、`db=ready`、schema v5
- DB件数: `orders=20`、`order_items=33`、`event_log=162`、`menu_items=43`、`table_sessions=6`
- `integrity_check`: `ok`
- foreign key違反: 0件
- 注文操作・送信: なし

## 2026-09-12 signed kiosk release build checkpoint（履歴）

release build基盤を `d0a2d4f`（`feat: add production kiosk release builder`）へ確定した。生成済みrelease APKは再ビルドせず、署名・artifact情報を検証した。

- applicationId: `jp.co.warun.androidkiosk`
- versionCode / versionName: `2` / `1.0.0`
- debuggable: `false`
- release APK SHA-256: `3064dacca008a9557c1c6788b8b093d0094f1d70115fd38566340ad8f3902ca2`
- release署名証明書 SHA-256: `d700b5187985bc025914481fd9d278921afcf372ae0494530a993423f75fe46a`
- release keystore SHA-256: `7895c7886e3cd4177eb8e83f9b70c2f3560644375129603b2508780315b4fa5d`
- release APKはA90へ未導入。A90は現在debug署名版で稼働している。
- debug版からrelease版へ移行する際は署名不一致となるため、管理された再pairingが必要になる。
- 次の必須作業はrelease keystoreの別媒体バックアップである。バックアップ完了まではA90へrelease APKを導入しない。
- keystoreとpasswordはGit管理しない。APK、実行可能JAR、class、build output、readiness markerもcommit対象外とする。
- release builder GUIはpasswordなしの既存APK検証に対応し、検証時は起動中Javaの`java.home`から`JAVA_HOME`を設定する。password欄は成功・失敗・終了時に消去する。

## 2026-09-09 A90 Android kiosk checkpoint（現行正本）

Androidキオスク基盤の実装commitは `5921539`（`feat: add A90 WebView kiosk foundation`）。この後の文書更新commitは別のHEADを作るため、Android実装の基準はこのcommitとする。

- branch: `feature/sqlite-foundation`
- Android実装checkpoint: `5921539`
- A90実viewport: `1313x820 CSS px`
- Android側は横画面固定、immersive表示のWebViewキオスク。Browser Fullscreen APIは使用しない。
- WebViewの固定originはsafe-copyの `http://192.168.11.6:25173`。JavaScript／DOM Storageを有効化し、WebViewデータは保持する。
- pairing URL policyは、固定scheme／host／port／path、userInfo・query拒否、pairing fragment形式検証、不正URLの客席URLfallback、Intent dataの秘密値除去を実装している。
- A90カメラからandroid-kioskが起動する実機確認はPASS。User 0の`192.168.11.6` host選択は`Enabled`。
- fragmentなしの秘密値なしQRで端末登録画面への安全なfallbackを確認済み。実pairingの導線は下記の管理された再pairing checkpointで確認した。
- renderer障害と表示速度の過去事象は現在再現なし。初回表示は約770ms、HOME復帰は約248〜278ms。`process is bad`、renderer crash、安全な再試行画面、watchdog再生成は確認なし。
- 専用QRスキャナーは現時点で不要。標準QRカメラのVIEW Intentからandroid-kioskへ渡る導線を確認済み。
- 必須リリースブロッカー: `キオスク緊急解除.cmd`。
- Lock task mode、隠しタップ＋PIN、自動起動は未実装。
- A90のhost選択Enabledを、将来の初期設定手順または`cmd`へ組み込む必要がある。

### Android checkpoint検証

- `assembleDebug`: PASS。
- `lintDebug`: PASS。
- `PairingUrlPolicyTest`: 4 cases PASS。
- debug正常終了ACTION、計測表示、console診断、native HTTP probeは`BuildConfig.DEBUG`および明示debug指定でのみ有効。release通常起動では有効にならない。
- pairing URLのfragment、pairing code、token、cookie、credential、device固有値はログ・overlayへ出さない。ログURLはquery／fragment除去済み。
- APK、`build/`、`.gradle/`、`local.properties`はcommit対象外。

### Git状態

- Android実装commit直後のHEAD: `5921539`。
- 文書更新commitは `docs: record A90 kiosk checkpoint` として別commitにする。
- 文書commit後はstaged差分なし、tracked差分なし、未追跡は`.codex-worktrees/`と`docs/isami-dedup-import.md`のみとする。
- `.codex-worktrees/`、`docs/isami-dedup-import.md`は変更・stage対象外。

## 2026-09-09 A90 managed pairing checkpoint（現行正本）

固定origin `http://192.168.11.6:25173` のsafe-copyで、table 1をChromeからA90のandroid-kioskへ管理された再pairingで移行した。

- A90前面package: `jp.co.warun.androidkiosk`
- table 1の客席メニュー表示: 成功
- 新customer device: `active`、table 1へ割当済み
- 旧Chrome device: `revoked`
- 重複割当: 0
- pairing QR: 1件のみ発行・使用済み。pairing code、QR payload、token、device IDは記録していない。
- 保護対象件数: `orders=17`、`order_items=30`、`event_log=147`、`menu_items=43`、`table_sessions=4`
- safe-copy health: localhost／LANともHTTP 200、`ready`、`db=ready`、schema v5
- renderer異常: `process is bad`、renderer crash、`renderProcessGone`なし
- `/v1/menu`: 客席メニューの実画面表示による間接確認。直接のHTTP 200ログは未取得。
- 事前バックアップ: `server/var/safe-copies/backups/initial-menu-20260818-before-table1-android-kiosk-20260909-200914027.sqlite3`
- 事前バックアップSHA-256: `8279c46e48d095d501347587db8fba5c61a4d9f3c11fac73011ea987f9854a25`
- 次のタスク: A90 WebView上での客席UI受入確認
- 未実装: Lock task、隠しタップ＋PIN、`キオスク緊急解除.cmd`、自動起動

## 2026-09-09 A90 customer UI acceptance checkpoint（現行正本）

A90 WebView実機でtable 1の認証済み客席UIを受入確認し、確認された2点を実装commit `9f33def7d3ab9cdac3887a2ee7fb5737749e5b79`（`fix: finalize A90 customer menu layout`）へ確定した。Androidキオスク、server、DB、pairing、注文送信は変更していない。

- A90前面: `jp.co.warun.androidkiosk`
- table 1客席メニュー: 表示成功
- 実viewport: `1313x820 CSS px`
- 横画面固定、immersive WebView、Android system bar非表示、debug overlay非表示
- 初期画面: 左レール、営業時間・下枠、上部共通操作、table 1、8カテゴリー、空の注文内容、footer、画面端の収まりを確認
- ビール画面の「酒類選択に戻る」: 8カテゴリーへ正式復帰。実装スタブ・alert・仮画面なし
- 焼酎画面: 芋／麦・その他切替、商品一覧、商品詳細、飲み方選択を確認
- 黒霧島の飲み方モーダル: 商品名は横一行で表示され、数量操作・飲み方ボタン・閉じる操作を確認
- 商品一覧スクロール: 商品一覧のみがスクロールし、画面全体・上部共通操作・注文領域は固定
- 商品追加・削除: 複数商品を注文内容へ追加し、`×`で1点ずつ削除。注文確定・送信は未実施
- 未確認事項: 注文一覧は11行が画面内に収まり、注文一覧単独スクロールは未発生
- DB確認件数: `orders=17`、`order_items=30`、`event_log=147`、`menu_items=43`、`table_sessions=4`。UI確認前後で不変
- safe-copy health: localhost／LANともHTTP 200、`ready`、`db=ready`、schema v5

### A90 customer UI checkpoint検証

- 関連UIテスト: 34/34 PASS
- prototype全体テスト: 91/91 PASS
- Direct Vite build: 4580 modules transformed、PASS
- local distとsafe-copy HTTP配信HTML／主要assetの一致: PASS
- `git diff --check`: whitespace errorなし。既存のLF/CRLF変換警告のみ
- Android APK再インストール、app data削除、OS再起動、DB操作、pairing操作、注文送信は実施していない
- 次の確認候補: 注文一覧が画面内に収まらない件数で、注文一覧単独スクロールを追加確認する

## 2026-08-30 customer UI code checkpoint

本セクションを現行正本とする。実装commit（code checkpoint）は `c085b29fd80342e074b1dc94abcd702d177900e5`（`feat: refine customer menu interactions`）。この後の文書更新commitは別のHEADを作るため、実装状態の基準としてはこのcode checkpointを使用する。

- branch: `feature/sqlite-foundation`
- code checkpoint HEAD: `c085b29fd80342e074b1dc94abcd702d177900e5`
- code checkpointのtracked差分: なし
- code checkpoint直後の未追跡: `.codex-worktrees/`、`docs/isami-dedup-import.md`（保持、stage対象外）
- 実装対象は `prototype/src/App.jsx`、`prototype/src/styles.css`、`prototype/tests/customer-ui.test.mjs` の3ファイルのみ。
- メニュー閲覧・スクロール中の上部共通操作行を収納し、Grid行を縮めてメニュー領域を上へ拡張。約5秒無操作で復帰する。
- `ドリンク＞○○`の下段を削除し、選択中カテゴリのパンくずを表示。「酒類選択に戻る」は右端へ配置し、太枠・淡色・44pxタップ領域とした。
- ドリンク先頭カテゴリーを「おかわり！」へ変更し、現在の客席の直近ドリンク注文を重複なし・新しい順で表示する。
- 注文内容内の×ボタンは商品行全削除ではなく、数量を1点ずつ減らす。
- 左赤レール展開時の旧ロゴ・縦書き説明を削除し、「IZAKAYA WARUN」「お品書き」を横書き2行で表示。お品書きは拡大し全体を約5px上へ移動した。
- footerのアレルギー案内を削除し、「店内禁煙」を「全席喫煙可能」へ変更。INFORMATION本文は専用定数で後から変更可能とした。
- Fullscreen API、Fullscreenボタン、Fullscreen専用CSS・テストは撤回済み。通常Chrome表示を現在の基準とする。失敗したFullscreen専用2段Grid方式は再採用しない。
- カテゴリー折り畳み、左大分類レールの中央メニュータップ折り畳み、商品・注文一覧の内部スクロール、注文・価格・飲み方選択、DB、server、pairing、network、画像資産は維持・変更していない。

### 検証

- 関連UIテスト: 34/34 PASS。
- prototype全体テスト: 91/91 PASS。
- Direct Vite build: 4580 modules transformed、PASS。
- `git diff --check`: whitespace errorなし。既存のLF/CRLF変換警告のみ。

### 物理A90の確認状況

- ユーザー実機報告で、通常Chrome表示では新CSSの反映、注文内容右端・全画面ボタン・テーブル番号の概ねの収まり、横スクロールなし、画面全体非スクロール、商品一覧・注文一覧のみの内部スクロール、footer下端表示を確認済み。
- 通常Chrome表示のfooter実寸、左レール下部の完全表示、現在の「おかわり！」表示、直近ドリンク注文の反映、数量1点ずつ取り消し、メニュー閲覧中の5秒収納、左レールの新ブランド表示は物理A90未確認。
- Fullscreen表示は過去に複数回FAILとなり、Fullscreen機能自体を撤回済み。Fullscreenの受入PASSとは扱わない。

### 次回作業

最初のタスクは、最小Android WebViewキオスク基盤を作成し、A90実機のviewportを測定する。その後、注文内容の大型確認画面と1点ずつ削除操作を確認する。

## 2026-08-29 checkpoint時点の現行正本

- branch: `feature/sqlite-foundation`
- HEAD: `573370ad2e4c217d53991d5e0f5c9e3e1992d9e0`
- 固定origin: `http://192.168.11.6:25173`
- safe-copy DB: `server/var/safe-copies/initial-menu-20260818.sqlite3`
- 物理A90の商品詳細モーダルはユーザー確認でALL PASS。横画面の画像列38%、column-gap 20px、`object-fit: contain`、`object-position: left bottom`、footer、48pxボタン、スクロール条件を確認済み。一覧復帰、「これにする」、飲み方選択、カート追加も維持した。
- `layout-debug`のquery判定・診断パネル・診断専用CSS・診断専用テスト、およびcredential／deviceIdの画面診断は削除済み。server側のGET `/v1/menu`診断は秘密値を記録しないmetadata限定でsafe-copy明示時だけ有効化する。
- 全12商品の元写真から、既存の非生成処理で傾きだけを再補正した。detail v1（760×1320）、thumb v1（560×560）、thumb v2（560×700）を各12枚、形式・ファイル名・stable_id・画像URIは維持し、商品情報・DBは変更していない。
- safe-copyの注文・履歴・商品データは変更していない。pairing code、QR payload、token、token hash、DBバックアップ、runtime-state、通信ログ、一時比較出力、`.codex-worktrees/`、無関係な未追跡ファイルはcommit対象外。
- 下記の旧セクションは経緯・履歴であり、現行値の判断には本セクションを優先する。旧originの記録は履歴として保持する。

### checkpoint検証

- 関連UI 26/26、prototype全体83/83、server全体370/370、Sites worker 4/4、Direct Vite build（4580 modules）をPASS。`git diff --check`もwhitespace errorなし。
- 画像36枚の寸法・形式・ファイル名、source／documentの参照24件、機密情報パターンを確認し、画像不整合・参照切れ・文書への秘密値混入は0件。
- local distとsafe-copy HTTP配信のasset SHA-256は3件、画像SHA-256は36件すべて一致。localhost／LAN healthはHTTP 200、`ready`、`db=ready`、schema v5。environment／database targetはruntime-stateでsafe-copyを確認した。
- read-only確認で実listener PID 15312と既存runtime-stateのprocessId 20180が不一致だった。runtime-stateは変更せずcommit対象外とし、次回のsafe-copy正式起動経路確認時に解消する残余リスクとして扱う。
- 商品詳細の読み仮名をモーダルタイトル横へ移動する改善をcommit `573370a`（`fix: move product reading beside modal title`）として確定した。

### 次の未完了タスク

- 焼酎の所属・並び順を確認した後、8カテゴリー折りたたみと「芋／麦・その他」固定ナビを実装する。

## 2026-08-28 認証復旧待ちの引き継ぎ

- A90の `GET /v1/menu` は Authorization header ありで HTTP 401。A90側には失効済みcredentialが残っている。
- A90 device `5689eac1-44fd-492e-a330-1e62fe4bbeea` は `revoked`。table 1は active device `2fdc8d15-a965-4de1-9c72-352f845e0650` に割当済み。
- 現行safe-copyには menu 43件、orders 14件、order_items 23件が残っている。
- 古いsnapshotへのrollbackやGitHub pullでは、この認証問題は解決しない。
- PCのLAN originはDHCP手動割当で `http://192.168.11.6:25173` に固定済み。固定確認後にのみ正式フローのcontrolled re-pairingを行う。
- 固定前は現行safe-copyで失効・pairing・QR発行を行わない。
- UI詳細画像調整は、通信・認証の復旧条件を満たした後、物理A90で再開する。
- A90実機UI確認は、固定originの確定、管理された再pairing、`GET /v1/menu` HTTP 200確認が完了するまでBLOCKEDとする。
- 次回の最初の作業は通信再発防止の設計整理とし、いきなり実装しない。
- 本日は実装・失効・pairing・QR発行を行わず終了する。

## Git状態

- branch: `feature/sqlite-foundation`
- HEAD: `573370ad2e4c217d53991d5e0f5c9e3e1992d9e0`
- staged差分: なし
- tracked変更: なし
- 未追跡: `.codex-worktrees/`、`docs/isami-dedup-import.md`
- 未追跡ファイルは保持し、stageしていない。
- `dist`、DB、バックアップ、ログ、runtime-state、token、元写真はcommit対象にしていない。

## 現在の目標

焼酎の所属・並び順を確認したうえで、客席の8カテゴリー折りたたみと「芋／麦・その他」固定ナビを実装する。

## 完了済みの内容

- 商品詳細モーダルをタイトル／本文（画像・商品情報）／footer操作欄の3段構成にした。`min-height: 0`、`100dvh`、本文とfooterの分離、背景ページのスクロール停止を使用している。
- 登録済み`detail.reading`だけをモーダルタイトル横へ表示し、未登録時は表示しない。焼酎の「これにする」は同一商品の飲み方選択を開くだけで、選択確定前にカートへ追加しない。「一覧へ戻る」は選択処理を開始しない。
- portraitでは既存の`transform: scale(1.05)`を維持している。landscapeでは`transform: none`、`object-fit: contain`、`object-position: center`、画像の`max-height: 100%`、48%画像列を使用している。
- A90相当viewport用に、orientation判定が不安定な場合を補う`(min-width: 900px) and (max-height: 800px)`のgeometry fallbackを追加した。高さ701px以上は本文overflowなし、700px以下は本文内スクロールを維持する。画像ファイル、画像URI、商品情報、DB、注文処理は変更していない。
- `?layout-debug=1`のときだけ、viewport（inner／screen／orientation）、画像枠・画像矩形、computed style、overflowを表示する一時診断表示を追加した。token、Cookie、QR本文、pairing code、注文本文は表示しない。

## 主要な決定事項

- 画像ファイルの再加工・差し替え、DB更新、商品情報・価格・stable_id・注文処理の変更は行わない。
- portrait表示、既存の操作PASS、footer、ふりがな、画像の縦横比を維持する。
- 物理A90の実測値を取得できるまで、今回の横画面調整はPASS扱いにしない。
- 一時診断表示は物理A90確認後に削除する。実機確認前のstage・commitは禁止する。

## 変更中のファイル

- `prototype/src/App.jsx`: 商品詳細モーダル既存実装と、`layout-debug`限定の診断表示。
- `prototype/src/styles.css`: 詳細モーダルの横画面ルール、geometry fallback、診断表示のスタイル。
- `prototype/tests/customer-ui.test.mjs`: 詳細モーダル、portrait／landscape、geometry fallback、診断表示の静的回帰確認。
- `DEV_STATE.md`: 本引き継ぎ用の現況整理。
- `prototype/CONTEXT.md`: 既存の未コミット状態を保持。今回変更していない。

## 配信bundleとsafe-copy

- 現在のsafe-copy DB: `server/var/safe-copies/initial-menu-20260818.sqlite3`
- 現在のsafe-copy配信URL: `http://192.168.11.6:25173/customer/customer-01`
- 現在のsafe-copy health: localhost／LANともHTTP 200、`ready`、`db=ready`、schema v5、health PID 20180、環境safe-copy。
- 正式な `server/start-safe-copy.ps1 -NoBrowser` 経路で再起動後、現行LAN URLとruntime-stateを確認した。runtime-stateのLAN IPv4、公開origin、A90 URL、PIDは現行実測値へ更新済み。
- 再build後のindex／main JS／styles JS／CSSは、localと現safe-copy HTTP配信のSHA-256が一致した。現行資産は`main-DdLoaeTk.js`、`styles-Ldb6F2k_.js`、`styles-PHjOmwgx.css`。HTTPは`Cache-Control: no-store`。
- 現safe-copy DBは読み取り専用で`PRAGMA integrity_check=ok`。確認件数はcategories 7、devices 8、menu_items 43、menu_item_details 43、menu_item_variants 12、menu_item_serving_options 56、orders 14、order_items 23、event_log 142、table_sessions 4、tables 4。今回の確認でDBを書き換えていない。

## A90横画面の確認済み範囲

- 現ブラウザのA90相当viewportは`innerWidth=1280`、`innerHeight=721`、`visualViewport.height=720.63`、orientation mediaはlandscape、geometry fallbackはtrueだった。ブラウザ評価環境では`window.screen`が提供されず、screen.width／height／orientation.typeは未確認である。
- 同相当viewportのcomputed styleは、grid `355.593px 375.236px`、画像枠`355.593×571.751px`、実画像`355.593×571.751px`、画像`transform: none`、`object-fit: contain`、`object-position: 50% 50%`、`max-height: 100%`、枠`overflow: hidden`、本文`overflow: hidden`だった。
- 同相当viewportの本文はclientHeight/scrollHeight `574/574`、modalは`701/701`。画像の上下左右は枠内で、footerは`y=653.063`から`711.049`までに収まり、ボタンも画面内だった。
- portrait 800×1280では画像の`scale(1.05)`、画像枠高さ550px、本文552/552を確認した。小さい横画面1280×640では本文内scrollが有効で、画像は`transform: none`、footerは画面内だった。
- これは物理A90ではなく、既存ブラウザのA90相当確認である。物理A90の実URL、実viewport、実screen値、実computed style、表示変更、ボトル上下の欠け、Androidナビゲーションとの重なりは未確認である。ユーザー報告では物理A90横画面の今回変更はNGである。

## 判明した原因と効果がなかった方法

- 確認中にsafe-copyの待受が停止し、正式再起動後に現LAN URLが更新された。旧URLを保持した端末は現safe-copyの最新版bundleを取得できないため、横画面CSSが変わらない状態になる。この配信経路差異は確認済みだが、物理A90が現在どのURLを保持しているかは未確認である。
- current safe-copyの同一URLを再読込したブラウザでは、横画面ルールが実際に適用され、`transform:none`と48%列を確認した。したがって、現safe-copyのCSS後方上書きやlocal/live bundle不一致は確認されていない。
- 以前の`scale(1.08)`はユーザーの物理A90確認でボトル下部が切れるNGとなった。画像自体のscale拡大は採用しない。
- buildだけでは、既に開かれている端末ページのDOM／CSSを更新しない。現行URLでの再表示と一時診断値の取得が必要である。

## 直近の検証結果

- 関連UIテスト: 26/26 PASS。
- prototype全テスト: 83/83 PASS。
- Sites worker: 4/4 PASS。
- Direct Vite build: 4580 modules transformed、成功。
- `git diff --check`: whitespace errorなし。既存のLF/CRLF変換警告のみ。
- serverコードは今回変更していないため、server全テストは今回再実行せず、直近の成功結果を再利用した。
- safe-copy再起動、health、配信bundleのlocal/live SHA-256一致、safe-copy DB読み取り専用integrity_checkを確認した。注文POST、QR発行、pairing操作は行っていない。

## 現在の未完了事項

- 8カテゴリー折りたたみと「芋／麦・その他」固定ナビの実装。
- 実装時も焼酎商品の所属・並び順、既存の注文処理、画像資産、server／DB／networkを変更しない。

## 次回最初に行う具体的な作業

1. 現在の8サブカテゴリー構成と既存の4大分類ナビを照合する。
2. 客席ナビを8カテゴリー折りたたみへ最小変更する。
3. 焼酎一覧の「芋／麦・その他」固定ナビを実装し、既存の所属・並び順を維持する。

## stage・commit保留理由

商品詳細読み仮名移動の実装commitは完了し、tracked差分はない。次回は8カテゴリー折りたたみと焼酎固定ナビに着手する。

## 2026-08-28 safe-copy origin固定・runtime-state更新

- Buffalo WSR-2533DHP3のMANUAL／ROUTER運用とDHCP手動割当により、PCの実測IPv4は`192.168.11.6`、gatewayは`192.168.11.1`。正式safe-copy起動経路でoriginを`http://192.168.11.6:25173`へ更新した。
- `http://127.0.0.1:25173/v1/health`、`http://192.168.11.6:25173/v1/health`はいずれもHTTP 200、`ready`、`db=ready`、schema v5。Web/APIは25173/28787で同一PID 20180が待受している。
- runtime-stateはsafe-copy DB `server/var/safe-copies/initial-menu-20260818.sqlite3`、environment `safe-copy`、databaseTarget `safe-copy`、PID 20180、LAN IPv4 `192.168.11.6`、A90 URL `http://192.168.11.6:25173/customer/customer-01`、pairing URL origin `http://192.168.11.6:25173`を記録している。
- 旧`192.168.1.11`が残った原因は、safe-copy launcherが既存プロセスのhealth／preflight正常時に再起動せず、起動時に生成するruntime-stateを更新しない設計だったため。DHCP変更後に正式launcherでsafe-copyを再起動し、現在値へ更新した。
- `server/start-windows.ps1`の`192.168.1.10`は旧固定IPを検査・URL生成する別のレガシー起動経路であり、今回の正式safe-copy起動経路では使用していない。active runtimeのoriginはruntime-stateとhealthの`192.168.11.6`である。履歴上の旧IPは削除しない。
- read-only確認ではsafe-copy health（localhost／LAN）がHTTP 200、`ready`、`db=ready`、schema v5、integrity_check `ok`、foreign_key_check 0件だった。orders 14、order_items 23、menu_items 43、event_log 142を保持している。
- 物理A90で新originのpairing、`GET /v1/menu` HTTP 200、メニュー・商品画像表示の復旧を確認した。現在は画像サイズ調整前の基準UIであり、次はこの基準を起点に詳細画像のサイズ調整を行う。

## 2026-08-28 table 1再pairing・物理A90メニュー復旧

- 固定origin `http://192.168.11.6:25173` のsafe-copyで、table 1の管理された再pairingを正式フローから1回実施した。table 1は新しいactive customer device 1件に割り当てられ、旧table 1 deviceはrevokedのままである。
- 物理A90では新originのpairing後、`GET /v1/menu` HTTP 200、商品・画像表示の成功を確認した。現在は画像サイズ調整前の基準UIまで復旧した状態である。
- read-only確認時点でhealthはlocalhost／LANともHTTP 200、`ready`、`db=ready`、schema v5、integrity_check `ok`、foreign_key_check 0件。orders 14、order_items 23、menu_items 43、event_log 142を保持している。
- pairing code、QR payload、token、token hashは記録していない。コード、CSS、server、network、Git stage・commitは変更していない。

## 2026-09-11 Windowsキオスク緊急解除ツール実機PASS

- Windowsダブルクリック用のルート直下 `キオスク緊急解除.cmd` を追加した。
- ADBを `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`、続いてPATHから自動探索する。USB ADB／Wireless ADBに対応し、online端末が0台・1台・複数台の場合を安全に分岐する。
- 複数台の場合は自動推測せず番号選択し、以後のADBコマンドへ選択serialを明示する。個人環境固有の絶対パスや固定ADB接続portは含めていない。
- 正常解除は既存の `jp.co.warun.androidkiosk.action.DEBUG_NORMAL_EXIT` を明示componentへ送信し、Activity終了後にAndroid HOMEへ復帰する。
- 正常解除を物理A90（serialは記録しない）で3回確認し、HOMEは `com.android.launcher3` だった。
- 再起動後、再pairingなしでtable 1客席画面へ復帰した。pairing、アプリデータ、注文データは保持されている。
- renderer異常、`process is bad`、`renderProcessGone`、安全な再試行画面は確認されなかった。
- safe-copy healthはlocalhost／LANともHTTP 200、`ready`、`db=ready`、schema v5。DB件数は orders 20、order_items 33、event_log 162、menu_items 43、table_sessions 6で不変、`integrity_check=ok`、foreign key違反0件だった。
- 正常解除が失敗した場合のみ、再試行・強制解除・中止を選択できる。強制解除は明示選択時のみLock Task解除→force-stop→HOMEを実行する分岐であり、今回の実機検証では静的確認のみで未実行。
- 現在はimmersiveキオスクであり、Lock Task導入後に正常／強制解除経路を再受入する必要がある。
- Androidソース、Web UI、server、DB、runtime-state、pairing、device、注文、A90設定は変更していない。
- Gradle wrapperおよびPATH上のGradleがなく、Android build／lint／unit testは今回未実行。ただしCMDのみの変更で、既存APKを用いた実機検証はPASSした。
- 次のタスクは、隠し操作＋PINによる通常解除、その後のLock Task導入。

## 2026-09-11 table 1注文E2E完了

- table 1から黒霧島／水割り／数量1を1回だけ送信し、客席で受付成功を確認した。
- 厨房正式UIで新着受信を確認し、通常操作で提供済み／完了へ移動した。
- 完了履歴への移動と注文保持を確認した。再送信・追加注文・重複はない。
- 完了後の件数は orders 20、order_items 33、event_log 162、menu_items 43、table_sessions 6。
- `PRAGMA integrity_check` は `ok`、foreign key違反は0件。
- localhost／LAN healthはいずれもHTTP 200、`ready`、`db=ready`、schema v5。
- T1/T2のcustomer device割当は変更していない。kitchen deviceは既存のactive credentialを利用した。
- kitchen pairing code発行、再pairing、再割当は行っていない。
- A90の現在の注文経路はT1として正常に動作した。
- 管理画面上で表示名「A90」のT2 deviceは、後続のread-only inventory確認を経て未使用と判定し、2026-09-11に正式管理APIで失効した。
- 事前バックアップは `server/var/safe-copies/backups/initial-menu-20260818-before-kitchen-repair-e2e-20260911170304732.sqlite3`。SHA-256は `A4FD9014E802A19E48EBAB753A0BC60597FAA8F1E7B851020646CF4DCAE20B4E`。
- バックアップはschema v5、integrity_check `ok`、foreign key違反0、基準件数（orders 20、order_items 33、event_log 161、menu_items 43、table_sessions 6）一致を検証済み。バックアップファイル自体はstage・commitしていない。
- 機密情報、device ID、token、credential、pairing code、QR payload、注文ID、session IDは記録していない。

## 2026-09-11 スタッフ用PIN通常解除 実機受入

- 右上テーブル番号領域を5秒以内に7回タップすると、スタッフ用PIN入力画面を表示することを確認した。
- A90上で4桁スタッフPINを入力し、PINはA90内部でランダムsaltとPBKDF2-HMAC-SHA256 hashとして保存した。
- PIN平文はPC、ADB引数、Git、ログへ保存・出力していない。
- `キオスクPIN設定.cmd`はPINを入力させず、A90のネイティブPIN設定画面を開くだけの構成にした。
- `PinSettingsReceiver`とDUMP receiver方式は、実機で設定値を保存できなかったため撤回した。無保護receiverには変更していない。
- PIN設定済みのA90で、7回タップによるPIN画面表示、誤PIN 1回で解除されないこと、正しいPINで正常解除してAndroid HOMEへ復帰することを確認した。
- 通常解除では`force-stop`を使用していない。
- 解除後の通常起動で、再pairingなしにtable 1客席画面へ復帰した。
- renderer異常、白画面、安全な再試行画面は確認されなかった。
- safe-copy healthはlocalhost／LANともHTTP 200、`ready`、`db=ready`、schema v5。DB件数とT1/T2 customer device割当は不変だった。
- Gradle 8.9 Wrapperを追加し、公式distributionのSHA-256を固定した。`testDebugUnitTest`、`assembleDebug`、`lintDebug`、`git diff --check`はPASSした。
- APKは既存app dataとpairingを保持する`adb install -r`を1回実行した。
- 5回失敗・60秒lockoutなどの境界条件はunit testで確認したが、実機では発動させていない。
- 通常スタッフ解除と既存の緊急解除CMDが揃った。現在はimmersive表示で、正式なLock Taskは未導入である。
- 次のタスクはLock Task導入後の通常解除／緊急解除の再受入である。

## 2026-09-11 A90 Lock Task調査と採用方針

- A90はAndroid 14／API 34である。
- device owner、profile owner、active device adminはなく、有効なDPC／EMMもない。
- `jp.co.warun.androidkiosk`はLock Task許可リストに登録されておらず、現在のLock Task stateは`NONE`である。
- 現状のまま正式Lock Taskを導入することはできない。DPC／device owner化には端末初期化を伴う可能性があるため、現在は実施しない。
- 採用方針は、現在のimmersiveキオスクで開発・試験運用を継続することとする。Androidの画面固定も現時点では実施しない。
- 7回タップ＋4桁PINを通常のスタッフ解除として使用し、`キオスク緊急解除.cmd`をADB接続時の障害対応として使用する。
- immersiveは正式Lock Taskではなく、Androidのシステム操作によってHOMEへ抜けられる可能性が残る。
- 注文管理画面からのキオスク解除は、DPCまたは安全な端末制御経路を設計した後へ延期する。
- 正式Lock Taskは、A90を初期化できる時期または次期端末導入時に再検討する。
- 次の開発候補は、端末再起動後のキオスク起動・復帰、server停止・LAN切断時の安全な案内と自動再接続、長時間連続稼働試験、release APK作成と試験運用である。

## 2026-09-11 T2未使用customer device失効

- 現在の物理A90はT1 customer deviceとしてactiveで、T1客席画面と注文機能を維持している。
- 未使用だったT2の表示名「A90」のcustomer device（`ba86c8...b75d10`）を、`POST /v1/admin/devices/revoke`で1回だけ正式に失効した。DB直接更新ではない。
- T2 deviceはactiveからrevokedとなり、T2へのdevice割当は解除された。table 2自体はactiveを維持し、table 2 versionは4から5になった。
- T2はactive sessionなし、注文0件。T1 device（`7b60ef...d89912`）、割当、version 15、active sessionは不変である。
- 将来table 2端末を導入するときは、新しい端末を正式pairingする。
- 確認件数は orders 20、order_items 33、event_log 162、menu_items 43、table_sessions 6。`integrity_check=ok`、foreign key違反0。
- localhost／LAN healthはHTTP 200、`ready`、`db=ready`、schema v5。environment／database targetはsafe-copyである。
- 失効前バックアップは `server/var/safe-copies/backups/initial-menu-20260818-before-revoke-unused-t2-device-20260911-195435450.sqlite3`。SHA-256は `71636A7ACD41396515127A30A3A47DC61BAF8D58B8A9822FB93C0FD9DFE37D49`。
- 現在のcode checkpointは `232ebe8157e2203833f8194929fc5f04457d8a9c`。完全device ID、token、credential、pairing code、PIN、cookieは記録していない。

## 2026-09-14 日本酒4商品正式画像受入

- 日本酒4商品の背景付き実写JPEGを正式画像として追加した。元画像の実画素を使用し、AI加工、背景除去、透過処理は行っていない。
- 正式画像は `prototype/public/menu-images/sake/` に配置した。
  - W（甘口）：`sake-w.jpg`
  - 房島屋：`sake-fusashimaya.jpg`
  - 醴泉：`sake-reisen.jpg`
  - 三千盛：`sake-sanshimori.jpg`
- 一覧は主ラベル中心、詳細は瓶全体を表示する。画像は背景付きJPEG方式で、一覧用・詳細用とも商品ごとの正式JPEGを参照する。
- safe-copyの構図設定は以下のとおり。全商品とも `fit=contain`、`rotation=0`。
  - W thumbnail：`scale=1.65, positionX=0, positionY=-0.20`
  - 房島屋 thumbnail：`scale=1.65, positionX=0, positionY=-0.16`
  - 醴泉 thumbnail：`scale=1.65, positionX=0, positionY=-0.12`
  - 三千盛 thumbnail：`scale=1.65, positionX=0, positionY=-0.24`
  - 全商品の detail：`scale=1, positionX=0, positionY=0`
- 管理画面と客席画面で画像・構図の表示一致を確認した。日本酒一覧4商品、主ラベル中心サムネイル、醴泉詳細はPASS。
- 静的画像追加後は `prototype` で `pnpm run build` を実行する必要がある。Vite buildはPASSした。
- safe-copy schema v6、`integrity_check=ok`、foreign key違反0件。production DBは変更していない。
- production反映、実機A90確認、pairing、注文送信は未実施。
