# Persistent Context

## Communication diagnostics safe-copy rollout 2026-08-24

- Read-only precheck recorded safe-copy DB `server/var/safe-copies/initial-menu-20260818.sqlite3`, counts `orders=3`, `order_items=6`, `event_log=55`, ports `25173/28787`, PID `11736`, and no production DB use.
- The existing `server/start-safe-copy.ps1` path was used with `-NoBrowser`; the reflected safe-copy PID is `12420`. Health, safe-copy target, schema v4, common Web/API listener PID, health PID, runtime-state PID, admin preflight, and `GET /v1/admin/diagnostics` all passed.
- Post-restart counts remain `3/6/55`. No order POST, QR issuance, pairing claim, disconnect, production DB, existing device, or order data was changed. Admin HTML returned HTTP 200 and contains the diagnostics panel class and labels. Direct browser DOM inspection was not confirmed because browser initialization failed while creating temporary kernel assets.

## Warun connection diagnostics Skill 2026-08-24

- Skill Creatorで`warun-connection-diagnostics`を作成した。保存場所は`C:\Users\user\.codex\skills\warun-connection-diagnostics`で、safe-copy専用の読み取り診断順序と`scripts\diagnose-safe-copy.ps1`を含む。POST、再起動、再ペアリング、QR再発行、token変更、DB変更、Git変更を自動実行しない。
- prototypeへ管理者向け通信診断欄を追加し、同一originの`GET /v1/admin/diagnostics`からLAN IPv4、Web/API、PID、safe-copy/production、schema、管理認証、端末/空きテーブル、直近送受信結果、request ID、公開error code、更新時刻を表示する。未観測のA90実通信は未確認と表示する。
- serverは注文、pairing claim、pairing code発行、接続解除、管理/厨房注文取得の安全な診断記録を有界メモリとsafe-copy外部NDJSONへ記録する。Authorization、token、QR本文、注文本文、個人情報は記録しない。診断endpointの卓情報も卓ID・表示名・端末状態だけに限定し、端末IDは返さない。DB schemaと注文経路は変更していない。
- 実測safe-copyはDB`server/var/safe-copies/initial-menu-20260818.sqlite3`、Web/API 25173/28787、LAN `192.168.1.5`、実PID 11736、health 200/schema4。`DEV_STATE.md`に残るPID 12964は旧記録であり、実測値を正とする。A90の実POSTは未確認で、再送は行っていない。
- 検証済み: server 361/361、prototype 75/75、Direct Vite build 4580 modules、Sites worker 4/4、`git diff --check`。Skill validatorはPyYAML不足で未実行、frontmatter・命名・未完了TODOなしは手動確認。現行PID 11736への`GET /v1/admin/diagnostics`はHTTP 404で、live safe-copyへの新server反映とA90実機確認は次回の明示された受入作業まで未実施。

## Sake temperature HTTP payload validation fix 2026-08-23

- Code comparison identified the cause of the A90 customer error: `App.jsx`/`order-outbox.js` generated `schemaVersion: 3` with `variantId` and `temperature` for sake, while `server/src/http/json-body.mjs` accepted only schema versions 1/2 and did not allow the temperature item field. The deterministic server path was HTTP 400 with public code `INVALID_ORDER_REQUEST` before repository/DB writes.
- The exact A90 response body was not captured by the existing safe-copy logs, so the code-level diagnosis is distinguished from a direct packet capture. Empty items are blocked by the customer cart guard and outbox normalization; shochu uses servingOptionId and existing snapshot handling remains intact.
- The HTTP JSON boundary now accepts schemaVersion 3 and cold/warm temperature values, while rejecting temperature in older schemas, invalid temperatures, and invalid variant/serving combinations. Server resolves sake name/volume/temperature snapshots from the existing menu variant and keeps the existing order API and DB schema.
- Added JSON boundary coverage and an HTTP E2E covering `徳利1合`/`180ml`/`燗酒`; existing water1/soda2 shochu E2E remains green. Safe-copy was restarted only with the existing DB and ports; post-restart health is 200/schema4, PID 11736, and DB counts remain 2/5/1/54.
- Verification: server 359/359, prototype 73/73, Direct Vite build 4580 modules, direct Sites worker 4/4. No production DB, pairing, QR, resend, reset, pull, merge, commit, or push was used. Real A90 acceptance remains intentionally unperformed because the user prohibited resend.

## A90 order send failure investigation 2026-08-23

- One reported failed confirmation was investigated without resend or re-registration. Safe-copy counts stayed at `orders=2`, `order_items=5`, `table_sessions=1`, `event_log=54`; schema v4 and the existing latest `order.created` event remained unchanged, so no duplicate order was created.
- The customer source resolves the API to same-origin `POST /v1/orders`; the body contains only schemaVersion, clientOrderId, and intent items, while the device token remains in the Authorization header. The live safe-copy runtime is DB `server/var/safe-copies/initial-menu-20260818.sqlite3`, Web 25173, API 28787, PID 11368, LAN `192.168.1.5`.
- The exact A90 response status and public error code/message could not be recovered because the safe-copy runtime has no per-order access log and the in-app browser runtime is unavailable. Do not infer a 401/403/409/422/500 from the generic screen message alone.
- Client-only handling now preserves a public 4xx error code from the API response and displays safe categories (`認証切れ`, `注文内容エラー`, `送信競合`, `サーバーエラー`) instead of the generic `業務エラー`. Server, DB schema, order API, idempotency, snapshot, kitchen, history, and pairing data were not changed for this classification fix.
- Direct Vite build and HTTP-served bundle verification passed; the served bundle contains the safe categories and no generic `業務エラー` marker. Full prototype tests passed 73/73 and full server tests passed 357/357. `pnpm run test:sites` remains blocked before test execution by the existing non-TTY dependency-purge guard; run the direct Sites worker test separately when needed.
- Remaining verification: obtain one real A90 POST status/body from a request-level diagnostic path or browser network capture, without retrying the order. The current read-only check found no live A90 TCP session.

## Customer order E2E and safe-copy snapshot repair 2026-08-23

- A90側`192.168.1.8`から現行safe-copy`192.168.1.5:25173`への接続を確認した。客席の注文APIは同一originの`POST /v1/orders`で、旧IP・旧ポート・別APIパスへ送る実装ではない。直近の実safe-copy注文はHTTP注文経路を通り、`orders=2`、`order_items=5`、`table_sessions=1`、`event_log=54`、schema v4、`status=new`として保存されていた。
- DB保存後の厨房snapshotだけが、event repositoryのorder item SELECTとsnapshot projectionで`servingOptionId`／`servingOptionNameSnapshot`を落としていたため、そこだけを復旧した。customer historyは既存の同一safe-copy DB・同一open session・既存order repositoryを参照する経路を維持している。
- `server/test/http-order-events.test.mjs`へ、水割り1・ソーダ割り2を送信してDB、厨房snapshot、客席履歴まで検証するHTTP E2Eを追加した。server全体357/357、prototype全体71/71が成功。server、DB schema、注文API契約、認証、outboxの新経路は追加していない。
- safe-copyはPID 12964から11368へ再起動済み。health HTTP 200、schema v4、safe-copy DB identity、Web 25173/API 28787を確認し、launcherのPIDヘッダー配列処理を修正してruntime-stateも現行PIDへ更新した。production DB、既存注文、履歴、pairing情報は変更していない。
- A90の実アドレスバー・実タップ・実レスポンス本文はブラウザ接続障害のため未取得。A90由来の実注文保存は確認済みで、正確な水割り1・ソーダ割り2の実機操作は同等HTTP E2Eで確認した。

## Customer shochu popup footer white frame and title sizing 2026-08-23

- 「今回の選択 n点」は焼酎ポップアップ下部から削除し、キャンセルと「n点をカートに追加」だけを白背景・枠線付きの`shochu-selection-footer`に収めた。アクションは枠内で`width:100%`、`min-width:0`として、長い追加ボタン文言が横画面で外へはみ出さないようにした。
- 選択中の商品名をモーダルタイトルとして表示し、`clamp()`で可能な範囲まで大きくした。数量0時のdisabled、確定時だけ追加、キャンセル・×・背景クリックで破棄、数量操作の`touch-action: manipulation`は維持している。
- server、DB、safe-copy、注文snapshot、厨房・履歴処理は変更していない。customer UI 18/18、prototype全体71/71、Direct Vite build 4580 modules、Sites worker 4/4、`git diff --check`を確認済み。A90実機の横画面表示と実タップは未確認。

