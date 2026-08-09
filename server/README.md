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

## 注文保存層

`src/orders/order-repository.mjs`は、認証済み客席端末から渡された注文意図をSQLiteへ保存するDBアクセス層です。HTTP、認証トークン検証、RESTルーティングは担当しません。

```js
import { createOrderRepository } from './src/orders/order-repository.mjs';

const repository = createOrderRepository({
  database: connection.database,
  now: () => Date.now(),
  idFactory: () => crypto.randomUUID(),
});

const result = repository.createOrder({
  clientOrderId,
  authenticatedDeviceId,
  items: [{ menuItemId: 'edamame', quantity: 1 }],
});
```

`now`はUTC Unix epoch millisecondsを返し、`idFactory`はUUID v4を返します。どちらも省略可能で、テストでは決定的な値を注入できます。

注文保存層の責務は次のとおりです。

- サーバー側の端末・役割・有効状態・固定テーブル割り当てを検証する
- 現在のメニュー、売り切れ、整数円単価を検証する
- 正式名、厨房通称、単価、数量、テーブル番号を注文時点でスナップショット保存する
- `orders`、全`order_items`、1件の`order.created`イベントを短い`BEGIN IMMEDIATE`トランザクションで一括保存する
- 途中失敗時は全書き込みをロールバックする

返却値の`idempotencyResult`は次の意味です。

- `created`: 新規注文、全明細、イベントがコミットされた
- `replayed`: 同じ`clientOrderId`、同じ端末、同じ注文意図の保存済み注文を返した。DB行やイベントは追加していない
- conflict: 返却値ではなく、安定コード`ORDER_CONFLICT`を持つ`OrderRepositoryError`を送出する。保存済み注文は変更しない

fingerprintはクライアント値を使用せず、次の固定キー順・空白なしUTF-8 JSONをサーバーがSHA-256へ入力します。品目は`menuItemId`の昇順です。

```json
{"fingerprintVersion":1,"authenticatedDeviceId":"<device UUID>","items":[{"menuItemId":"<id>","quantity":1}]}
```

価格、商品名、厨房通称、テーブル番号、売り切れ、時刻、eventId、自動生成IDはfingerprintに含めません。このため初回コミット後にこれらが変更されても、同一注文意図の再送は現在状態を再評価せず、保存済みスナップショットを返します。結果不明の再送を二重注文にしないための動作です。

外部通知は、`createOrder`が`created`を返した後に呼び出し側が実行できます。DBコミット前の通知は禁止です。この段階ではSSE配信自体を実装していません。

repositoryへ渡したDB接続の所有権は呼び出し側にあります。`repository.close()`はrepositoryの再利用を禁止しますが、DB接続は閉じません。DB接続は`initializeDatabase()`が返す`close()`で呼び出し側が閉じます。

HTTP、RESTルート、SSE、認証ミドルウェア、IndexedDBは未実装です。自動テストでは2つのworker threadと2つのSQLite接続から同じ実ファイルDBへ同時注文を送り、最終的に`created` 1件と`replayed` 1件へ収束することを確認しています。本番端末・長時間・高負荷条件の並列負荷試験は未実施です。
