# SQLite foundation

このディレクトリは、店舗内ローカルサーバー向けSQLite基盤の最小実装です。端末トークン認証、role別の読み取り、冪等な注文POST、event replay、SSE通知、snapshot再同期を含みます。管理更新、ペアリング、客席側のオフラインキューは実装していません。

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

外部通知は、`createOrder`が`created`を返した後にだけ呼び出し側が実行します。HTTP層はコミット済みevent IDでSSE hubを起床し、hubは`event_log`を再読込します。通知失敗で注文コミットを取り消したり、客席へ注文失敗を返したりしません。`replayed`では新しいイベントと通知を作りません。

repositoryへ渡したDB接続の所有権は呼び出し側にあります。`repository.close()`はrepositoryの再利用を禁止しますが、DB接続は閉じません。DB接続は`initializeDatabase()`が返す`close()`で呼び出し側が閉じます。

注文POSTのHTTPルートとSSEは後述の試験用HTTP基盤で実装しています。客席側IndexedDBと再送キューは未実装です。自動テストでは2つのworker threadと2つのSQLite接続から同じ実ファイルDBへ同時注文を送り、最終的に`created` 1件と`replayed` 1件へ収束することを確認しています。本番端末・長時間・高負荷条件の並列負荷試験は未実施です。

## 端末トークン認証層

`src/auth/device-auth.mjs`は、端末だけが保持する生トークンからDB上の端末principalを取得するread-only認証層です。生トークンは256-bitの乱数をpaddingなしbase64urlで表したcanonicalな43文字とし、前後空白を自動除去しません。

```js
import {
  authorizeDeviceRole,
  createDeviceAuthenticator,
} from './src/auth/device-auth.mjs';

const authenticator = createDeviceAuthenticator({ database: connection.database });
const principal = authenticator.authenticateDeviceToken(rawToken);
authorizeDeviceRole(principal, ['customer']);
```

DBには生トークンを保存せず、canonical base64url文字列のUTF-8バイト列をSHA-256で計算した小文字hexだけを`devices.token_hash`へ保存します。認証層は入力トークンを同じ方法でhash化し、prepared statementで検索します。principalの`deviceId`、`role`、`deviceLabel`、割り当て済みの場合の`tableId`はすべてDBから生成され、凍結されます。生トークンとtoken hashはprincipal、エラー、ログへ含めません。

roleは`customer`、`kitchen`、`admin`の完全一致で判定します。暗黙の階層や継承はなく、adminであっても`['customer']`の操作は許可されません。各操作がallow-listを明示します。

認証成功・失敗のどちらでも`last_seen_at_ms`や更新日時を書き換えません。lastSeen更新、監査ログ、token発行・ローテーション・失効API、ペアリングコード消費は別機能です。失効済み端末やhash変更前の旧トークンは、未登録トークンと同じ`AUTHENTICATION_FAILED`として扱います。

注文作成への接続境界は次のとおりです。

1. HTTP層がAuthorizationヘッダーから生トークンを取り出す
2. 認証層がprincipalを生成し、`authorizeDeviceRole(principal, ['customer'])`を実行する
3. `principal.deviceId`だけを注文repositoryの`authenticatedDeviceId`へ渡す
4. リクエストbodyのdeviceId、role、tableId、fingerprintは受け付けない

`authenticator.close()`はauthenticatorの再利用を禁止しますが、呼び出し側所有のDB接続は閉じません。

HTTPS証明書配布、ペアリング、token発行・更新は未実装です。Authorizationヘッダーの解析は後述のread-only HTTP基盤だけが実装しています。

## 端末設定・メニュー読み取り層

`src/catalog/catalog-repository.mjs`は、端末トークン認証層が発行したprincipalだけを受け取り、最新の端末設定とrole別メニューをSQLiteから読み取ります。通常のオブジェクトで偽造したprincipal、失効後の端末、無効な客席割り当ては拒否します。principal内の古いroleやtableIdを正本にせず、`principal.deviceId`を検索キーとして現在のDB状態を再取得します。

authenticatorとcatalog repositoryは、同じローカルサーバープロセスの同じ正本DBに対して生成してください。現在のprincipal発行印はDB識別子までは保持しないため、複数の異なる店舗DBを一つのプロセスで扱う構成は未対応です。

```js
import { createCatalogRepository } from './src/catalog/catalog-repository.mjs';

const catalog = createCatalogRepository({ database: connection.database });
const settings = catalog.getDeviceSettings(principal);
const menu = catalog.getMenuForPrincipal(principal);
```

公開範囲はroleごとに分離します。