## Customer shochu popup landscape footer fix 2026-08-23

- 焼酎ポップアップの下部フッターはDOM上常に存在し、横画面用`@media (orientation: landscape) and (max-height: 700px)`でタイトル・行間・余白を縮小して全要素を収める。数量ステッパーのタップ領域は52pxを維持する。
- `modal--shochu`は`100dvh`を優先し、モーダル本体とbodyのoverflowでフッターを切らない。フッターは`display:flex`、`visibility:visible`、`opacity:1`、`flex-shrink:0`。`touch-action: manipulation`も数量操作部分に維持した。
- prototype全テスト71/71、関連UI18/18、Direct Vite build 4580 modules、Sites worker 4/4、`git diff --check`、HTTP配信本文とdistのSHA-256一致を確認済み。A90実viewport取得と実タップはブラウザ接続障害のため未確認。server、DB、safe-copy、pairing情報、注文snapshotは変更していない。

## Safe-copy shochu bundle delivery diagnosis 2026-08-23

- A90の現行配信先はruntime-state基準で`http://192.168.1.5:25173/customer/customer-01`。旧記録の`192.168.1.11:25173`は接続不能で、25173/28787の待受はNode PID 12964のみ。
- PID 12964は`node src/run-server.mjs`で、`WARUN_WEB_ROOT`は`prototype/dist/client`、DBは`server/var/safe-copies/initial-menu-20260818.sqlite3`。配信コードはリクエストごとにdistを読み、HTTPは`Cache-Control: no-store`を返す。
- `prototype/dist/client/index.html`と127.0.0.1/LANのHTTP配信本文は同一SHA-256 `F3EF784AED512FD8DEB13A75CE33DE6921D9BFF812EE089CA9E0B76D022E0A86`で、「今回の選択」「カートに追加」「キャンセル」「touch-action:manipulation」を含む。古いbundle・dist・Nodeプロセスは原因ではないため、再起動は行っていない。
- A90の実アドレスバーと画面状態はこの環境から直接確認できず、旧URLまたは保持中タブが原因候補として残る。production DB、既存注文、pairing情報は確認・変更していない。

## Customer shochu popup footer and Android tap handling 2026-08-23

- 焼酎ポップアップ下部を専用フッターにし、「今回の選択 n点」「n点をカートに追加」「キャンセル」を常に同一画面へ表示する。数量0では確定ボタンをdisabledにし、確定時だけ数量1以上をカートへ追加する。
- 飲み方行・数量操作枠・数量ボタン・商品行の飲み方ボタンに`touch-action: manipulation`、`user-select: none`、`-webkit-tap-highlight-color: transparent`を適用した。ページ全体の`user-scalable=no`は使用しない。
- 関連UIテスト18/18、prototype全テスト71/71、Direct Vite build 4580 modules、Sites worker 4/4、`git diff --check`、生成bundle内のフッター・ボタン・CSSマーカーを確認済み。A90実機タップと実ブラウザスクリーンショットは未確認。server、DB、safe-copy、注文snapshotは変更していない。

## Customer shochu multi-quantity serving popup 2026-08-23

- 焼酎の商品行は「飲み方を選ぶ」ボタンだけを表示し、商品行に選択中の飲み方名や選択状態を表示しない。ボタンを押すと、ロック・水割り・ソーダ割り・お湯割りを一覧にした一時ポップアップを開く。
- 各飲み方の数量は0から始まり、−／数量／＋でポップアップ内だけを変更する。今回の選択合計が0の間は確定ボタンをdisabledにし、選択操作だけではカートを変更しない。確定時のみ数量1以上を既存selection keyへまとめて追加するため、同じ商品・同じ飲み方は数量加算、異なる飲み方は別明細になる。
- キャンセル、×、背景クリックはドラフトを破棄して閉じる。既存の注文snapshot、厨房表示、履歴表示、servingOptionNameSnapshot処理と、日本酒・他カテゴリの追加動作は維持した。server、DB、注文API、認証、safe-copyは変更していない。
- 変更ファイル: `prototype/src/App.jsx`、`prototype/src/styles.css`、`prototype/tests/customer-ui.test.mjs`、本コンテキスト、`DEV_STATE.md`。検証済み: prototype全テスト71/71、customer UI 18/18、Direct Vite build（4580 modules transformed）、Sites worker 4/4、`git diff --check`。
- 未確認: A90実機の実タップ、1280×800実ブラウザスクリーンショット、既存カート明細を持った状態での手動回帰。次はsafe-copyを再起動せず、客席UIで数量選択・キャンセル・確定後のカート明細を確認する。

## Customer sake serving popup density update 2026-08-23

- 日本酒の客席UIは、案2の構成として提供形態と温度を同じポップアップ内で選ぶ。`グラス`、`徳利 1合`、`徳利 2合`を縦3行に詰め、グラスは冷酒固定の表示、徳利の各行右側だけに冷酒・燗酒ボタンを配置し、A90の画面内に収まるようポップアップを上寄せ・スクロールなしにした。
- ポップアップを開いた直後は提供形態・温度とも未選択だが、「この内容で追加」は常に押下できる。グラスを選ぶと冷酒を自動選択し、徳利は温度ボタンを選ぶまで注文へ追加せず、「提供温度を選択してください」を表示する。中間の選択内容表示は設けない。
- 税抜価格の大表示・税込価格の小表示は既存の`PriceDisplay`を再利用し、燗酒でも選択variantの税込マスター価格を使う既存の注文payload、order-item snapshot、厨房表示、履歴表示は変更していない。
- 今回の変更対象は`prototype/src/App.jsx`、`prototype/src/styles.css`、`prototype/tests/customer-ui.test.mjs`、本コンテキストのみ。商品データ、DB、API、Sites保護対象ファイルは変更していない。safe-copyサーバーも再起動していない。
- 検証済み: customer UI 18/18、prototype全体71/71、Direct Vite build（4580 modules transformed）、Sites準備、Sites worker 4/4、`git diff --check`。A90実機のタップ確認と1280×800の実ブラウザスクリーンショットは未実施で、safe-copyの客席URLで手動確認する次の作業として残す。

## Customer shochu serving selection separation 2026-08-23 (superseded)

- これは単一飲み方を商品行の状態として保持していた旧仕様の記録であり、現在は上記の複数数量ポップアップへ置き換えた。
- 焼酎の飲み方ボタンは選択状態だけを更新し、カート追加を行わない。選択済みの飲み方は商品行のラベルと選択ボタンの色で表示し、商品行の`＋`が現在の選択を注文へ追加する。
- 同じ飲み方で`＋`を複数回押した場合は既存のselection keyにより数量を加算し、飲み方を変更してから`＋`を押した場合はvariant相当の別スナップショット明細になる。カート追加済み明細は後から変更しない。
- 飲み方未選択で`＋`を押すと選択パネルを開き、「飲み方を選択してください」を表示する。日本酒・他カテゴリ、注文snapshot、厨房表示、履歴表示、DB/APIは変更していない。

## Pairing claimの実原因とsafe-copy修復 2026-08-22

- A90の有効期限内QR claimはsafe-copyへ到達したがHTTP 500、発生段階は`claim`だった。safe-copy DBの一時コピーで`UNIQUE constraint failed: pairing_codes.used_by_device_id`を再現し、過去に使用済みのpairing codeに残る同じdeviceIdがrevoked端末の再登録を阻害していたことを確認した。期限切れQRは別途HTTP 410 `PAIRING_EXPIRED`であり、今回の500原因ではない。
- `docs/schema-v2.sql`の`pairing_codes.used_by_device_id` UNIQUE制約を除去し、`server/src/db/database.mjs`にschema v4既存DBを起動時に単一トランザクションで再構築する互換修復を追加した。使用済みpairing情報は保持し、schemaVersion 4は維持する。active端末の409、期限切れ410、revoked customer deviceIdの再有効化ルールは変更していない。
- safe-copy DBはバックアップ`server/var/safe-copies/initial-menu-20260818-before-pairing-reuse-fix-20260822-215156.sqlite3`作成後に修復した。修復後のpairing code 24件、使用済み3件、orders 1件、order_items 1件、event_log 53件がバックアップと一致し、production DBは使用していない。
- schema修復テストを含むserver関連30/30が成功。schema v4のlegacy unique制約を持つ一時DBで、同じrevoked deviceIdの新規claim相当201、端末再有効化、テーブル割当、使用済みpairing情報保持を確認した。
- 修復後の実safe-copy DBでのA90再登録は未確認。期限の短い既存QRは使わず、次回は修復後に新規発行したQRを1回だけ実機確認する。token、QR本文、平文コードは文書へ記録しない。

