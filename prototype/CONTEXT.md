# Persistent Context

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

## 本番向けとして未実装

- 複数実機間の通信
- サーバーとデータベースへの永続保存
- 認証と役割別の権限制御
- 注文IDを一意制約として扱うサーバー側冪等性
- 永続的なオフラインキュー、再接続検知、再送制御、同期失敗処理
- バックアップ、復元、監視、障害復旧

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
-
## Device registration v2 handoff (2026-08-12)

- A schema v2 migration adds `registration_requests` while preserving v1 rows and keeping `PRAGMA user_version=2` after initialization.
- `/pairing.html` creates one customer registration request, stores the request secret in IndexedDB, and polls until explicit admin table approval.
- The admin Devices screen lists public pending requests and approves an available table through the authenticated admin API. Claim creates the customer device and assignment in one transaction and returns the token only in the successful claim response.
- Legacy pairing-code registration remains available. No real database, A90, pairing code, or real order was used for verification.
- Verification: server 334/334, prototype 41/41, direct Vite build plus Sites packaging, focused migration/registration HTTP tests, and `git diff --check`.
- Remaining risk: if the claim HTTP response is lost after the server commits the device, the token cannot be recovered from its hash; use the documented administrative recovery flow rather than automatic token reissue.