- `customer`: 表示中カテゴリと表示中商品、正式名、説明、売り切れ状態、表示順を返す。価格、厨房通称、非表示項目は返さない
- `kitchen`: 表示中カテゴリと表示中商品、正式名、厨房通称、売り切れ状態、表示順を返す。価格と非表示項目は返さない
- `admin`: 全カテゴリと全商品、正式名、厨房通称、価格、売り切れ、表示状態、表示順、versionを返す

売り切れ商品は`customer`と`kitchen`の一覧にも`isSoldOut: true`で残します。ただし表示は注文可否の正本ではなく、新規注文時には注文repositoryが現在の売り切れ状態を再検証して拒否します。

端末・テーブル、カテゴリ、商品、event cursorは短いread transactionで取得します。カテゴリと商品は同じDBスナップショットに属し、結果は安定した明示順で並べ、返却オブジェクトと配列を再帰的に凍結します。読み取りによって`last_seen_at_ms`、更新日時、`event_log`、その他のDB行は変更しません。

catalog repositoryへ渡したDB接続の所有権は呼び出し側にあります。`catalog.close()`はrepositoryの再利用を禁止しますが、DB接続は閉じません。

この返却値はHTTPへ公開する前のrole別内部DTOです。HTTP層はDB行や内部DTOをそのままJSON化せず、OpenAPIで分離したcustomer、kitchen、admin用schemaへ許可フィールドだけを明示変換します。

ETagとSSE更新通知は未実装です。

## 認証付きHTTP・イベント基盤

`src/http/http-server.mjs`はNode.js標準の`node:http`だけを使う試験用HTTP server factoryです。次の操作を実装しています。

- `GET /v1/health`: 認証不要のreadiness確認。schema versionとevent epochを読めた場合だけ`200`、DBが受付不能なら`503`
- `GET /v1/device/config`: DB最新状態のrole別端末設定
- `GET /v1/menu`: role別メニュー
- `POST /v1/orders`: customerだけが使える冪等な注文作成
- `GET /v1/events/replay`: 欠落イベントのrole別JSON replay
- `GET /v1/events`: role別SSE stream
- `GET /v1/snapshot`: event履歴を継続できない場合のrole別再同期状態

```js
import { createDeviceAuthenticator } from './src/auth/device-auth.mjs';
import { createCatalogRepository } from './src/catalog/catalog-repository.mjs';
import { createEventRepository } from './src/events/event-repository.mjs';
import { createSnapshotService } from './src/events/snapshot-service.mjs';
import { createSseHub } from './src/events/sse-hub.mjs';
import { createHttpServer } from './src/http/http-server.mjs';
import { createOrderRepository } from './src/orders/order-repository.mjs';

const authenticator = createDeviceAuthenticator({ database: connection.database });
const catalog = createCatalogRepository({ database: connection.database });
const orderRepository = createOrderRepository({ database: connection.database });
const eventRepository = createEventRepository({ database: connection.database });
const snapshotService = createSnapshotService({ catalog, eventRepository });
const sseHub = createSseHub({ eventRepository });
const server = createHttpServer({
  database: connection.database,
  authenticator,
  catalog,
  orderRepository,
  eventRepository,
  snapshotService,
  sseHub,
});

server.listen(0, '127.0.0.1');
```

既存の3つのGETだけを使う検証向けに`createReadOnlyHttpServer`も残しています。このlegacy factoryは注文・event・snapshot routeを登録しません。統合済み`createHttpServer`は全serviceの注入を構築時に検証するため、必須routeが500になる状態でhealthだけ`ready`を返す構成を許可しません。

### 認証と共通レスポンス

認証対象routeは`Authorization: Bearer <token>`だけを資格情報として使用します。schemeは大文字・小文字を区別せず、token本体は加工せず大文字・小文字を区別します。tokenをURL/query、cookie、request bodyから取得しません。重複Authorization、カンマ結合値、Bearer以外、不正な空白形式は同じ汎用`401`として拒否し、生tokenやhashをレスポンス・例外へ含めません。Node.jsのHTTP parserがfield-value外側の正規なOWSを除去した後は、アプリ層から元の外側OWSを識別できない点は標準parserの境界です。