## Safe-copy pairing preflight and runtime unification 2026-08-22

- `DEV_STATE.md` と現況を照合した。実際のGitは `feature/sqlite-foundation`、HEAD `14e9ae3`。既存のdirty worktreeは保持し、reset/pull/merge/commitは行っていない。
- `server/start-safe-copy.ps1` / `.cmd` と `server/src/runtime-info.mjs` が、明示されたsafe-copy DB、safe-copy判定、Web/APIポート、実測LAN IPv4、PC管理画面URL、A90客席URL、pairing URL originを生成する。production DBパスとsafe-copy外のDBは拒否し、health HTTP 200、schemaVersion 4、DB identity、プロセスを確認する。同じ非機密情報はruntime-stateにも保存する。
- 現在のsafe-copyは `server/var/safe-copies/initial-menu-20260818.sqlite3`、PID 14540、Web `25173`、API `28787`、LAN `192.168.1.11`。healthはHTTP 200、`ready`、schemaVersion 4。PC管理画面は `http://127.0.0.1:25173/admin.html#/admin/devices`、A90客席は `http://192.168.1.11:25173/customer/customer-01`。
- safe-copy専用tokenは `%LOCALAPPDATA%\WarunTabOrder\safe-copy\admin-token` に保存し、safe-copy admin行のhash一致を確認した。起動スクリプトはこのファイルをruntime tokenへ注入し、tokenファイルがない場合はランダム再生成せず停止する。
- token修正後、同じPID 17064で管理preflight HTTP 200・テーブル2のpairing発行HTTP 201、再起動後PID 14540で管理preflight HTTP 200・テーブル1のpairing発行HTTP 201を確認した。admin shellはruntime configとapiToken注入を確認したが、平文token・QR本文は出力していない。
- 接続中端末一覧と「接続解除」UIを追加し、既存の認証済みrevoke処理を再利用する。解除は端末tokenを失効し、テーブルを空きに戻すが、注文・履歴・event_logは変更しない。今回、端末解除とFirewall変更は行っていない。
- 配信中admin bundleはHTTP 200でpreflight、QR modal、pairing URL、接続解除UIマーカーを含む。今回の実機確認ではA90のテーブル4接続成功と管理画面の接続中端末表示を確認した。接続解除ボタンの実タップ確認は未実施のため未確認とする。

## Pairing再登録と端末競合の明示 2026-08-22

- `server/src/pairing/pairing-service.mjs` のclaim処理は単一トランザクション内で、期限切れコードを410、active端末の再登録を409として拒否し、現行schema v4で非active状態にあたるrevoked customer deviceIdだけを再利用して再有効化する。別のactive端末が対象テーブルに割り当て済みの場合も置換せず409とする。テーブルごとのactive端末は1台に制限される。
- 再登録では同じdeviceIdのtoken hash、表示名、app version、paired_atを更新し、revoked_atを解除する。注文、履歴、order_items、event_logは変更しない。
- 客席側はclaim APIのHTTP statusとエラーコードを保持し、410を「コード期限切れ」、409を「既存端末競合」として表示する。400/404/401も原因を表示し、汎用メッセージだけにしない。
- 検証済み: pairing関連server focused 6/6、prototype focused 11/11、server全体355/355、prototype全体71/71。Direct Vite buildは4580 modules transformedで成功した。pnpm buildは既存の非対話端末のmodules削除確認で停止した。
- safe-copyのhealthはHTTP 200、pairing.htmlと配信bundleはHTTP 200/no-storeを確認した。safe-copy実DBへのclaim書き込みと、A90での再登録3ケースの実機確認は未実施である。次はsafe-copyの専用fixtureまたは許可済みテスト端末で、revoked再登録、active競合、期限切れを実通信確認する。

## A90 revoked再登録の実機結果とsafe-copy再起動 2026-08-22

- A90の実機再登録では「既存端末競合」が表示された。実行中safe-copy DBを読み取り専用で照合した時点では、customer devicesは4行すべてrevoked、active customerは0行、テーブル1〜4はすべて未割当だった。orders 1件、order_items 1件、event_log 53件も確認した。A90が送信したdeviceId自体はアクセスログに保存されていないため、4行のどれかとの個別一致は確認不能と記録する。
- 原因は、修正版 `pairing-service.mjs` の更新時刻が20:31:53であるのに対し、実行中PID 15584の起動時刻が19:16:30で、revoked再利用修正前のサーバーがロードされたままだったこと。修正前コードにはdeviceIdが存在するだけで `DEVICE_CONFLICT` にする条件があった。
- safe-copyサーバーだけを旧PID 15584から再起動し、同じDB、Web 25173、API 28787でPID 14540を起動した。healthはHTTP 200、status=ready、db=ready、schemaVersion=4、safe-copy identity一致、pairing.htmlはHTTP 200。A90の再登録実操作はこのPC側セッションから実行できず未確認である。
- 再起動後の回帰確認はserver pairing focused 6/6、prototype pairing focused 11/11。テーブル1用QRは発行済みで、A90ではこのQRを1回だけ読み取る必要がある。

## Safe-copy管理tokenの再起動後永続化 2026-08-22

- 旧起動経路はruntime tokenを現在のプロセス環境だけに依存し、再起動後にsafe-copy admin hashと不一致になる経路があった。`server/scripts/provision-safe-copy-admin-token.mjs` はsafe-copy専用のローカルtokenファイルを一度だけ作成・再利用し、同じhashをsafe-copy admin行へ保存する。tokenファイルがある場合はランダム再生成せず、失敗時はDB・環境・ファイルをロールバックする。
- `server/start-safe-copy.ps1` はリポジトリ外の `%LOCALAPPDATA%\WarunTabOrder\safe-copy\admin-token` を読み、`WARUN_ADMIN_API_TOKEN` としてsafe-copyプロセスへ注入する。既存safe-copyプロセスのpreflightが401なら、そのsafe-copy PIDだけを再起動し、起動直後のpreflight HTTP 200を必須にする。token平文はログ、画面、状態文書へ出さない。
- 確認済み: token fileとsafe-copy admin hash一致、同一PID 17064でpreflight 200・pairing 201、再起動後PID 14540でpreflight 200・テーブル1 pairing 201、server全体355/355。production DB、既存端末解除、Firewall変更は行っていない。
- A90の再登録実操作はこのPC側セッションから実行できず未確認。再起動後に発行済みのテーブル1用QRをA90で1回だけ読み取り、revoked deviceIdのHTTP 201再登録を確認する。

## Sake serving method and temperature redesign 2026-08-19

- Japanese-sake customer rows now show one `提供方法を選ぶ` button only. Inline glass/tokuri buttons and an independent `＋` are not rendered for sake; shochu continues to use `飲み方を選ぶ` and other categories continue to use the existing add button.
- The popup title is `提供方法・温度を選ぶ`. It supports グラス 110ml/税込900円 (冷酒 only), 徳利1合 180ml/税込1000円 (冷酒・燗酒), and 徳利2合 360ml/税込2000円 (冷酒・燗酒). The displayed tax-exclusive prices use the shared formatter (818/909/1818 yen); warm service does not alter price. Cancel, close, and backdrop dismissal do not add an order item; confirmation uses `この内容で追加`.
- Schema v4 adds `menu_item_variants.temperature_options_json` and immutable `order_items.temperature_snapshot`. Admin catalog editing/import format supports the permitted temperatures per sake variant, and server order validation rejects a temperature that is not enabled for the selected variant. The existing variant ID, formal name, form, volume, tax-included price, and temperature flow through customer order snapshots, kitchen projection, and history projection. Legacy schema v2 requests remain compatible; temperature-bearing requests use schema v3.
- The non-production draft and fixture now define 12 sake variants (4 labels × glass, 徳利1合, 徳利2合). `docs/initial-menu-import-draft.md` keeps the 7-category/41-product menu, leaves 梅酒・果実酒 unregistered, and leaves image mappings absent so the importer reports warnings rather than inventing images.
- Safe-copy verification used `server/var/safe-copies/initial-menu-20260818.sqlite3` only. The pre-apply backup is `server/var/safe-copies/initial-menu-20260818-before-sake-temperature-applied.sqlite3`. Dry-run and apply each completed with 0 errors and 45 image warnings; a post-apply dry-run returned 48 unchanged catalog rows. Final counts are 7 categories, 41 items, 12 sake variants, 48 shochu serving options, 1 existing order, 1 order-item snapshot, and the original order event retained. Schema version is 4 and no production DB was used.
- Safe-copy service is currently available at `http://127.0.0.1:25173/` and LAN `http://192.168.1.10:25173/`; API health is on port 28787. The served bundle contains the one-button popup, `徳利2合`, and `temperatureSnapshot` markers, and no legacy inline sake variant button marker. A90 physical tapping and rendered screenshot acceptance remain unverified because the in-app browser trusted-path connection is unavailable; manual check is `http://192.168.1.10:25173/customer/customer-01`.
- Verification: all server tests passed 342/342; customer UI and outbox tests passed 40/40; direct Vite build passed (including the generated client bundle); `git diff --check` found no whitespace errors beyond existing LF/CRLF conversion warnings. `pnpm run build` and `pnpm run test:sites` were attempted but stopped before task execution at the existing non-TTY `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` guard; dependencies and pnpm settings were not changed. No reset, pull, merge, or commit was performed.
- Remaining scope: formal production Markdown/image mapping is not approved or applied, actual image mappings are still absent, and A90 confirmation of glass/tokuri/temperature/cancel and kitchen/history display remains manual. Next: perform the safe-copy A90 acceptance flow, then review any UI or data issue found without touching production.

