# 開発状態

最終確認日: 2026-08-24
対象: `C:\Users\user\Documents\ChatGPT\タブレットオーダーシステム`
ブランチ: `feature/sqlite-foundation`
HEAD: `ae06aa25c18bf26f940fb37f167703c38a2b2eb2`

## 現在の目標

safe-copyの起動情報、管理画面の事前診断、pairing API、QR表示、端末の接続解除・再接続を、実行中ランタイム情報に基づいて安全に運用できる状態にする。本番DBは対象外とする。

## 日本酒温度付き注文のHTTP payload検証不一致修正 2026-08-23

- A90 `http://192.168.1.5:25173/customer/customer-01` の画面分類を、Appとserverのコードへ照合した。Appは日本酒の温度選択時に`schemaVersion: 3`、`variantId`、`temperature`を送信するが、HTTP JSON境界`server/src/http/json-body.mjs`はschemaVersion 1/2のみ、itemキーも温度なしとして検証していた。
- そのため日本酒温度付きpayloadは注文repository・DB処理前にHTTP 400、公開error code `INVALID_ORDER_REQUEST`として拒否されるコード経路だった。実機の個別response本文・requestIdはアクセスログに残っておらず直接回収できないため、これはpayloadとvalidationの決定的なコード照合結果として記録し、実機responseを取得したとは表現しない。
- `items`空はAppの`cartRows`空チェックとoutboxの`normalizeItems`で送信前に止まり、通常の確定POSTでは発生しない。日本酒の容量・正式提供形態・温度snapshotはvariantIdとtemperatureからserverが解決して保存する既存設計で、焼酎はservingOptionIdから飲み方snapshotを解決する既存設計である。既存safe-copy注文の焼酎snapshotも保持されている。
- 最小修正としてHTTP JSON境界でschemaVersion 3と`temperature`を受理し、冷酒／燗酒以外、schemaVersion 1/2のtemperature、不正な組み合わせは従来どおり`INVALID_ORDER_REQUEST`で拒否するようにした。DB schema、注文APIの意図契約、認証、pairing、snapshot投影の新経路は追加していない。
- server fixture E2EでApp相当の`徳利1合`・`180ml`・`燗酒`がHTTP 201後にvariant・容量・temperature snapshotへ保存されることを確認した。焼酎の水割り1・ソーダ割り2の既存E2Eも継続成功。
- safe-copyのみ既存起動経路でPID 11368から11736へ再起動し、DB`server/var/safe-copies/initial-menu-20260818.sqlite3`、Web 25173、API 28787を維持。health HTTP 200、schema v4、両待受PID 11736、DB件数`orders=2 / order_items=5 / table_sessions=1 / event_log=54`、最新event_id=54で変化なし。production DB、既存注文、pairing情報は変更していない。
- 検証済み: server全テスト359/359、prototype全テスト73/73、Direct Vite build（4580 modules transformed）、schema v3 JSON境界テスト、HTTP注文E2E、safe-copy再起動後health／PID／DB確認。`pnpm run test:sites`は既存の非TTY依存復元ガードでテスト開始前に停止するため、直接Sites worker 4/4で代替確認済み。`git diff --check`は文書追記後に再実行する。
- 未確認: A90での再送を禁止したため、実機で修正後に注文を送る確認は未実施。修正後の実機注文status・厨房／履歴表示は、別途明示された1回の受入確認でのみ行う。

## A90注文送信失敗の1回分調査と安全なエラー分類 2026-08-23

