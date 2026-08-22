# 居酒屋注文システム・クリック可能プロトタイプ

小規模ワンオペ居酒屋向けの、客席タブレット4台＋キッチン端末1台を想定したフロントエンドプロトタイプです。

## 起動

```powershell
pnpm install
pnpm run dev
```

表示されたローカルURLをブラウザで開くと、端末ランチャーが表示されます。

## 確認できるフロー

1. 客席タブレットを開き、商品を追加して注文を送信する
2. キッチン画面で未提供品をチェックする
3. 最後の品目をチェックすると注文が提供済み履歴へ移動する
4. 管理画面で価格・売り切れ・カテゴリ・端末割り当てを変更する
5. 端末ランチャーで通信断を再現し、送信待ち保存と再接続後の再送を確認する

ブラウザ内のデータは `localStorage` に保存され、同じブラウザの別タブ間では自動同期されます。実機間通信や本番バックエンドは含みません。

## 主な画面

- `#/`：端末ランチャー
- `#/customer/customer-01`：客席タブレット
- `#/kitchen`：キッチン
- `#/history`：提供済み履歴
- `#/admin/menu`：管理画面

## 検証

```powershell
pnpm run build
pnpm run test:sites
```

視覚検証の記録は `design-qa.md` を参照してください。

Typography / visual fidelity rules are documented in [`DESIGN_SYSTEM.md`](./DESIGN_SYSTEM.md).

## 客席注文APIをA90から接続する実行時設定

`src/order-outbox.js` は、ページ起動時の `window` 設定だけを読み取ります。既定はdemo modeです。API接続を使う場合は、アプリのmodule scriptより前に、実行環境で次を注入してください。

```html
<script>
  window.WARUN_ORDER_MODE = "api";
  window.WARUN_API_BASE = "http://<PCのLAN IP>:<APIポート>/v1";
  window.WARUN_API_TOKEN = runtimeProvidedToken;
</script>
<script type="module" src="/src/main.jsx"></script>
```

`runtimeProvidedToken` は起動時に安全な実行環境から注入する値です。tokenをこのソースへ書き込んだり、URL・localStorage・ログへ保存したりしないでください。互換設定として `window.WARUN_RUNTIME_CONFIG.apiToken` も読み取れます。

APIの送信先は、`window.WARUN_API_BASE` があればその値を使い、なければ同一originの `/v1` を使います。注文POSTの最終URLは、設定値の末尾へ `/orders` を付けた `<base>/orders`（通常は `/v1/orders`）です。APIモードでtokenまたはbaseが未設定の場合は、demoへ切り替えず送信待ちになります。

### A90での接続例

1. PCとA90を同じ店舗LAN／Wi-Fiへ接続し、PCで `ipconfig` を実行して、A90から到達できるIPv4アドレスを確認します（例: `192.168.1.23`）。
2. PCのWeb画面をA90から `http://192.168.1.23:<Webポート>/` で開きます。`localhost` と `127.0.0.1` はA90自身を指すため使用しません。
3. 上記の `WARUN_API_BASE` を `http://192.168.1.23:<APIポート>/v1` に設定します。PC側APIがWeb画面と同じoriginで `/v1` を提供する場合は、明示設定を省略して同一origin既定値も使えます。
4. PC側のWeb／APIポートがLANインターフェースで待ち受け、Windowsファイアウォールで店舗LANからの接続を許可していることを確認します。A90から `http://192.168.1.23:<APIポート>/v1/health` が到達できることを先に確認してください。

例としてPCのLAN IPが `192.168.1.23`、APIポートが `8787` の場合は、実行時設定のbaseだけを次のようにします。

```js
window.WARUN_ORDER_MODE = "api";
window.WARUN_API_BASE = "http://192.168.1.23:8787/v1";
// tokenは固定値を書かず、runtimeProvidedTokenへ実行時に注入する。
window.WARUN_API_TOKEN = runtimeProvidedToken;
```