## Customer category selection always collapses rail 2026-08-19

- Updated the shared `selectSubcategory` handler to set `majorNavOpen` to `false` after every subcategory selection. Major-category selection already used the same collapse behavior, so selecting either a major category or a central subcategory now always leaves the left navigation at the 78px collapsed rail.
- Reopening the major-category rail and selecting `おすすめ`, `日本酒`, or any other subcategory now collapses it immediately while preserving the selected category and existing product/variant behavior. Server, DB, order processing, importer, authentication API, and non-sake/shochu actions were not changed.
- Added a regression assertion for subcategory-selection collapse in `prototype/tests/customer-ui.test.mjs`. Customer UI tests passed 18/18 and Direct Vite production build passed. Sites preparation/inline output was refreshed for the running safe-copy server; no reset, pull, merge, or commit was performed.
- Physical A90 interaction remains unverified because the browser connection is blocked by its trusted-path guard. Manual check: open `http://192.168.1.10:5173/customer/customer-01`, reopen the rail, select a major category or subcategory, and confirm it immediately returns to 78px.

## Customer major-category rail behavior 2026-08-19

- Read-only reconciliation found the requested behavior already present in the current customer implementation: `majorNavOpen` starts as `true`; all four major-category buttons call the shared `selectMajorCategory`; that handler selects the category and sets `majorNavOpen` to `false`; the selected category is shown in the collapsed rail; tapping the full collapsed rail, including `カテゴリーを変更`, sets `majorNavOpen` to `true`.
- The same handler is used when the already-selected category is tapped again, so it also collapses on a repeat tap. The shared CSS changes the customer grid from the expanded sidebar to `78px` for `.customer-app--category-collapsed`, releasing horizontal space for product names, image placeholders, sake variant buttons, and the right order panel. Drink four-column/two-row navigation, sake direct variant buttons, shochu choices, prices, and no-total cart/history rules were not changed.
- No App.jsx or styles.css change was needed for this pass because the behavior and 78px layout were already implemented. Added an explicit regression test covering initial expansion, all-category selection collapse, repeat selection, full-rail reopen, and the 78px CSS rule in `prototype/tests/customer-ui.test.mjs`.
- Verification passed: related customer/order/pricing/repository tests 88/88, direct Vite production build, Sites preparation, direct Sites worker tests 4/4, and safe-copy HTTP 200 with collapsed-rail, 78px CSS, category-change, and sake-variant bundle markers. No server, DB, order processing, importer, authentication API, reset, pull, merge, or commit was performed.
- Physical A90 tap and screenshot acceptance remain unverified because the browser connection was rejected by its trusted-path guard. Manual next step: on A90 open `http://192.168.1.10:5173/customer/customer-01`, tap each major category including the already-selected one, confirm the sidebar becomes 78px and the center expands, then tap the full rail to reopen it.

## Customer sake row variant controls 2026-08-19

- Japanese-sake rows no longer render the combined `提供形態を選ぶ`/variant/plus control. Each existing variant is now an independent horizontal button, showing its existing name and volume (`グラス 110ml` or `徳利 180ml`) plus the shared tax-exclusive-large/tax-included-small price formatter.
- Pressing a glass or tokuri button calls the existing `addSelection(item, { variant })` path directly, so the existing variant ID, price, snapshot, kitchen, history, and order handling remain in use. The unused sake selection modal state was removed from the customer row; non-sake plus buttons and shochu serving-option selection were not changed.
- Reduced the sake image placeholder to a fixed 64px wide/108px high frame for the base layout and 52px wide/82px high at the A90-oriented breakpoint. Variant buttons remain horizontal and provide 112px/96px minimum height, exceeding the 48–56px tap target requirement.
- Changed only the customer implementation/test/context files for this pass: `prototype/src/App.jsx`, `prototype/src/styles.css`, `prototype/tests/customer-ui.test.mjs`, and this section. No server, DB, importer, authentication API, menu data, or production target was changed.
- Verification passed: related customer/order/pricing/repository tests 87/87, direct Vite production build, Sites preparation, direct Sites worker tests 4/4, and safe-copy HTTP 200. The served bundle contains `sake-variant-button` and no legacy `sake-select-button` or `sake-selection__options` markers. `pnpm run build` and `pnpm run test:sites` remain blocked before execution by the existing non-TTY modules-purge guard; no dependencies or pnpm settings were changed.
- A90 physical interaction and rendered screenshot acceptance remain unverified because the browser connection was rejected by its trusted-path guard. Manual next step: open `http://192.168.1.10:5173/customer/customer-01` on A90, select 日本酒, confirm the two large variant buttons and prices are readable, tap each once, and verify other categories still use `＋`.

## Customer shared header compaction 2026-08-19

- The existing shared `CustomerScreen` structure was retained and the central product-list header was compacted through common CSS. `MENU` and the page title now sit on one compact baseline; the `大分類 > 細分類` breadcrumb and description remain in the same hierarchy, and the red divider stays below the title with a deliberate gap.
- Reduced the customer content top padding, shared `.menu-heading` height/gaps, and shared `.subcategory-nav` vertical padding. The drink navigation remains four columns by two rows. The same rules apply to drink, food, special, seasonal, every subcategory, multi-item lists, and empty product-list states; staff, kitchen, admin, and pairing screens are not targeted.
- Product rows, empty-state content, menu data, prices, sake variants, shochu serving choices, cart/order processing, server, DB, importer, authentication API, collapsed 78px rail, and major-category behavior were not changed for this pass. `App.jsx` already supplied the shared markup, so this pass changed only `prototype/src/styles.css`, `prototype/tests/customer-ui.test.mjs`, and this context entry.
- Added a customer UI regression test that checks the shared compact header, four-column subcategory layout, and common empty-state/list rendering. Related customer/order/pricing/repository tests passed 86/86; direct Vite build passed; Sites preparation and direct Sites worker tests passed 4/4; safe-copy HTTP returned 200 and served the compact header CSS plus breadcrumb, subcategory, and empty-state bundle markers.
- `pnpm run build` and `pnpm run test:sites` remain blocked before task execution by the existing non-TTY `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` modules-purge guard. No dependencies or pnpm settings were changed. `git diff --check` was run with no whitespace errors beyond existing LF/CRLF conversion warnings.
- A rendered 1280x800 screenshot and physical A90 acceptance remain unverified: the browser connection was rejected by its trusted-path guard. Manual next step: open the safe-copy LAN URL `http://192.168.1.10:5173/customer/customer-01` on A90 and verify compact headings, no title/divider overlap, visible product rows or empty state, and both expanded/collapsed category navigation states.

## Customer visual hierarchy adjustment 2026-08-19