- 再送・再登録は行わず、失敗操作の前後でsafe-copy DBを読み取り専用比較した。`orders=2`、`order_items=5`、`table_sessions=1`、`event_log=54`、schema v4で変化はなく、最新eventは既存注文の`event_id=54 order.created`のままだった。今回の失敗操作で注文保存・order item追加・event追加は発生していないため、二重注文防止のため再送しない。
- 現行客席URLはruntime-state上`http://192.168.1.5:25173/customer/customer-01`、客席APIの実装は同一originの`/v1/orders`へ`POST`する。Web 25173とAPI 28787は同じNode PID 11368のsafe-copyプロセス（`src/run-server.mjs`）で、同一origin Webサーバーが`/v1`をAPIへ渡す。DBは`server/var/safe-copies/initial-menu-20260818.sqlite3`のみを対象とした。
- 注文payloadはtokenをbodyへ入れず、`schemaVersion`、clientOrderId、items（menuItemId、quantity、必要時のvariantId／temperature／servingOptionId）だけをJSON送信し、tokenはAuthorizationヘッダーに限定される。水割り1・ソーダ割り2は飲み方ごとの別itemとして送信する既存契約である。
- 失敗時のA90実POSTについて、URLは上記経路とコードから特定できるが、正確なHTTP status、response JSONの`error.code/message`、requestIdは特定できなかった。safe-copyには注文単位のアクセスログがなく、最新stdout/stderrも注文内容を記録していない。ブラウザ接続ランタイムも利用できず、401/403/409/422/500のいずれかを推測で割り当てない。DB未変化から確認できる範囲は、少なくとも注文保存成功後の画面解析失敗とは一致しない、という点までである。
- 原因表示の最小修正として、`prototype/src/order-outbox.js`が4xx応答の公開用`error.code`をtoken・内部messageなしで保持し、`prototype/src/customer-order-notice.js`と`App.jsx`が認証切れ・注文内容エラー・送信競合・サーバーエラー（未知値は注文受付エラー）へ分類表示するようにした。既存の同一clientOrderId冪等性、注文API、DB、snapshot、厨房・履歴経路は変更していない。
- Direct Vite build後、実safe-copy Webのcustomer bundleはHTTP 200、SHA-256 `E3ABA06495BD173D40C048F907D88F3663642EF59A1B2EB13981F84C9862F39C`で、4分類文言を含み旧「業務エラー」文言を含まないことを確認した。safe-copyの再注文操作は行っていない。
- 検証済み: prototype全テスト73/73、server全テスト357/357、Direct Vite build（4580 modules transformed）、bundle HTTP実内容、health HTTP 200／PID一致、safe-copy DB件数不変、`git diff --check`（最終確認は下記差分追記後に再実行）。`pnpm run test:sites`は既存の非TTY依存復元ガード`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`でテスト開始前に停止したため、依存復元を伴わない直接Sites workerテストを別途確認する。
- 未確認: A90のアドレスバー・実POSTのstatus／response本文・実機表示は、ブラウザ接続ランタイムと注文アクセスログが利用できないため未確認。現在の読み取り時点ではA90からのTCP接続は存在しなかった。既存注文・履歴・pairing情報・production DBは変更していない。

## 客席注文送信のsafe-copy実通信追跡・snapshot復旧 2026-08-23

- A90側のTCP接続元`192.168.1.8`が、現行safe-copyの`192.168.1.5:25173`へ接続していたことを確認した。現行客席URLは`http://192.168.1.5:25173/customer/customer-01`、APIは同一originの`/v1`、注文確定は`POST /v1/orders`である。旧IP `192.168.1.11`・旧APIポート`28786`へは送信していない。
- 直近の実safe-copy注文はHTTP注文経路を通過し、DBで`orders=2`、`order_items=5`、`table_sessions=1`、`event_log=54`、schema v4、最新注文`status=new`を確認した。新規作成の応答契約はHTTP 201と`Idempotency-Result: created`、再送はHTTP 200と`replayed`である。tokenとpayload内の機密値は出力していない。
- 実障害は注文保存ではなく、`server/src/events/event-repository.mjs`と`snapshot-service.mjs`が保存済みの`servingOptionId`／`servingOptionNameSnapshot`を厨房snapshotへ投影していなかったことだった。既存注文API、認証、DB schema、outbox経路は変更せず、snapshot投影のみ修正した。
- 同等客席HTTPクライアントのE2Eテストで、水割り1・ソーダ割り2を`POST /v1/orders`へ送信し、SQLiteのorders/order_items/table_sessions/event_log、`/v1/snapshot`厨房応答、`/v1/customer/order-history`客席履歴まで同じ注文・数量・飲み方snapshotを確認した。
- safe-copyのみを既存起動経路で再起動し、PIDは`12964`から`11368`へ変更。現在はhealth HTTP 200、`status=ready`、`db=ready`、schema v4、safe-copy identity一致、Web/API待受PID一致。PowerShellのhealth PIDヘッダー配列処理も修正し、`runtime-state.json`はPID 11368へ更新済み。
- 検証済み: server全テスト357/357、prototype全テスト71/71、関連E2Eを含むHTTP注文・snapshot・履歴テスト、safe-copy health／Web HTTP 200、DB件数不変、`git diff --check`（最終実行は文書追記後に再確認）。production DB、既存注文、既存履歴、pairing情報は変更していない。
- 未確認: この環境のブラウザ接続ランタイムが起動できないため、A90画面上でのアドレスバー・注文確定タップ・実レスポンス本文の直接取得。A90由来の実注文保存とTCP接続は確認済みで、正確な水割り1・ソーダ割り2のsafe-copy実機操作は同等HTTP E2Eで代替した。

