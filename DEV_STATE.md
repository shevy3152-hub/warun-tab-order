# 開発状態

## 2026-08-15 照合・再検証

- ルートの実測は `feature/sqlite-foundation` / `18e68f0` / `origin/feature/sqlite-foundation` に対して behind 10 / dirty で、現況記録と一致した。ルートの既存変更、`server/var`、別 worktree の作業は変更していない。
- ルートの現行 dirty 実装は `prototype` 34/34、`server` 315/315、`git diff --check` 合格だった。既存の `dist/client/index.html`、Sites出力も確認した。
- origin 側10コミットはルートへ混ぜず、`git archive` で一時検証コピーを作成して確認した。Vite、Sites準備、クライアントインライン化後は `prototype` 37/37、`server` 319/319 が合格した。
- 一時コピーの `pnpm run build` は pnpm の非TTYモジュール削除確認で停止したため、`--configLoader runner` を使った直接Vite buildで代替した。lockfile、依存設定、承認設定は変更していない。
- 既存の clean worktree を origin へ切り替える操作は `.git/worktrees` の `index.lock` 権限で拒否された。検証コピーで代替し、Gitメタデータは変更していない。
- `prototype/CONTEXT.md` の8/11時点の記録は歴史情報として残し、今回の現行ルート・origin検証結果と、本番実機/A90・実トークン・QRカメラ未検証を追記した。

最終確認日: 2026-08-15

## 現在地と目標

- ルート作業ツリーは `feature/sqlite-foundation`、HEAD は `18e68f0`。
- `origin/feature/sqlite-foundation` に対して behind 10。作業ツリーは dirty で、既存変更を保護する必要がある。
- 現在の目標は、客席注文をSQLiteへ保存し、厨房で提供済みに更新し、completed注文を管理履歴で確認できるP0経路を安全に整理すること。
- このファイル作成ではコード、DB、サーバー、A90、pairing、commit、pushを変更していない。

## 完了している内容

- 客席注文のAPI transport、IndexedDB outbox、credential-first bootstrap、created/replayed・pending・rejectedの状態処理が実装されている。
- customer／kitchen／admin向けHTTP経路、厨房の提供更新、completed注文のadmin履歴取得がルート差分に含まれている。
- 注文payloadは注文意図を中心に扱い、customer向けmenu/configは価格などの管理情報を返さない境界になっている。
- pairing codeはhash保存・期限・試行制限・一回利用の既存方式を維持し、短縮コード生成の変更がルート差分に含まれている。
- DB/Webの既定パスは起動ファイル位置基準の絶対パスへ変更され、同一originのWeb/API構成とLAN bindを前提にしている。
- 受入記録 `docs/ACCEPTANCE.md` には一時SQLiteによる注文→厨房→completed→履歴の自動確認が記録されている。

## 主要な決定事項

- 既存の未コミット変更、特に `mvp-design-spec.md` と `prototype/AGENTS.md` はユーザー作業として保持し、上書き・stash・reset・checkout・削除を行わない。
- APIモードとdemo/localStorageモードを混在させない。API注文はoutboxとサーバーを正本とし、demo注文は明示的なdemo経路に限定する。
- 注文の冪等性はclientOrderIdとサーバー側の既存SQLite制約・fingerprint検証で担保する。
- 秘密情報は状態文書へ記録しない。token、pairing code、credential、注文payloadは記録・出力しない。
- Sites関連の保護ファイルは今回の対象外として扱う。

## コアファイル

- 客席UI・ルーティング: `prototype/src/App.jsx`
- 客席bootstrap・注文送信: `prototype/src/customer-bootstrap.js`, `prototype/src/order-outbox.js`
- 厨房API: `prototype/src/kitchen-api.js`
- pairing画面: `prototype/pairing.html`, `prototype/src/pairing-main.jsx`, `prototype/src/admin-pairing.js`
- HTTP境界: `server/src/http/http-server.mjs`
- 注文保存・提供更新: `server/src/orders/order-repository.mjs`
- pairing・認証: `server/src/pairing/pairing-service.mjs`, `server/src/auth/device-auth.mjs`
- 起動経路: `server/src/run-server.mjs`
- 自動受入記録: `docs/ACCEPTANCE.md`, `server/test/auto-order-flow.test.mjs`

## 検証結果

2026-08-15に現在のルート作業ツリーで実行した結果:

- prototypeテスト: 34/34 PASS。
- serverテスト: 315/315 PASS。
- `git diff --check`: エラーなし。既存ファイルの改行コードに関するGit警告のみ。

既存の受入記録で確認済み:

- 直接Vite build、Sites packaging、Sitesテスト4/4 PASS。
- 一時SQLiteで `created`、同一clientOrderIdの`replayed`、orders/order_items/event_logの重複なし、厨房提供、completed、admin履歴、reload後の追加POSTなしを確認。

## 既知の問題・未確認事項