- Used the user-supplied `C:\Users\user\Pictures\焼酎.jpeg` and `C:\Users\user\Pictures\日本酒.jpeg` only as visual references for hierarchy, density, and control placement. No image pixels, product names, prices, capacities, totals, or catalog data from those images were copied into the app.
- The customer menu heading now presents a breadcrumb-like `大分類 > 細分類` hierarchy, with `日本酒` displayed as `日本酒・地酒` in the heading while the existing `日本酒` subcategory ID and variant model remain unchanged.
- Drink subcategories now use a fixed four-column/two-row layout instead of a horizontally scrolling strip. The existing four major categories and the 78px collapsed red rail with `カテゴリーを変更` remain intact.
- Product rows now reserve a consistent `画像なし` frame for non-sake items so image/name/description/price/add controls remain aligned in one row without introducing menu imagery. Sake rows retain the existing detail button and variant modal, while the row action visibly lists the existing variant names/volumes before opening the modal.
- Tax-exclusive large price/tax-included small price, no customer cart/history subtotal or total, existing shochu serving selection, right-side order panel, and order snapshot paths were preserved. Only `prototype/src/App.jsx`, `prototype/src/styles.css`, `prototype/tests/customer-ui.test.mjs`, and this context section were changed for this visual pass; server, DB, importer, and authentication API were not changed.
- Verification passed: related customer/order/pricing/repository tests 85/85, direct Vite build, Sites preparation, direct Sites worker tests 4/4, safe-copy HTTP bundle markers for breadcrumb/two-row navigation/sake choices/image placeholder, and `git diff --check` with no whitespace errors beyond existing LF/CRLF warnings.
- The safe-copy server is running from `server/var/safe-copies/initial-menu-20260818.sqlite3` at `http://127.0.0.1:5173/` and `http://192.168.1.10:5173/`. No production DB was used. `pnpm run test:sites` remains subject to the existing non-TTY modules-purge guard; direct tests were used without changing dependencies or pnpm settings.
- A rendered 1280x800 screenshot comparison and physical A90 interaction acceptance remain unverified because the in-app Browser runtime could not be reconnected in this environment. Manual next step: open the safe-copy LAN URL on A90 and check both expanded/collapsed rails, two-row drink navigation, Japanese sake modal, and no-total cart/history behavior.

## Customer category wireframe restructuring 2026-08-19

- Product Design scope was limited to information architecture and wireframe behavior using `izakaya-preview.png` as the broad visual reference. No image generation, product image import, icon replacement, color/font recreation, or new design system was performed.
- The customer screen now has four view-only major categories: `ドリンク`, `フード`, `名物`, and `季節・気まぐれ`. The initial state shows the major-category rail; selecting a major category collapses the rail to a 78px red bar showing the current category and `カテゴリーを変更`. Tapping the entire bar reopens the major-category selector.
- The selected major category exposes a central upper subcategory navigation. Drink subcategories are `おすすめ`, `ビール`, `ハイボール`, `サワー・酎ハイ`, `焼酎`, `日本酒`, `ソフトドリンク`, and `ノンアル`. Existing catalog IDs are mapped for display only; no DB category or product rows were added. Categories/items not represented by the safe-copy drink IDs remain visible through the existing menu fallback under the drink view.
- Food, special, and seasonal subcategory labels are wireframe-only because the current safe-copy catalog has no corresponding product data. The central product list and right order panel remain in place; the collapsed rail only releases horizontal space for them.
- Existing sake variant selection, shochu serving selection, shared tax display, cart/history no-total rule, and order snapshot paths were retained. Server, DB, importer, and authentication API files were not changed for this UI task.
- Verification passed: customer/order/pricing/repository tests 85/85; direct Vite build; Sites preparation and direct Sites worker tests 4/4; safe-copy server started with `server/var/safe-copies/initial-menu-20260818.sqlite3` and served the new subcategory/collapsed-rail bundle at `http://127.0.0.1:5173/` and `http://192.168.1.10:5173/`. `pnpm run test:sites` remained blocked by the existing non-TTY modules-purge guard; no dependency or pnpm setting was changed.
- `git diff --check` reported no whitespace errors, only existing LF/CRLF conversion warnings. No reset, pull, merge, or commit was performed, and the pre-existing dirty worktree was preserved.
- The in-app browser runtime could not be reconnected because its current Browser dependency path was rejected by the trusted-path guard. Therefore the 1280×800 rendered interaction screenshot and physical A90 flow are not claimed as completed; they remain manual acceptance steps against the safe-copy URL.
- Next: on A90, open the safe-copy LAN URL, select each major category, verify the collapsed rail/reopen behavior and drink subcategory switching, then check Japanese-sake variant selection without submitting to production.

## Sake variant selection restoration 2026-08-18

- On the existing dirty worktree at `feature/sqlite-foundation` / `14e9ae3c5d565d992b20908cec9f5530ffe3c9e0`, the customer sake row was changed to fail closed and open an explicit variant-selection modal. The product name and right-side action no longer add a sake item directly; the action is labeled `提供形態を選ぶ`.
- The modal offers the existing variant model, including `グラス 110ml` and `徳利 180ml`, and reuses `PriceDisplay`: tax-exclusive price is large and tax-included master price is shown smaller. Selecting a variant calls the existing `addSelection`; cancel, backdrop close, and the close control clear the pending selection without adding an item.
- Existing snapshot, kitchen, and customer-history paths were retained. The selected `variantId`, variant name/volume, and variant tax-included price continue through the existing order payload and immutable order-item snapshot; shochu serving selection and non-sake add behavior were not changed.
- Changed only the sake customer UI styling/test coverage in `prototype/src/App.jsx`, `prototype/src/styles.css`, and `prototype/tests/customer-ui.test.mjs` for this fix. No production DB or safe-copy catalog rows were changed, and no reset, pull, merge, or commit was performed.
- Verification passed: focused customer/order/pricing/repository tests 84/84; direct Vite build, Sites preparation, and client inlining; the safe-copy HTTP response contains `sake-selection__option` and no `sake-variants`; `git diff --check` reported no whitespace errors (only existing LF/CRLF warnings).
- The in-app browser reached the safe-copy customer pairing screen, but no registered customer credential was available there, so the post-pairing A90 product/modal, order, kitchen, and history flow remains a physical acceptance step. The safe-copy server remains the target for that check; production must not be used.
- Next: pair the A90 against the running safe-copy server, verify the two variant choices and cancel behavior, then submit one test order and confirm the selected variant in kitchen/history without using production data.

## Pairing QR regression and restoration 2026-08-18

- Diagnosis: `prototype/src/qr-code.js` and QR-related CSS were present, but the current `App.jsx` did not import or render the QR generator; it rendered only the raw input code. `pairing-main.jsx` did not read a URL fragment. The served `prototype/dist/client` was older than the source and also contained the code-only UI. Git history showed the QR display in `f71f161`/`a79b82c`, then removed from the checkpoint in `25ae7e9`.
- Restored the admin QR modal with a LAN URL fragment payload `pairing.html#p=<normalized-code>`. The pairing page now reads the fragment and pre-fills the code; the admin page does not display the raw code. QR generation/API failures now produce a visible alert instead of silently falling back to code-only output.
- Rebuilt the client bundle with direct Vite plus the existing Sites preparation/inline scripts. The fresh served bundle contains the QR generator, QR modal, and fragment reader. No production DB was used or changed; the existing dirty worktree was retained and no reset, pull, merge, or commit was performed.
- Browser verification against the running safe-copy server at `http://192.168.1.10:5173/admin.html#/admin/devices` showed the QR issue button, then a modal with an accessible `pairing QR code` image and no raw input-code text. `http://192.168.1.10:5173/pairing.html#p=ABCDEFGHIJKL` pre-filled the pairing-code field and showed the QR-import confirmation text.
- Verification passed: related pairing/admin/bootstrap tests 11/11 (pairing QR tests 5/5), direct Vite build, Sites preparation/inline generation, and the safe-copy browser check. A physical A90 camera scan was not performed in this environment; that remains the final device-level acceptance.

## Initial menu safe-copy application 2026-08-18

- Created `server/var/safe-copies/initial-menu-20260818.sqlite3` as a non-production synthetic safe copy. It contains one synthetic pre-existing completed order, one order-item snapshot, and one prior `order.created` event; the production database was not used as the copy source or target and was not changed. A separate read-only path/state inspection was performed before creating the synthetic copy.
- Dry-run against the copy used `targetKind: copy` and produced `dryRun: true`, `applied: false`, 0 errors, 45 image warnings, 46 creates, and 2 updates. The database digest and its pre-existing counts (`categories=1`, `menu_items=1`, `orders=1`, `order_items=1`, `event_log=1`) were unchanged.
- The same copy was then applied with an explicit serialize backup at `server/var/safe-copies/initial-menu-20260818-before-import.sqlite3`. Apply completed with `applied: true`, 0 errors, and 45 image warnings. The backup passed `integrity_check=ok` and retained the pre-apply counts.
- Post-apply verification passed: 7 categories, 41 menu items, 12 shochu items with 48 active serving options (4 each), and 8 active sake variants. Every sake glass variant is 110ml/900 yen and every 徳利 variant is 180ml/1000 yen. The nonalcohol beer is in category `nonalcohol` with `is_active=0`; categories/items containing `梅酒` or `果実酒` are absent; all 41 item master prices are present; no image URI was assigned.
- Existing order data was preserved: `orders=1`, `order_items=1`, `event_log=49`, the original `order.created` event remains, and the order-item snapshot retains its pre-import name, kitchen alias, and 999-yen unit price. The 48 additional events are `menu.updated` events for catalog changes.
- Started the combined server with `WARUN_DB_PATH` set to the safe copy and the existing `prototype/dist/client` web root. PC Web: `http://127.0.0.1:5173/`; LAN Web for the A90: `http://192.168.1.10:5173/`; PC admin: `http://127.0.0.1:5173/admin.html`. PC and LAN web roots returned HTTP 200; unauthenticated API access correctly returned HTTP 401. The server remains running for the manual PC/A90 check; the physical A90 pairing and visual acceptance are still pending.