## 焼酎ポップアップのフッター白枠・商品名拡大 2026-08-23

- 下部の「今回の選択 n点」表示を削除し、キャンセルと「n点をカートに追加」だけを`shochu-selection-footer`の白い枠内へ配置した。ボタンはフッター幅いっぱいのグリッドで再計算し、`min-width:0`と`width:100%`で枠からのはみ出しを防止した。
- 選択中の商品名は焼酎ポップアップのモーダル見出しへ移し、`clamp()`による大きい文字サイズと折返しを設定した。数量操作、確定・キャンセルの動作、注文snapshot、厨房表示、履歴表示、safe-copy、server、DBは変更していない。
- 検証済み: 関連customer UIテスト18/18、prototype全テスト71/71、Direct Vite build（4580 modules transformed）、Sites worker 4/4、`git diff --check`。非昇格sandboxのbuildは上位ディレクトリ読取制限で失敗したため、同じbuildを昇格実行して成功した。
- 未確認: A90実機または実ブラウザでの横画面スクリーンショットと実タップ。ブラウザ接続ランタイムが利用できないため、実viewport上の見た目は手動確認に残す。

## 焼酎ポップアップ横画面フッター表示修正 2026-08-23

- `App.jsx`の焼酎ポップアップは、タイトル・4飲み方・数量ステッパー・選択合計・追加・キャンセルを常に同じDOM内に持つ構造を確認した。
- `styles.css`に横画面かつ`max-height:700px`用の`@media (orientation: landscape)`を追加し、`100dvh`基準へ変更した。タイトル、行間、余白だけを縮小し、数量ステッパーは52pxを維持する。下部フッターは`display:flex`、`visibility:visible`、`opacity:1`、`flex-shrink:0`、モーダルは`overflow:visible`とした。
- 変更ファイル: `prototype/src/App.jsx`、`prototype/src/styles.css`、`prototype/tests/customer-ui.test.mjs`、`prototype/CONTEXT.md`、`DEV_STATE.md`。server、DB、safe-copy、pairing情報、注文snapshotは変更していない。safe-copy再起動も行っていない。
- 検証済み: prototype全テスト71/71、関連UIテスト18/18、Direct Vite build（4580 modules transformed）、Sites worker 4/4、`git diff --check`。生成distとHTTP配信本文はSHA-256 `54B56E38E71388894076E7570F44DCB013FE7ABB466B6AE6A0A2E9D1F39984D1`で一致し、フッター、visible、touch CSSを確認した。
- 未確認: A90実機または実ブラウザでの`window.innerWidth/innerHeight`取得と、横画面での実タップ確認。ブラウザ接続ランタイムが起動できなかったため、実viewportの表示確認は次の手動確認に残す。

## 焼酎の複数飲み方数量選択 2026-08-23

- 商品行の「飲み方を選ぶ」から、ロック・水割り・ソーダ割り・お湯割りを各0点で開始する一時ポップアップを追加した。ポップアップは数量変更で閉じず、「X点をカートに追加」の確定時だけ数量1以上を既存の`addSelection`へ投入する。
- 同じ商品・同じ飲み方は既存のselection keyで数量加算し、異なる飲み方は別明細になる。既存の注文snapshot、厨房表示、履歴表示、serving option投影は維持し、商品行には選択中の飲み方名を表示しない。キャンセル、×、背景クリックは一時選択だけを破棄する。
- A90 1280x800向けに、4行の数量操作、合計、確定・キャンセルを上寄せ・スクロールなしで配置した。日本酒、他カテゴリ、server、DBスキーマ、注文API、認証、safe-copyは変更していない。
- 変更ファイル: `prototype/src/App.jsx`、`prototype/src/styles.css`、`prototype/tests/customer-ui.test.mjs`、`prototype/CONTEXT.md`、`DEV_STATE.md`。
- 検証済み: prototype全テスト71/71、関連customer UIテスト18/18、Direct Vite build（4580 modules transformed）、Sites workerテスト4/4、`git diff --check`。A90実機の実タップ、1280×800の実ブラウザスクリーンショット、既存カートを持った状態からの手動回帰は未確認。

## 焼酎ポップアップ下部表示・Androidタップ対策再確認 2026-08-23

