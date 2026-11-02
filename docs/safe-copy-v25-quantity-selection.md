# 数量選択 schema25 safe-copy launcher

## 保守元と配置

- 正式な保守元はGit管理の `server/start-safe-copy.ps1` と `server/open-admin.ps1`。起動元は同じリポジトリの `server/test/safe-copy-launcher.test.mjs`。
- v24用ファイルは変更せず、今回追加する `server/start-safe-copy-v25.ps1` と `server/open-admin-v25.ps1` をv25専用の入口とする。v24版とv25版は同じrelease rootへ混在させず、将来配置時もv25専用のversioned release rootへ置く。
- 外部の `%LOCALAPPDATA%\WarunTabOrder\safe-copy\open-admin.ps1` はrelease rootを指す運用コピーであり、今回変更しない。v25を稼働候補へ切り替える許可を得た後、その入口の切替・保全を別途計画する。
- 通常運用のv24/v25 entryは共通の `%LOCALAPPDATA%\WarunTabOrder\safe-copy` token/runtime/log rootと画像保存先を使う。safe-copyは単一稼働を前提とし、v24を正式launcherで停止してPID・両port・runtime-state消失を確認した後にv25を起動する。入口はruntime-stateのDB/WebRoot・PID・両port・health identityが選択中rootと一致しなければ管理画面を開かない。

## 起動とmigration責任

- v25 entry `server/open-admin-v25.ps1` は同じrelease内の `server/start-safe-copy-v25.ps1` を呼ぶ。通常ポートはWeb 25173/API 28787、WebRootは同じrelease内の `prototype/dist/client`、DBは同じrelease内の `server/var/safe-copies/initial-menu-20260818.sqlite3`。
- v25 launcherの `-Action start` は指定RuntimeRoot内のsafe-copy kitchen tokenを `--token-file` 引数で `check` のみ検証する。`--token-file` はCLI内部の `tokenFile` に正規化し、別RuntimeRootの隔離起動でもグローバルtoken pathへフォールバックしない。`ensure` によるDB初期化やtoken再発行を起動前に行わず、token checkはSQLite read-only接続。
- SQLite migrationの唯一の更新経路はbackendの `initializeDatabase`。`run-server.mjs` の起動で `PRAGMA user_version=24` のDBにschema-v25 migration SQLをtransactionで適用し、commit後にuser_versionを25へ進める。候補のmigration-reference SQLを手実行しない。起動を1回だけ行い、2回目の初期化はuser_version 25を読みmigrationを再適用しない。
- `system_state.schema_version` はevent metadataの別系列として既存値を維持し、`PRAGMA user_version` と手作業で揃えない。
- 起動時に既存schema24 runtimeが同じruntime-state/portsを占有していれば、v25 launcherは自動停止・migrationせず拒否する。既存v24サービスはそのv24 release launcherから停止し、状態を再確認してから別releaseへ移る。

## release切替・復帰の考え方

- 稼働許可が得られた場合にだけ、既存の正式保全手順で現行SQLiteの整合snapshotと資材を保全し、v25専用release rootへ別DBコピーを用意する。v24 releaseとそのDBは保持する。
- v25 rootへWeb/backend/versioned launcherを配置し、外部共通入口をv25 entryへ切り替える。v25起動後health・DB schema・整合性・静的SHAを照合する。これらの稼働操作は今回の候補準備には含まれない。
- v25 DBへ業務更新がないことを確認できる起動失敗時だけ、v25 launcherで対象PIDを停止し、v24入口と元DBへ戻す。v25で注文等が発生したか不明、または業務更新がある場合は、v25 DB/WAL/SHMを保持して単純復帰しない。

## 隔離起動

- 隔離確認ではfixture DB、WebRoot、RuntimeRoot、作業root、ポートを個別に指定し、`-BindHost 127.0.0.1` で起動する。PowerShell実行環境の `LOCALAPPDATA` を専用run rootへ向け、`WARUN_PRODUCT_IMAGE_STORAGE_PATH` と `WARUN_CUSTOMER_THEME_IMAGE_STORAGE_PATH` もrun root配下へ個別指定する。fixtureはschema24 migration sourceから作り、稼働DB/token/画像保存先を使わない。
- 起動・GET確認後は同じversioned launcherの `-Action stop` で隔離PIDだけを停止し、fixtureとログは削除せず場所・SHA・停止状態を記録する。
