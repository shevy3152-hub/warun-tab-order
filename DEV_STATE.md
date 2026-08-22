# 開発状態

最終確認日: 2026-08-22
対象: `C:\Users\user\Documents\ChatGPT\タブレットオーダーシステム`
ブランチ: `feature/sqlite-foundation`
HEAD: `14e9ae3c5d565d992b20908cec9f5530ffe3c9e0`

## 現在の目標

safe-copyの起動情報、管理画面の事前診断、pairing API、QR表示、端末の接続解除・再接続を、実行中ランタイム情報に基づいて安全に運用できる状態にする。本番DBは対象外とする。

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
- LAN IPv4: `192.168.1.11`
- PC管理画面: `http://127.0.0.1:25173/admin.html#/admin/devices`
- A90客席: `http://192.168.1.11:25173/customer/customer-01`
- 現在のhealth: HTTP 200、`status=ready`、`db=ready`、schemaVersion 4。
- 現在の待受: Web/APIともTCP LISTENING、同一NodeプロセスPID 8576。
- production DBは今回のsafe-copy確認対象にしていない。

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

- 既存の未コミット変更・未追跡ファイルは保持した。reset、pull、merge、commit、pushは行っていない。
- safe-copy DB、バックアップ、通常DB、runtimeログはGit indexに登録されていない。`server/var/` を`.gitignore`へ追加し、今後もGit対象外とした。
- `server/tmp/`、`*.log`、`prototype/dist/`もGit除外対象である。
- 管理tokenの保存先はリポジトリ外であり、token平文は確認出力・Git差分・DEV_STATE.mdに含めていない。

## 既知の問題・未確認事項

- A90の解除後再接続成功はユーザー報告で確認したが、その操作単体のclaim HTTP status/bodyは記録していない。QR本文やtokenを追加取得して再試行はしない。
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