## Initial menu manuscript dry-run 2026-08-18

- Converted the user-supplied import-preview manuscript to `docs/initial-menu-import-draft.md` in the stable-ID importer format: 7 categories and 41 items. It keeps tax-included integer master prices, stores 4 shochu serving options per each of 12 shochu items (48 options), and stores 2 explicit variants per each of 4 sake items (8 variants).
- The nonalcohol beer is in its own `nonalcohol` category and is inactive because the source status is `要確認`. No ume/fruit-liquor category or items were added. No image URI or image mapping file was invented; the source did not provide a separate kitchen alias, so the draft temporarily uses each formal name as `kitchen_alias` for format validation.
- Dry-run command used an empty temporary `fixture` SQLite database with no `--apply`. The result was `dryRun: true`, `applied: false`, 7 category creates, 41 item creates, 45 image warnings (41 item mappings and 4 sake detail mappings), and 0 errors. Direct count verification after dry-run found zero catalog rows; the temporary DB was removed. No production DB was opened or changed.

## Non-production Markdown catalog importer 2026-08-18

- Added a stable-ID Markdown importer for explicitly designated `fixture` or `copy` SQLite targets. It handles categories, menu items, product details, tax-included master prices, sake glass/tokuri variants, shochu serving options, and shochu section keys. The importer implementation and fixtures contain no production menu content or production image paths; the user-supplied initial manuscript is kept separately as a non-production draft.
- Added a separate `target`/`image_uri` mapping table. Missing mappings produce warnings and preserve an existing image; unknown targets, duplicate mappings, empty URIs, and invalid references stop before apply.
- Dry-run and apply share the same parsed/normalized diff plan. Results list `create`, `update`, `unchanged`, `warning`, and `error`. Apply creates a consistent SQLite serialize backup first, then uses one transaction; failures roll back catalog rows and events. Existing orders, order-item snapshots, history, and prior `event_log` rows are preserved.
- Added the CLI `server/scripts/import-catalog-markdown.mjs` and the format guide `docs/catalog-import-format.md`. Without `--apply`, the CLI is dry-run; `targetKind: production` is rejected.
- Verification passed: importer fixture tests 7/7, importer plus existing catalog repository tests 53/53, importer/script syntax checks, and `git diff --check`. The fixture covered dry-run immutability, apply, repeat unchanged, update/create, details/variants/options/section/images, pre-apply validation, rollback, order/history preservation, and image warnings.
- The user-supplied initial manuscript has only been converted and dry-run checked; a production-approved Markdown/image mapping pair is not yet available, so no real catalog import has been run. The next operation is to review the draft and, after the formal image mapping and an explicitly approved non-production DB copy are supplied, run another dry-run.

## Authenticated admin catalog write API 2026-08-18

- Existing dirty changes were preserved. Added `PUT /v1/admin/catalog/menu-item`, which accepts one authenticated admin menu-item write including product details, sake variants, and shochu serving options. SQLite catalog rows and the `menu.updated` event are committed atomically.
- The write contract uses `expectedVersion`; stale edits return HTTP 409 `CATALOG_CONFLICT`. Unauthenticated requests return 401 and non-admin devices return 403. The response exposes only `menuItemId`, the new `version`, and the committed event cursor.
- The admin menu screen now loads the authenticated admin menu when an admin token is configured and submits the editor form through the API. Local demo mode remains available when the token is absent. Category edits, bulk catalog writes, Markdown import, and image mapping are not included in this endpoint.
- Verification passed: server 334/334, admin catalog API 2/2, prototype related tests 15/15, Sites worker 4/4, JavaScript syntax checks, and `git diff --check`. No schema, production database, reset, pull, merge, or commit was performed.
- `pnpm run build` first stopped at the existing non-TTY modules purge guard. A CI-mode retry recreated `prototype/node_modules` but registry package downloads failed with `EACCES`; therefore the production build and browser visual check are unverified in this continuation. No dependency or pnpm setting was changed.
- Remaining risk: the API is optimistic-version safe but does not yet provide a durable idempotency-key table; category/bulk writes and formal Markdown/image import remain separate work. Next: implement the idempotent Markdown importer and category/catalog batch write against a safe non-production target.

## Continuation 2026-08-18

- Existing dirty changes were retained. The local admin menu editor now exposes and preserves all tasting-detail fields shown by the customer detail modal: aroma, sweetness, and finish.
- At that checkpoint, verification passed: prototype 57/57, Sites worker 4/4, direct Vite production build plus Sites preparation/inline generation, and a 1280 x 800 CSS viewport admin-editor visual check. The authenticated admin catalog write API and Markdown importer were still unimplemented at that time; no schema or production data changes were made.

## Shochu / sake stage 1 handoff 2026-08-17

- Current Git baseline is `feature/sqlite-foundation` at `14e9ae3c5d565d992b20908cec9f5530ffe3c9e0`, ahead 4 / behind 16. The pre-existing dirty worktree and all operational SQLite files were preserved; no commit, reset, pull, production migration, or production data write was performed.
- The formal price rule is now: DB/admin stores one tax-included master; customer product cards derive the tax-exclusive main price by rounding down and show the tax-included price as a smaller labelled value. Customer cart, confirmation, and customer order history still show no subtotal or total.
- Additive schema v3 and migration add product details, price variants, shochu serving options, shochu section keys, and structured immutable selection snapshots on `order_items`. Legacy order request schema v1 keeps its existing fingerprint; new structured clients use request schema v2. A consistent backup of the real schema-v2 WAL database passed temporary v2-to-v3 migration, integrity, foreign-key, protected-row preservation, and second-initialize no-op checks.
- Customer UI now has one-list shochu navigation with the non-orderable `麦・その他` divider and a one-at-a-time inline serving panel; sake keeps the existing three-column shell while exposing independent glass/tokuri price taps. A single data-driven product-detail modal hides empty fields and supports a 52px close target plus backdrop close. Admin's existing local editor exposes the new data fields, but a server-side admin write API is not yet implemented, so production daily edits are not yet durable.
- A temporary real API/SQLite browser fixture at 1280 x 800 passed pairing, customer catalog, derived prices, shochu panel replacement, repeated/split selections, sake variants, modal content replacement, close controls, order submission, structured snapshots, `event_log`, and customer history. Cart, confirmation, and customer history each had zero total labels. The app retains its pre-existing 1024px minimum-width behavior below 900px; this stage did not redesign mobile behavior.
- The supplied four-bottle composite was copied unchanged to `public/menu-images/sake-temporary-reference.jpg` as a temporary asset only. It was not guessed into four individual product mappings. No formal menu Markdown or individual image mapping has been supplied, so production categories/items/variants/images were not imported.
- Verification passed: server 332/332, prototype 56/56, Sites worker 4/4, direct Vite production build, Sites preparation/inline generation, and production browser smoke. The standard pnpm wrapper remains blocked by the environment's existing ignored `esbuild@0.25.12` build-script policy; dependencies and pnpm settings were not changed.
- Next: implement an idempotent Markdown importer and authenticated admin catalog write API, then run the provided formal Markdown and image mapping against a safe target before any authorized production migration.

## Persistent DB and real-device acceptance 2026-08-16 — PASS

