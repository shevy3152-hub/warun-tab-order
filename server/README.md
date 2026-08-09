# SQLite foundation

このディレクトリは、店舗内ローカルサーバー向けSQLite基盤の最小実装です。現段階ではHTTPサーバー、REST API、SSE、認証処理は実装していません。

## 実行条件

- Node.js 24以上
- Node.js標準の`node:sqlite`
- 外部パッケージおよび有料サービスは不使用

## 初期化API

```js
import { initializeDatabase } from './src/db/database.mjs';

const connection = initializeDatabase({
  databasePath: './data/warun-tab-order.sqlite3',
});

try {
  connection.database.prepare('SELECT 1').get();
} finally {
  connection.close();
}
```

初期化処理は呼び出し元のカレントディレクトリに依存せず、リポジトリの`docs/schema-v1.sql`を読み込みます。DBファイルの親ディレクトリは必要に応じて作成します。

対応するスキーマはv1だけです。

- `user_version = 0`かつユーザーテーブルなし: v1を適用
- `user_version = 1`: 必須テーブル、インデックス、トリガーと整合性を検証して再利用
- `user_version = 0`かつユーザーテーブルあり: 誤上書き防止のため拒否
- 上記以外のバージョン: Migration未実装のため拒否

接続時に`foreign_keys = ON`、`busy_timeout = 5000`、`journal_mode = WAL`、`synchronous = FULL`を設定し、実値を検証します。初期化に失敗した場合はDB接続を閉じてからエラーを返します。

## テスト

```powershell
cd server
node --test
```

テストはすべてOSの一時ディレクトリに専用の実ファイルDBを作成し、終了時に削除します。実顧客情報や実注文情報は使用しません。

`data/`と`tmp/`はローカル実行用であり、Gitの追跡対象外です。
