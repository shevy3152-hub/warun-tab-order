# 開発状態

最終更新: 2026-08-29
対象: `C:\Users\user\Documents\ChatGPT\タブレットオーダーシステム`

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