- After the Windows restart and one desktop-shortcut launch, the PC kitchen screen, LAN URL `192.168.1.10:5173`, connected state, and A90 customer screen all passed. The persistent database completed v1-to-v2 migration and both kitchen and customer devices recovered.
- Read-only verification found `user_version=2`, `system_state.schema_version=2`, `integrity_check=ok`, and an empty `foreign_key_check`. Actual counts are `orders=6`, `order_items=13`, and `event_log=20`. There are two table sessions: one closed session retaining five prior orders and one open session containing the new 19:29 edamame order; zero orders have a null session.
- The real-device flow passed: customer history showed the prior visit, kitchen displayed the explicit table-1 reset confirmation, reset pushed an automatic customer-history refresh, the next order appeared as new, current customer history showed only the new session, serving moved the item to prior orders, and kitchen/admin history retained both visits.
- The confirmed contract is DB schema v2 with additive v1-to-v2 migration, table-scoped visit sessions, current-open-session-only customer history, kitchen/admin-only close, no order deletion, and lazy creation of the next session on the next order. The second serialize backup, restore migration, and reinitialize no-op checks also passed. Emergency QR fallback tablet switching remains deferred.

## Pre-migration persistent DB check 2026-08-16 — PASS (completed historical record)

- The production SQLite path is `server/var/warun.sqlite3`. Read-only inspection found `journal_mode=wal`, SQLite 3.53.3, application `user_version=1`, `system_state.schema_version=1`, SQLite internal `schema_version=33`, present `-wal`/`-shm`, and no `table_sessions`/`orders.session_id`; it is the old schema v1 migration source. The server manages the additive change as DB schema v2; order API payload `schemaVersion: 1` remains unchanged.
- Node v24.19.0 did not expose an official `backup()` method, so a new Git-ignored `server/var/backups/session-pre-migration-readonly-second-20260816100729369.sqlite3` was created from a read-only `DatabaseSync.serialize()` snapshot without overwriting the prior backup. Its SHA-256 was recorded. Source and backup matched across `sqlite_schema`, all user-table columns and rows with SQLite types preserved, `user_version`, and `system_state.schema_version`; both passed integrity and foreign-key checks and the backup reopened successfully.
- A temporary restored copy of the second backup alone passed v1-to-v2 migration, common-column data preservation, session backfill, second-initialize no-op, and integrity checks. The earlier main-file SHA change is recorded as a physical WAL/checkpoint representation difference; logical equality is now the acceptance condition. The production DB was not migrated and Windows restart/shortcut use was not performed.

## Customer table-session boundary 2026-08-16 (implementation and device acceptance complete)

- The current root remains `feature/sqlite-foundation` at `ebceab4` and retains the pre-existing dirty worktree. The session change is additive DB schema v2: SQLite schema v1 remains the migration source, while v2 has `table_sessions`, nullable legacy-compatible `orders.session_id`, one-open-session-per-table enforcement, and a transactional v1-to-v2 migration.
- Authenticated customer history now reads only the assigned table's current open session. Kitchen/admin history remains all completed orders. `POST /v1/tables/sessions/close` is kitchen/admin-only, rejects non-terminal orders with 409, is replay-safe, and leaves the historical rows intact; the next order creates the next session.
- Kitchen snapshots expose open sessions and the kitchen UI confirms `会計完了・席をリセット`. Customer history subscribes to the existing safe SSE invalidation stream and refreshes without a manual reload. QR/pairing/token changes and the existing Sites-protected files were not part of this task.
- Verification on 2026-08-16: server 330/330, prototype 52/52, Sites worker 4/4, direct Vite production build plus inline generation, temporary fresh/legacy SQLite migration and HTTP E2E, foreign-key check empty, integrity check `ok`. pnpm's locked restore/test wrapper remained blocked by the known non-TTY modules-purge confirmation; no dependencies or settings were changed.
- The subsequent persistent migration, Windows restart, one-click launch, and physical A90/PC table-session reset acceptance are recorded in the current section above. Emergency QR fallback tablet switching remains deferred.

## Current repository reconciliation 2026-08-16 (pre-device-acceptance history)

- The pre-device-acceptance root was `feature/sqlite-foundation` at `ebceab4` (`fix: serve authenticated order histories reliably`), dirty and `ahead 3 / behind 16` against `origin/feature/sqlite-foundation`. This section is historical; the current checkpoint HEAD is recorded in the latest handoff section.
- `c645a8e` and `ebceab4` were present at that pre-device-acceptance HEAD, including the Windows launcher, authenticated kitchen/customer history, and production inline-module fix. Existing dirty user changes and untracked files were preserved.
- The cold-start prerequisite check found no running Node server and confirmed the target IP and desktop shortcut, but `WARUN_KITCHEN_API_TOKEN` was absent from Windows User and Machine environment scopes. No secret was guessed, recovered, or reissued; no OS restart or launcher run was performed.
- Verification passed: server 324/324, prototype 48/48, direct Vite production build, Sites packaging, and `git diff --check`. `pnpm run build` stopped at the known non-TTY module purge confirmation, so the documented direct Vite fallback was used without changing dependencies, lockfiles, or approval settings.
- Next handoff: after an authorized safe restoration/provisioning of the kitchen runtime token, perform the Windows restart and one desktop-shortcut launch check. The customer-session history boundary remains the next product task after that operational acceptance.

## Handoff 2026-08-15

- The repository root is intentionally still dirty on `feature/sqlite-foundation` at `18e68f0`; existing user changes and the local `server/var` database were preserved.
- The current dirty implementation includes the SQLite order persistence, authenticated customer/kitchen/admin HTTP paths, kitchen serving updates, completed-order history, pairing, and customer outbox work described in `DEV_STATE.md`. The older sections below retain historical 2026-08-09/11 baselines and must not be used as the current Git baseline.
- Rechecked the root working tree without changing it: prototype tests 34/34 passed, server tests 315/315 passed, the existing Sites dist output was present, and `git diff --check` passed.
- The remote-tracking `origin/feature/sqlite-foundation` is ten commits ahead and was not merged into the dirty root. An isolated archive of that ref also passed after direct Vite/Sites packaging: prototype 37/37 and server 319/319.
- `pnpm run build` was not usable in the isolated copy because pnpm attempted a non-TTY module purge; direct Vite with `--configLoader runner` plus the two Sites scripts was used instead. No dependency, pnpm approval, or Git metadata was changed.
- A90 Chrome has confirmed QR pairing, menu display, order submission, immediate kitchen reflection, and movement to completed history; Brave registration failed. Still unverified: the post-fix A90 check, real runtime-token kitchen acceptance, deliberate offline/online transitions, QR camera scanning with the standard camera, multi-device concurrency, backup/recovery, and production operational rollout.
- Read-only A90 follow-up found a persisted order assigned by the server to table 1 while the customer demo route displayed table 3; the kitchen page also lacked API runtime configuration and showed the localStorage fallback. The customer server-assignment display, kitchen badge source, and fail-closed kitchen configuration behavior were corrected without changing SQLite data or schema.
- A90 post-fix confirmation passed: the customer screen shows table 1; the old local table-3 history is no longer shown, with no data loss and no DB change required. Admin-shell-only kitchen runtime-token injection and kitchen API regression coverage were added. At that point the DB snapshot acceptance was pending because no kitchen-role device or runtime credential was available.
- Provisioning and restart are now complete; the frontend snapshot-state rendering fix below must be used for the next no-reorder A90 kitchen check.

## Provisioning handoff 2026-08-15

- A new `kitchen` device was provisioned through `server/scripts/provision-kitchen-device.mjs`; only its token hash is in SQLite and the plaintext is held in the Windows User environment. Existing admin/customer devices were not changed.
- Read-only verification kept `orders=5`, `order_items=12`, and `event_log=14`; schema and existing order/history data were not modified. The persisted table-1 18:42 order remains `new` with two unserved items and one `order.created` event.
- After restart with the User environment configuration, authenticated local and LAN `/v1/snapshot` both returned 200 with two active orders including the 18:42 order. The kitchen token is injected only into the admin shell; it is absent from customer HTML, the bundle, Git diff, and handoff documents.
- Targeted regression tests passed: server 6/6 and prototype 13/13; direct Vite build passed. The in-app browser surface did not expose fetch/XHR and therefore its localStorage display is not an acceptance result.
- Next: wait for the A90 kitchen screen to reload and verify the API-backed table-1 order and new-order badge without placing another order or serving an existing item.

## Kitchen snapshot rendering fix 2026-08-15

- PC Chrome showed no order badge and the local empty-state message even though the persisted snapshot had two active orders. Staff-call count 1 is a separate counter.
- Existing server logs had no request-level access logging. Direct HTTP verification showed unauthenticated Web proxy 401, authenticated Web proxy/API 200, and the snapshot contained both active orders including the table-1 18:42 order. The production `fetchKitchenOrders` function reproduced the same two-order result over LAN.
- Root cause: `kitchenApiState` was missing from the `App` `useMemo` dependency list, so the fetched state never reached the rendered kitchen screen. The minimal fix adds that dependency and changes the fetch-error text to `注文情報を取得できません。`.
- No DB, order, history, event-log, or schema changes were made. Prototype target tests pass 10/10 and direct Vite build passes. Post-fix A90 visual acceptance remains pending; no reorder or serving action is required.

