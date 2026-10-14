# スタッフ呼出対応 safe-copy 反映手順（準備）

この手順書は未実行。運用safe-copy・既存QA・端末・設定には触れていない。

## 一体で扱う成果物

- 同一リリースから取得した `server/` と `prototype/dist/client/` を一組にする。異なるビルドや既存 `dist` を混ぜない。
- backend の `SCHEMA_VERSION`、`docs/schema-v22-migration.sql`、`server/start-safe-copy.ps1`、`server/open-admin.ps1` の目標はすべて v22。
- DBはv21からv22へ初回起動時にmigrationされる。v22 DBにはv22対応backendとWebを組み合わせる。
- staff callの `table_session_id` は追加列。既存staff callは履歴を保ち、由来を推定できないためNULLのまま。新規callのみ現在のopen sessionへ結び付く。

## バックアップと切替

1. 切替前に現在のsafe-copy起動スクリプトでruntime identity、Web/API、DBパス、health/schemaを照合する。別プロセスや別DBと一致しない場合は中止する。
2. 現行v21リリースで、稼働中DBを扱う既存のbackup操作を使って一意な日時付きバックアップを作る。バックアップ先はDBと別パスとし、サイズ・SHA-256・SQLite `integrity_check` を確認する。バックアップには認証情報を出力しない。
3. 旧ランチャーとDBを保持したまま、新しい一意なrelease directoryへv22 backendと同じビルドのWeb成果物を配置する。旧releaseや旧DBを上書きしない。
4. 新しいreleaseの `server/var/safe-copies/` 内に切替元DBのオフラインコピーを置く。コピー前に現行serverを旧releaseの `start-safe-copy.ps1 -Action stop` で停止し、両portの解放を確認する。WALが残る稼働中DBを単純コピーしない。
5. 新releaseのserver root、コピーDB、同releaseの `prototype/dist/client` を指定して `start-safe-copy.ps1` を起動する。v22 migrationはSQLite transactionで実行され、既存call行を再構築・削除しない。healthがready/schemaVersion 22、DB identity・Web root・process identityが要求値と一致することを確認する。
6. 客席/厨房の認証済み画面、呼出の表示・音・対応済み、注文画面の既存動作を限定確認し、ログにtokenやrequest bodyがないことを確認する。

## 切戻し条件

- 起動・migration失敗時は運用案内に従い停止し、旧v21 releaseと変更されていない旧DBを保持する。migration済みv22 DBをv21 backendで開かない。
- v22稼働後に注文、staff call、会計、セッションなどのDB更新が1件でもあれば、v21 backupへの単純な切戻しは禁止。新DBの更新を失うためである。まずv22上での修正を優先し、必要なら更新内容の照合・移送と復旧判断を別途行う。
- v21 DBへ戻せるのは、v22切替後に業務更新が一切なく、停止後のDBとバックアップの同一性を確認できる場合に限る。その場合もv22 DBは消さず隔離保管し、旧releaseと旧DBを組で戻す。
- この作業では切替、migration、停止、切戻しを実行しない。

## 起動前チェック

- `server/src/db/database.mjs` の `SCHEMA_VERSION` と両PowerShell launcherの `$TargetSchemaVersion` が22。
- `server/start-safe-copy.ps1` は既存v21 runtimeを自動停止・移行せず、migrationが必要なら明示的に中止する。
- backend root、Web root、DBが同一候補release/DB組を指す。healthの `schemaVersion`、runtime identity、DB identity、portの所有processを照合する。
- v22 DBが運用に使われた後は、v21 DBの使用を再開する前に未反映更新の扱いを決める。