- ポップアップ下部を`shochu-selection-footer`として固定し、「今回の選択 n点」、数量0時にdisabledとなる「n点をカートに追加」、および「キャンセル」を同一画面へ配置した。確定時以外は`addSelection`を呼ばず、×・背景クリック・キャンセルはドラフトを破棄する。
- 飲み方行、数量操作枠、数量ボタン、商品行の「飲み方を選ぶ」に`touch-action: manipulation`、`user-select: none`、`-webkit-tap-highlight-color: transparent`を限定適用した。ページ全体の`user-scalable=no`は設定していない。
- 変更ファイル: `prototype/src/App.jsx`、`prototype/src/styles.css`、`prototype/tests/customer-ui.test.mjs`、`prototype/CONTEXT.md`、`DEV_STATE.md`。server、DB、safe-copy、注文snapshot処理は変更していない。
- 検証済み: customer UI 18/18、prototype全テスト71/71、Direct Vite build（4580 modules transformed）、Sites worker 4/4、`git diff --check`。生成bundleに下部3要素、`modal--shochu`、数量操作CSSが含まれることを確認した。
- 未確認: A90実機の実タップと実ブラウザスクリーンショット。配信bundleの静的反映確認で代替し、safe-copyの再起動は行っていない。

## 完了した内容

- safe-copy専用起動経路を追加し、DB絶対パス、safe-copy判定、Web/APIポート、実測LAN IPv4、管理画面URL、客席URL、pairing URL生成元を起動時に扱う。固定IPや固定ポートをQR生成元にしない。
- 管理画面のpreflight、空きテーブル限定のpairing発行、201成功時だけのQR表示、期限切れ410、active端末・テーブル競合409、revoked端末の同一deviceId再有効化を実装した。
- `pairing_codes.used_by_device_id` の旧UNIQUE制約がrevoked端末の再登録を500にしていた原因を特定した。schema v4の既存DBを起動時に単一トランザクションで互換修復し、使用済みpairing情報を保持する。
- 接続中端末一覧と接続解除UIを実装した。接続解除は端末を失効し、注文・履歴・order_items・event_logを変更しない。
- safe-copy専用管理tokenはリポジトリ外の既存方式で永続化し、DBにはハッシュだけを保存する。平文token、QR本文、cookie、秘密値はコード・ログ・状態文書へ記録していない。
- 2026-08-22、safe-copyでテーブル1の接続解除後に新しいQRでA90を再接続する実機テストが通過した（ユーザー確認）。

## 現在確認できたsafe-copy

- DB: `C:\Users\user\Documents\ChatGPT\タブレットオーダーシステム\server\var\safe-copies\initial-menu-20260818.sqlite3`
- Web/API: `25173` / `28787`
- LAN IPv4: `192.168.1.5`
- PC管理画面: `http://127.0.0.1:25173/admin.html#/admin/devices`
- A90客席: `http://192.168.1.5:25173/customer/customer-01`
- 現在のhealth: HTTP 200、`status=ready`、`db=ready`、schemaVersion 4。
- 現在の待受: Web/APIともTCP LISTENING、同一NodeプロセスPID 12964（`/v1/health`の`X-Warun-Process-Id`と一致）。
- production DBは今回のsafe-copy確認対象にしていない。

## A90焼酎UI配信経路の切り分け 2026-08-23

- 現行runtime-stateとTCP待受の正は、A90客席 `http://192.168.1.5:25173/customer/customer-01`、API `28787`、Node PID `12964`。PID 12964は`C:\Program Files\nodejs\node.exe`で、既存起動経路のコマンドは`src/run-server.mjs`、safe-copy DBは`server/var/safe-copies/initial-menu-20260818.sqlite3`。
- `server/start-safe-copy.ps1`の`WARUN_WEB_ROOT`は`prototype/dist/client`で、Node配信コードはHTML/JS/CSSをリクエストごとに`readFile`し、`Cache-Control: no-store`を返す。したがってPID 12964の起動時刻がbundle生成より前でも、古いbundleをプロセス内に保持する経路ではない。
- `prototype/dist/client/index.html`と`http://127.0.0.1:25173/customer/customer-01`および現行LAN URLのHTTP本文は、サイズ206685 bytes、SHA-256 `F3EF784AED512FD8DEB13A75CE33DE6921D9BFF812EE089CA9E0B76D022E0A86`で一致した。配信内容には「今回の選択」「カートに追加」「キャンセル」「touch-action:manipulation」が含まれる。
- 旧状態文書に残っていた`192.168.1.11:25173`は接続不能で、現行配信元ではない。現行LAN URLはHTTP 200、API healthはHTTP 200、`status=ready`、`db=ready`、schema v4、health PID 12964。
- 原因候補はA90側が旧URLを開いている、または旧画面をタブ内に保持していることだが、この環境からA90のアドレスバー・画面状態を直接取得できないため断定しない。古いbundle・古いdist・古いNodeプロセスは確認されず、safe-copy再起動は行っていない。

## 主要な決定事項