- ルート作業ツリーには多数の既存変更・未追跡ファイルがあり、今回の実装変更との完全なGit分離はまだ完了していない。
- ルートHEADはoriginより10件遅れている。origin側の後続実装をルートへ取り込んだ状態ではない。
- A90 ChromeでQRペアリング、メニュー表示、注文、厨房反映、提供済み履歴への移動まで確認済み。Braveの端末登録失敗、今回のサーバー割当表示差異、標準カメラによるQR読取、本番DB・本番注文は引き続き未確認。
- `prototype/CONTEXT.md` と一部READMEには過去時点の実装・テスト件数が残っており、現行コードとの差分整理が必要。
- `pnpm` buildは既存記録上、esbuildの承認制限で完走しなかった。承認設定は変更せず、直接Viteで代替検証した。

## 2026-08-15 A90再検証フォローアップ

- 永続SQLiteは読み取り専用で確認し、healthはready、schemaVersionは1、注文・明細・イベントは保持されていた。テーブル3の注文行はなく、実注文はサーバー割当のテーブル1として未提供のまま保存されていた。
- 原因は、客席UIがローカルのデモ端末番号を表示・履歴の基準にし、厨房UIがAPIトークン未設定時にlocalStorageへフォールバックしていたこと。新着バッジも未解決スタッフ呼出し数を表示していた。
- 最小修正として、ペアリング時のサーバー割当を客席表示へ反映し、厨房バッジを未完了注文数から算出し、API未設定時は明示的demo以外でエラー表示にした。SQLite schema/dataは変更していない。
- A90修正後確認では客席がテーブル1表示になり、旧ローカルのテーブル3履歴が消失ではなく表示対象外になったことを確認した。旧履歴の復元・DB変更は不要。
- 厨房APIのruntime token注入をadmin shell限定で追加し、対象回帰テストはserver 5/5、prototype 12/12、直接Vite build、git diff --checkを確認済み。当時は厨房ロール端末と実行環境の認証トークンがなく、実DB snapshotの実機確認が未完了だった。
- 後述のプロビジョニングとサーバー再起動で認証経路は整った。A90の厨房画面表示確認は、今回のfrontend修正後の次回確認へ引き継ぐ。

## 2026-08-15 厨房端末プロビジョニング

- 既存の平文トークンは復元せず、`server/scripts/provision-kitchen-device.mjs` による安全な経路で新規厨房端末を1件発行した。DBにはトークンハッシュのみを保存し、平文はWindows User環境変数へ設定した。既存のadmin/customer端末は変更していない。
- 注文・注文明細・履歴相当の既存データ・`event_log`・schemaは変更していない。read-only再確認で `orders=5`、`order_items=12`、`event_log=14`。18:42のテーブル1注文は `status=new`、2明細とも未提供、`order.created` 1件を保持している。
- 新しい環境変数を読み込んでサーバーを安全に再起動し、ローカル/LANの認証付き `/v1/snapshot` はともに200、未完了注文は2件、18:42注文を返すことを確認した。
- 厨房トークンはadmin shellのみに注入され、客席HTML・bundle・この文書・Git diffには含まれていない。対象回帰テストserver 6/6、prototype 13/13、直接Vite buildを確認済み。
- in-appブラウザではfetch/XHRが検証面に公開されず、表示はlocalStorage側のままだったため、これは実機受入PASSとは扱わない。次はA90厨房画面を再読み込みし、API由来のテーブル1注文と新着2件表示を確認する。再注文・提供操作は不要。

## 2026-08-15 厨房snapshot表示修正

- PC Chromeの観測では誤った新着バッジは消えたが、snapshotの2件が画面へ反映されず「すべて提供済みです」と表示された。上部のスタッフ呼出1は別カウンターであり、注文数ではない。
- サーバーログにはリクエスト単位のaccess logが実装されていなかったため既存ログから過去のChrome要求有無は判定できなかった。一方、実HTTPでは認証なしWeb proxyが401、認証付きWeb proxy/APIが200で、snapshotは未完了2件と18:42注文を返した。実装中の`fetchKitchenOrders`でも同じLAN URLを解析し、2件・テーブル1・対象注文を確認した。
- 原因は`prototype/src/App.jsx`の`useMemo`依存配列から`kitchenApiState`が漏れ、取得後stateが画面へ再反映されなかったこと。最小修正として依存配列へ追加し、取得失敗時の表示を「注文情報を取得できません。」へ変更した。DB・注文・履歴・schemaは変更していない。
- 修正後の配信bundleは更新済み。admin.htmlの厨房meta/runtime注入、customer HTMLの非注入、bundleの平文トークン不在を再確認した。prototype対象テスト10/10、直接Vite build PASS。
- A90実機の修正後表示PASSはまだ取得していない。追加の再注文・提供操作は不要で、次回の厨房画面確認へ進む。

## 失敗した方案

- `pnpm run build`をそのまま使う方法は、依存復元後のesbuild build script承認制限で完走しなかった。設定変更や`pnpm approve-builds`は行わず、直接Vite buildへ切り替えた。
- 実機・本番DBを使った確認は、未分離のdirty rootと本番データ保護のため、この状態文書の検証には使用していない。

## 次の一手

1. dirtyなルートを変更せず、clean worktreeでoriginとの差分を取り込み対象と今回の既存変更へ分離する。
2. そのworktreeで直接Vite build、Sites、P0自動受入を再確認し、ドキュメントの古い件数・前提を同期する。
3. 分離できた変更だけをレビュー対象にし、A90実機受入は最後に一度だけ行う。
