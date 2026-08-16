# Persistent Context

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