- QRは画面再読み込みでは発行しない。管理画面で空きテーブルを選択し、明示的に「QRを発行／コードを発行」を押して新しいQRを表示する。期限切れQRは再利用しない。
- テーブルごとのactive端末は1台だけとし、active端末がある場合は409で拒否する。revoked/inactive端末は、対象テーブルが空いている場合に同じdeviceIdを再利用して再有効化する。
- pairing claimとDB互換修復は単一トランザクションで扱い、既存注文・履歴・event_logを削除・書換えしない。
- safe-copyの管理tokenは毎回再生成しない。token値はログ・画面・DEV_STATE.md・CONTEXT.mdへ出さない。

## コアファイル

- 起動・runtime: `server/start-safe-copy.ps1`、`server/start-safe-copy.cmd`、`server/src/runtime-info.mjs`、`server/src/run-server.mjs`
- pairing/API: `server/src/pairing/pairing-service.mjs`、`server/src/http/http-server.mjs`、`prototype/src/admin-pairing.js`、`prototype/src/pairing-main.jsx`
- DB・schema: `server/src/db/database.mjs`、`docs/schema-v2.sql`
- 客席UI: `prototype/src/App.jsx`、`prototype/src/styles.css`
- テスト: `server/test/database.test.mjs`、`server/test/pairing-service.test.mjs`、`server/test/http-admin-pairing-preflight.test.mjs`、`server/test/safe-copy-launcher.test.mjs`、`prototype/tests/pairing-qr.test.mjs`、`prototype/tests/admin-pairing.test.mjs`

## テスト結果

- server全テスト: `node --test`、356/356成功。
- prototype全テスト: `node --test tests/*.test.mjs`、71/71成功。
- 現行safe-copy health: HTTP 200、schemaVersion 4。
- `git diff --check`: 空白エラーなしを確認済み。LF/CRLF変換警告はGitの警告であり、空白エラーではない。
- Direct Vite build: sandbox実行では親ディレクトリのアクセス拒否で停止したが、同じコードを昇格実行して4580 modules transformed、成功。依存関係・設定・コードは変更していない。

## Gitと機密ファイルの確認

- 既存の未コミット変更・未追跡ファイルは保持した。checkpoint commit `9ab6760` を作成済みで、reset、pull、merge、pushは行っていない。
- safe-copy DB、バックアップ、通常DB、runtimeログはGit indexに登録されていない。`server/var/` を`.gitignore`へ追加し、今後もGit対象外とした。
- `server/tmp/`、`*.log`、`prototype/dist/`もGit除外対象である。
- 管理tokenの保存先はリポジトリ外であり、token平文は確認出力・Git差分・DEV_STATE.mdに含めていない。

## 既知の問題・未確認事項

- A90の解除後再接続成功はユーザー報告で確認したが、その操作単体のclaim HTTP status/bodyは記録していない。QR本文やtokenを追加取得して再試行はしない。
- 読み取り専用確認で、リポジトリ外の`runtime-state.json`は旧PIDを保持しているが、現行safe-copyは`/v1/health`の`X-Warun-Process-Id`とWeb/API待受PIDを正とすることを確認した。
- 現在のsafe-copy起動経路では`runtime-state.json`のPID照合を行っていないため、現時点の機能影響はない。
- 将来、すべてのsafe-copy起動経路で`runtime-state.json`を更新・整合させる改善を検討する。
- 非昇格sandboxのbuildはアクセス拒否になるため、build確認には昇格実行が必要。昇格後のbuildは成功している。
- prototypeは客席UIを含む試作であり、production運用の安全性はsafe-copyの検証結果だけでは保証しない。

## 失敗した方案

- 旧schema v4の`used_by_device_id` UNIQUE制約を残したままのrevoked端末再登録は、同一deviceIdの過去pairing行と衝突してHTTP 500になったため採用しなかった。
- 期限切れQRの再利用はHTTP 410になるため採用しない。
- `pnpm run build`の非対話実行は環境の依存・承認制約で完走しなかった。設定変更は行わず、Direct Vite buildによる代替確認を使用してきた。

## 次の一手

pairingを再発行せず、必要に応じてsafe-copyの注文・履歴・event_logが接続解除・再接続後も保持されていることを読み取り専用で確認する。新しいQR発行や端末解除は、別の実機テストが明示された場合だけ行う。

## 変更していない範囲

production DB、safe-copy以外のDB、既存注文、注文履歴、order_items、event_log、既存active端末、reset、pull、merge、commit、pushは変更していない。

## 通信診断Skillとsafe-copy実測 2026-08-24

