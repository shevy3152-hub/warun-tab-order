# Customer order API mode

The prototype remains in local/demo mode unless the page supplies the following runtime configuration before the app loads:

```html
<script>
  window.WARUN_ORDER_MODE = "api";
  window.WARUN_API_BASE = "http://tablet-server.local/v1"; // optional; defaults to same-origin /v1
  window.WARUN_API_TOKEN = "runtime-provided-token";
</script>
```

API mode writes an order-intent record to IndexedDB before calling `POST /v1/orders`. The record keeps the same `clientOrderId` for retries and stores only `schemaVersion`, `clientOrderId`, and `items` in the HTTP payload. A missing runtime token or base leaves the record pending and does not fall back to demo submission.

The outbox database is `warun-customer-order-outbox`, version `1`, with a single `orders` store. `created` and `replayed` responses are synced; network failures, timeouts, and 5xx responses remain pending; 4xx responses become rejected. The browser `online` event triggers a debounced flush, and retry timers use bounded exponential backoff.