全JSON応答は`application/json; charset=utf-8`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`を設定し、サーバー生成UUIDのrequest IDを付けます。対象pathは完全一致で、trailing slashは別pathとして`404`です。既知pathの未対応methodは`405`と正しい`Allow`を返します。queryやbodyのrole、deviceId、tableIdは認証・認可に使用しません。

role別の公開範囲は次のとおりです。

- customer: 現在テーブルを返す。メニューに価格と厨房通称を含めない
- kitchen: 固定テーブル情報を返さない。メニューに厨房通称を含めるが価格は含めない
- admin: 固定テーブル情報を返さない。管理に必要な価格、表示状態、versionを含める

どのroleにも生token、token hash、pairing情報を返しません。

### 注文POST

注文bodyは`application/json`（任意のcharset指定はUTF-8だけ）、最大16 KiBです。重複JSON key、不正UTF-8、不正JSON、未知field、server管理fieldを拒否します。受け付ける注文意図は`schemaVersion`、`clientOrderId`、任意の`clientCreatedAtMs`、`menuItemId`と`quantity`だけです。bodyのdeviceId、role、tableId、価格、合計、fingerprintは受け付けず、HTTP認証で得た`principal.deviceId`だけを注文repositoryへ渡します。

新規コミットは`201`と`Idempotency-Result: created`、同じ注文意図の再送は`200`と`Idempotency-Result: replayed`です。同じIDで異なる注文意図は`409`、売り切れ・存在しない商品は`422`です。customer向けreceiptには価格、合計、テーブル、fingerprint、内部明細を含めません。応答消失時も同じ`clientOrderId`で再送し、保存済み注文を取得します。HTTP応答の成否だけから別IDの注文を作らないでください。

SQLiteの短期的な書き込みロックは`503 SERVICE_UNAVAILABLE`と`Retry-After`へ変換します。内部SQL、SQLiteエラー全文、stack traceは返しません。

### SSE、replay、snapshot

`event_log`が永続的な正本で、live通知はコミット済みevent IDを伝える起床信号です。hubは通知のpayloadを信用せずDBを再読込し、raw `payload_json`を公開しません。外部イベントはroleごとの可視性を確認した上で、`orders`、`menu`、`staffCalls`、`deviceConfig`の再取得を指示する安全なinvalidationへ変換します。customerは自端末の注文・スタッフ呼び出しだけ、kitchenは店舗業務イベント、adminは管理イベントを受け取ります。

初回同期は次の順です。

1. `GET /v1/snapshot`でrole別状態と`eventEpoch`、`lastEventId`を取得
2. `Last-Event-ID`と`X-Event-Epoch`を必ずペアで付けて`GET /v1/events`へ接続
3. 切断後も同じcursorで再接続し、DB replay後にliveへ移行

cursor headerを両方省略したSSE接続は現在tailからliveだけを受信し、過去状態は復元しません。Bearer headerが必要なので、query tokenへフォールバックするnative `EventSource`ではなくfetch streaming clientを前提とします。不可視イベントでもid-only frameでcursorを進めます。heartbeat、接続最大時間、接続単位FIFO、queue上限を持ち、遅い接続だけを切断します。切断後はDB replayで回復でき、遅い1台が他端末を停止させません。

epoch不一致、未来cursor、または現在epochからcursor行が失われている場合は`410 EVENT_HISTORY_UNAVAILABLE`とsnapshot URL・現在cursorを返します。クライアントは旧cacheを破棄してsnapshotを取り直します。snapshotはdevice、menu、厨房・管理用active ordersとopen staff callsが同じ論理cursorになるまで有界回数だけ再取得します。

schema v1では`event_log`を削除・pruneしません。cursor行の欠落とepoch変更は検出できますが、DB破損などによる任意の中間1行だけの削除を完全検出するretention watermarkはありません。正式な保持期限を導入する場合は、連続prefix削除とretention floorを別Migrationで設計します。

### 所有権と未実装範囲

HTTP serverの`close()`はSSE hubのtimer・streamを先に終了してlistenerを閉じます。注入されたauthenticator、catalog、order/event repository、snapshot service、SQLite接続は閉じません。終了時はserver、各repository・authenticator、最後にDBの順で呼び出し側が閉じます。

クライアントと同一originで配信する前提であり、broad CORSや`Access-Control-Allow-Origin: *`は実装しません。HTTPS、客席IndexedDB送信待ち、管理更新、提供済み更新、スタッフ呼び出しPOST、ペアリング、token更新、Windows service化、React接続は未実装です。このHTTP基盤はローカル統合試験用であり、現段階のまま本番公開またはインターネット公開してはいけません。

### Pending device registration (schema v2)

Customer tablets should normally open `/pairing.html`. The page creates one random registration request and retains its request secret only in IndexedDB. The admin Devices screen lists pending requests; an administrator must select an available table and explicitly approve the request. The tablet polls the request status, claims it once after approval, stores the returned credential in IndexedDB, and then enters customer API mode.

The server persists only the request-secret hash. The request status and admin list never include the secret, and a successful claim returns the device token once only. Table availability is checked inside the approval/claim transaction. The existing pairing-code endpoints remain supported for recovery and backward compatibility.

The request-and-approve API is documented in `docs/openapi-v1.yaml` under `/v1/registration-requests` and `/v1/admin/registration-requests`. Do not copy request secrets, pairing codes, device tokens, or order payloads into URLs, logs, screenshots, or support messages. Plain HTTP is for local verification only; store operation requires HTTPS.