- Skill Creatorでwarun-tab-order専用Skill `warun-connection-diagnostics`を作成した。保存場所はリポジトリ外の`C:\Users\user\.codex\skills\warun-connection-diagnostics`で、Skill本文と`scripts\diagnose-safe-copy.ps1`を含む。発動対象は「開けない」「QRを発行できない」「登録できない」「注文を送れない」「注文が管理画面／厨房へ届かない」「サーバーが動いているか確認」「通信を診断」「また同じエラー」などである。
- 診断スクリプトはPOSTを一切送らず、Git状態、LAN IPv4、Web/API待受PID、Node起動コマンド、runtime-state、health、safe-copy DB、管理preflight、管理履歴、active snapshot、診断ログを読み取り専用で比較する。token、Authorization、QR本文、注文本文、個人情報は出力しない。production DBは開いていない。
- 実測時点のGitは`feature/sqlite-foundation`、HEADは`9ab676068083ef7bbdfc70f64ed510a2327ee35a`、既存dirty worktreeを保持している。旧記録のPID 12964と異なり、実際のWeb/API待受とNodeはPID 11736。runtime-state実体もPID 11736、DB`server/var/safe-copies/initial-menu-20260818.sqlite3`、Web/API 25173/28787、LAN `192.168.1.5`を保持しているため、今回の現況は実測値を正とする。
- healthはHTTP 200、`status=ready`、`db=ready`、schemaVersion 4、health PID 11736。管理preflightはsame-origin Web経由でHTTP 200、管理認証valid、safe-copy、空きテーブル2/3/4、割当済みテーブル1。読み取りAPIは履歴HTTP 200・1件、active snapshot HTTP 200・2件。
- safe-copy DBの読み取り専用集計は`orders=3`、`order_items=6`、`event_log=55`、注文statusはcompleted 1件・new 2件、最新eventは`order.created`。A90のPOSTはこの環境から実通信記録を取得できておらず、Skillは再送せず「未確認」と分類する。したがって「A90送信成功・管理画面注文なし」の原因を今回の実通信で確定したとは扱わない。履歴APIのcompleted限定とactive snapshotの分離は既存実装上の確認事項として残る。
- アプリ側へ、対象HTTP endpointの安全な診断記録と`GET /v1/admin/diagnostics`を追加した。記録項目は日時、request ID、endpoint、HTTP status、公開error code、処理時間、到達stage、粗い分類、件数のみで、DBテーブルは増やしていない。診断endpointの卓情報も卓ID・表示名・端末状態だけに限定し、端末IDは返さない。管理画面の端末設定欄へLAN、port、PID、DB target、schema、認証、接続端末/空きテーブル、直近送受信結果、request ID、公開error code、最終更新を表示する診断欄を追加した。safe-copy launcherは通信診断NDJSONログの保存先を環境変数で設定する。
- 検証済み: server全テスト361/361、prototype全テスト75/75、Direct Vite build 4580 modules、Sites worker 4/4、`git diff --check`。Skill validatorは同梱PythonにPyYAMLがないため実行不能で、frontmatter・命名・TODOなしを手動確認した。`pnpm exec vite build`は既存の`ERR_PNPM_IGNORED_BUILDS`で依存確認前に停止したため、既存node_modulesのDirect Vite buildで代替した。
- 未確認: 現在PID 11736は変更後serverを再起動していないため、live safe-copy Webの`GET /v1/admin/diagnostics`はHTTP 404で、変更後serverと通信ログはまだ反映されていない。A90の実アドレスバー・実POST status/response・実機表示も未確認。再起動・再送・再登録・QR発行・DB変更は行っていない。
- 次の一手: 明示された保守受入時に既存`server/start-safe-copy.ps1 -NoBrowser`経路で新bundle/serverをsafe-copyへ反映し、POSTを発生させず管理画面の通信診断欄と`GET /v1/admin/diagnostics`だけを確認する。

## 通信診断機能のsafe-copy反映確認 2026-08-24

- 再起動前にsafe-copy DB絶対パス、`orders=3`、`order_items=6`、`event_log=55`、Web/API `25173/28787`、PID `11736`、production DB未使用を読み取り確認した。
- 既存の正式経路`server/start-safe-copy.ps1 -DatabasePath server/var/safe-copies/initial-menu-20260818.sqlite3 -WebPort 25173 -ApiPort 28787 -NoBrowser`でsafe-copyだけを再起動した。反映後PIDは`12420`。
- 反映後はhealth HTTP 200、`ready`、`db=ready`、schema v4、DB target safe-copy、Web/API待受PID `12420`一致、health PID `12420`一致、runtime-state PID `12420`一致、管理preflight HTTP 200、`GET /v1/admin/diagnostics` HTTP 200を確認した。診断APIの保存集計はorders 3、order_items 6、event_log 55である。
- 再起動前後のDB件数は`3/6/55`で一致し、注文POST、QR発行、pairing claim、接続解除、production DB、既存端末、注文データへの変更は行っていない。
- 管理HTMLはHTTP 200で、配信本文に`communication-diagnostics`、`通信診断`、`直近の注文送信`、`直近の注文取得`を含むことを確認した。Browser接続は一時資産作成エラーで初期化できず、実ブラウザの目視DOM表示は未確認とする。