## Handoff 2026-08-11

- Branch: `feature/sqlite-foundation`; customer order outbox commit: `8049117` (`feat: connect customer order outbox`), pushed to `origin/feature/sqlite-foundation`.
- Implemented API-mode customer order submission with runtime `WARUN_ORDER_MODE`, `WARUN_API_BASE`, and `WARUN_API_TOKEN` settings; default demo mode remains local and does not use the API transport.
- Implemented IndexedDB outbox database `warun-customer-order-outbox` version 1, memory adapter tests, atomic claims, retry/backoff, online flush, and safe created/replayed, retryable, and rejected result handling.
- The outbox implementation is prototype/client-side only. Multi-device production synchronization, browser-level IndexedDB adapter QA on real tablets, authentication provisioning/rotation, and end-to-end network acceptance remain unverified.
- Verification completed: direct Vite build plus Sites packaging, Sites tests 4/4, outbox tests 18/18 twice, typography regression 1/1, and server tests 306/306. `pnpm run build` was not usable because dependency restoration attempted registry access and a non-TTY modules purge; no dependency or pnpm approval setting was changed.
- Existing user changes in `mvp-design-spec.md`, `prototype/AGENTS.md`, `prototype/README.md`, `prototype/src/styles.css`, `prototype/DESIGN_SYSTEM.md`, `prototype/assets/`, and `prototype/tests/typography.test.mjs` were not staged or committed.
- Next: validate the configured API mode in a browser against the existing local server with a real runtime token and deliberate offline/online transitions.

最終確認日: 2026-08-09

## Git基準点

- 確認時ブランチ: `main`
- 確認時HEAD: `8a294cbe0b943433cf4cce9bb1defb464caf506d` (`8a294cb`)
- 確認時の `origin/main` との差: ahead 0 / behind 0
- セッション開始時には必ず現在のGit状態を再確認し、この値を作業開始点として強制的に復元しない。

## 現在の実装範囲

- `prototype/` は Vite 6 + React 19 のクリック可能なフロントエンド試作。
- 端末ランチャー、客席注文、キッチン新着、提供済み履歴、メニュー・カテゴリ・端末管理画面がある。
- 主な経路は `#/`、`#/customer/customer-01`、`#/kitchen`、`#/history`、`#/admin/menu`。
- 状態はブラウザの `localStorage` に保存し、`storage` イベントで同一ブラウザの別タブへ同期する。別の実機間を同期する仕組みではない。
- Sites向けWorker、ビルド準備スクリプト、配信テストが同梱されている。

## 確認済みの画面・操作

- 客席: 商品追加、注文内容確認、注文送信、売り切れ商品の追加禁止、送信待ち表示。
- 端末ランチャー: 客席端末の起動、疑似的な通信断と再接続、送信待ち注文の疑似再送。
- キッチン: テーブル別パネル、未提供品を上段表示、品目行の提供チェック、提供済み品の下段移動、全品提供時の履歴移動。
- 履歴: 注文番号、テーブル、時刻、正式品名・数量・単価スナップショット、合計の表示。
- 管理: 正式名と厨房用通称、価格、売り切れ、並び順、カテゴリ、固定テーブル割り当ての編集。
- ビジュアル受入記録は `design-qa.md`。現在の基準は1280 x 800 CSS px、100%ズーム。

## 重要な業務ルール

- 客席には価格と合計を表示しない。
- 正式品名と単価は注文時点でスナップショット保存し、後の編集で履歴を変えない。
- 売り切れ変更は作成済み注文へ影響させない。価格変更は次回注文から適用する。
- 未提供品を上段に保ち、全品提供済みで注文を新着から履歴へ移動する。
- 客席4台はテーブルへ固定割り当てし、重複割り当てを許さない。
- 有料API・有料SaaS・一時的な無料枠に依存しない。

## 本番運用として未実装

- 本番複数実機での通信運用、バックアップ、復元、監視、障害復旧
- 管理カタログのカテゴリ・一括書き込み、永続的なidempotency-key管理、Markdown importer、正式な画像マッピング
- 永続的なオフラインキュー、再接続検知、再送制御、同期失敗処理の本番運用

現在の疑似通信断と自動再送はブラウザ内デモであり、本番の欠落防止・二重送信防止を保証しない。

## 直近の検証

- 2026-08-09: `git diff --check` は合格。
- `pnpm install --frozen-lockfile` はロックファイルどおり66パッケージを復元したが、環境の承認ポリシーが `esbuild@0.25.12` のビルドスクリプトを拒否したため終了コード1。`pnpm approve-builds` や設定変更は行っていない。
- `package.json` のbuildと同じ Vite build、Sites準備、クライアントインライン化をNodeから直接実行して合格。Sitesテストは4件合格、失敗0件。

## 次に進める場合の優先方針

1. UI試作の改善と、本番通信・保存基盤の設計を別の変更単位にする。
2. 本番基盤は既存Wi-Fi内で自己完結し、有料サービスへ依存しない構成として設計する。
3. 実装後は、4台同時注文、通信断、再送、二重送信、価格変更中の注文、各端末とサーバーの再起動を実機相当で受け入れ確認する。

## セッション終了時に更新する項目

- 確認したブランチとHEAD
- 実装範囲または重要な決定の変更
- 実行した検証と未検証事項
- 残るリスク
- 次に行う作業を1つ

## safe-copy厨房token恒久整合 2026-08-24

- server側にsafe-copy専用厨房tokenの保存・DB hash照合・明示provision・不一致時safe-stopを追加した。保存先はリポジトリ外の`%LOCALAPPDATA%\WarunTabOrder\safe-copy\kitchen-token`で、管理tokenのfallbackは追加していない。
- 既存DBにactive kitchen deviceがなかったため、safe-copy専用deviceを1件provisionし、既存のorders、order_items、event_log、注文snapshot処理は変更していない。safe-copyをPID`12420`から`17228`へ正式経路で1回再起動した。
- 確認: Web/API `25173/28787`、health HTTP 200、schema v4、runtime-state／待受PID一致、管理preflight HTTP 200、管理token／厨房tokenのsnapshot HTTP 200、activeOrders 3件、診断APIの直近取得`retrieval_success`。
- 検証: server 365/365、prototype 75/75、Direct Vite 4580 modules、Sites worker 4/4、`git diff --check`。pnpm経由buildは既存の依存承認エラーで未完了だが、Vite実体の直接buildは成功した。
- 未確認: ブラウザ接続資材の欠落により、厨房画面の目視表示は未確認。token値、注文本文、個人情報は記録していない。次は注文送信なしで厨房画面の表示だけを実機／利用可能ブラウザで確認する。

## 厨房日本酒温度表示のcommit前確認 2026-08-24

- DBと実`GET /v1/snapshot`で、`W ダブリュー 甘口`の`徳利2合 / 360ml / 冷酒`を確認した。注文・明細の欠落ではなく、`kitchen-api.js`の変換漏れで`temperatureSnapshot`だけが厨房UIへ渡っていなかった。
- `kitchen-api.js`で`temperatureSnapshot`を保持するよう修正した。既存の`App.jsx`描画はvariant名・容量・温度を同じ括弧内へ表示するため、厨房では提供方法を確認できる。
- 厨房カードはテーブル単位の意図的集約で、同一テーブルの複数active order/itemsを1カード内へ表示する。badgeは注文数（`activeOrders.length`）であり、テーブル数ではない。
- 実測時点のsafe-copyは`activeOrders=1`で、以前の3件という記録とは不一致。現HTTP・DBを正とする。prototype 75/75、Direct Vite、Sites worker 4/4を検証済み。commitは未実施。

## 旧activeOrders遷移と厨房再読込確認 2026-08-24

- 前回`activeOrders=3`だった旧3注文は、現在すべて`completed`で、各注文に`order.completed`イベントがある。自動消失・DB欠落ではなく、提供完了によるactive対象外化と判断した。現在の1件は後から作成された`new`注文。
- ユーザー報告の厨房実機目視PASSは受領済みだが、今回の再読み込み後の独立目視はブラウザ接続資材エラーで未確認。配信bundleと温度表示変換の修正は確認済み。