## safe-copy厨房token恒久整合 2026-08-24

- 直前のsafe-copy DB集計は`orders=4`、`order_items=7`、`event_log=56`。既知の`3/6/55`からの増加は、最新`order.created`の時刻`1787499842343`までは確認できたが、DBと診断NDJSONにrequest ID・HTTP endpointの対応記録がなく、A90テスト注文による増加かは不明とした。注文本文は表示せず、再送・削除も行っていない。
- `server/scripts/provision-safe-copy-kitchen-token.mjs`を追加し、safe-copy限定のDB判定、保存ファイル`%LOCALAPPDATA%\WarunTabOrder\safe-copy\kitchen-token`、DB hash照合、active kitchen device検証、明示provision、読み取り専用check、safe-copyバックアップを実装した。既存active kitchen deviceが存在しなかったため、safe-copy専用のactive kitchen deviceを1件だけprovisionした。管理tokenとは別値で、DB業務テーブルの件数は変えていない。
- `server/start-safe-copy.ps1`は正式起動前に厨房tokenを`check/ensure`し、失敗時は起動停止する。成功時だけ保存tokenを`WARUN_KITCHEN_API_TOKEN`へ注入し、配信admin shellの厨房runtime設定も保存tokenと照合する。provisionスクリプトの呼出しは起動スクリプト基準の絶対パスにした。
- 実適用では旧PID`12420`をsafe-copy health・Web/API待受で識別して停止し、DBを`C:\Users\user\AppData\Local\WarunTabOrder\safe-copy\backups\`配下へバックアップ後、厨房認証だけを整合した。正式起動後PIDは`17228`、health HTTP 200、`ready`、`db=ready`、schema v4、Web/API待受・runtime-state PID一致、管理preflight HTTP 200、production DB未使用である。
- 再起動前後のDB件数は`orders=4 / order_items=7 / event_log=56`で不変。管理tokenと厨房tokenの`GET /v1/snapshot`はいずれもHTTP 200、`activeOrders=3`。`GET /v1/admin/diagnostics`はHTTP 200、直近注文取得は`GET /v1/snapshot`・status 200・`retrieved`・`retrieval_success`・activeOrderCount 3。管理HTMLはHTTP 200で、厨房runtime設定と保存tokenの一致を値を表示せず確認した。
- 検証済み: server全テスト365/365、prototype全テスト75/75、provision／再起動境界／不一致safe-stop／backupテスト、Direct Vite build 4580 modules、Sites worker 4/4、`git diff --check`。`pnpm exec vite build`は既存`ERR_PNPM_IGNORED_BUILDS`で停止したため、既存node_modulesのVite実体を直接実行した。新規実装・状態文書・safe-copyログにcanonical token値の混入なし。
- 未確認: デスクトップ内ブラウザ接続はローカル起動資材パス欠落で初期化できず、厨房画面の目視表示（「注文情報を取得できません」の消失）は未確認。HTTP実通信、token優先経路、activeOrders 3件までは確認済み。次の一手は、注文を送信せず厨房画面を実機または利用可能なブラウザで再読み込みして目視確認すること。

## 厨房日本酒温度表示のcommit前確認 2026-08-24

- 読み取り確認時の実safe-copy状態は`orders=6`、`order_items=9`、`event_log=66`、completed 5件・new 1件で、`GET /v1/snapshot`の実レスポンスも`activeOrders=1`だった。以前の`activeOrders=3`という記録とは不一致だが、現DB・現HTTPを正とし、追加POSTやDB変更は行っていない。
- 対象`W ダブリュー 甘口`はDB snapshotと厨房tokenによる`GET /v1/snapshot`の双方で、`variantNameSnapshot=徳利2合`、`variantVolumeSnapshot=360ml`、`temperatureSnapshot=冷酒`、数量1、未提供を確認した。
- 原因は`prototype/src/kitchen-api.js`のAPI→厨房画面変換が`temperatureSnapshot`を取り込んでいなかったこと。`App.jsx`の`selectionSuffix`と厨房描画は温度表示に対応済みだったため、変換へ1項目を追加し、APIテストで冷酒・徳利2合・360mlの受け渡しを固定した。表示は`W ダブリュー 甘口（徳利2合 360ml 冷酒）`になる経路である。
- 厨房カードは`KitchenScreen`の`new Set(activeOrders.map(order => order.tableId))`でテーブル単位に作られ、各カード内で同一テーブルの全active order/itemsを`flatMap`している。したがって3件が同一テーブルなら1カードへの集約は意図的であり、明細欠落ではない。左メニューbadgeはテーブル数ではなく`activeOrders.length`（注文数）を表示する。
- 配信確認: HTTP配信admin HTML・bundleとも200、配信bundleに`temperatureSnapshot`を含むことを確認した。safe-copyの再起動、DB変更、注文POST、QR、pairing、token変更は行っていない。
- 検証済み: prototype全テスト75/75、Direct Vite build 4580 modules、Sites worker 4/4、`git diff --check`。次はこの変更を含むcommit前レビューであり、commit自体は未実施。

## 旧activeOrders遷移と厨房再読込確認 2026-08-24

- 前回のsafe-copy集計境界`orders=4 / event_log=56 / latest order.created at 1787499842343`を基準に、旧`activeOrders=3`相当の3注文を読み取り照合した。現在はいずれも`completed`で、各注文に`order.completed`イベントが存在する。完了イベント時刻は`1787504771195`、`1787504771471`、`1787504772511`。注文本文・ID・機密値は出力していない。
- したがって「2件が自動消失」ではなく、旧3件は提供完了へ正常遷移し、その後に1件の`order.created`が追加され現在の`activeOrders=1`になっている。ユーザー記録の「対象外2件」と実DBの件数には差異があるため、実DBを正とする。
- 厨房画面の再読み込み目視は、ブラウザ接続の既知のローカル資材エラーで取得できなかった。配信bundleには温度変換修正が含まれ、ユーザー報告の実機目視PASSは受領しているが、今回の再読み込み後の独立目視は未確認と記録する。

## 通信診断・safe-copy認証・厨房表示の実機受入PASS 2026-08-24

- ユーザー実機受入で、safe-copy再起動後health、管理token、厨房token、diagnostics API、厨房注文取得、日本酒表示をPASS確認した。日本酒表示は`W ダブリュー 甘口（徳利2合 360ml 冷酒）`で、activeOrdersの件数変化は`order.completed`イベントで説明済み、自動消失・明細欠落なし。
- 温度表示の文字サイズ・視認性は機能不具合ではなく、後回しの既知UI課題として記録する。今回のcheckpointではUI微調整を追加しない。
- 個人Skill `C:\Users\user\.codex\skills\warun-connection-diagnostics`はリポジトリ外のため、Gitへ追加しない。server/var、バックアップ、runtime-state、ログ、prototype/dist、build成果物、`.codex-worktrees`もcommit対象外とする。

## 日本酒温度選択・厨房短縮表示・送信済み通知 2026-08-24

- 日本酒variantの温度制限に応じ、グラスは冷を自動選択、冷専用／燗専用は不要な温度ボタンを非表示、両対応は冷／燗を選択する仕様を実装した。温度・サイズ選択だけでは追加せず、最後の「追加」で注文へ投入する。
- 厨房表示は`商品名（グラス・冷）`、`商品名（1合・燗）`、`商品名（2合・冷／燗）`の短縮形式とし、「徳利」「ml」「冷酒／燗酒」の長い表記を表示しない。DB、API、注文snapshot、客席履歴の完全情報は維持する。
- A90実機で、グラス冷自動選択、冷専用／燗専用の不要ボタン非表示、両対応の冷／燗選択、追加前カート不変、厨房の2合冷／燗短縮表示、徳利・ml・冷酒／燗酒表記省略をALL PASS確認した。
- 客席の緑色「送信済みです。ご注文を承りました。」通知は4秒後に自動消去する。送信中・送信待ち・エラー通知は対象外とした。
- 検証済み: 関連UI 21/21、prototype全テスト77/77、Sites worker 4/4、Direct Vite build 4580 modules、safe-copy配信bundle反映、`git diff --check`。safe-copy再起動、注文送信、DB変更、pairing、QR、token変更は行っていない。
- 変更対象は`DEV_STATE.md`、`prototype/CONTEXT.md`、`prototype/src/App.jsx`、`prototype/tests/customer-ui.test.mjs`。既存未追跡`.codex-worktrees`は保持し、server、DB、server/var、dist、ログ、tokenはstage対象外とする。
