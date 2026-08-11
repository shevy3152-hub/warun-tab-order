# LAN access

The browser uses the same-origin `/v1` path. During prototype development, Vite proxies `/v1` to `WARUN_API_ORIGIN` or `http://127.0.0.1:8787`, so each tablet opens only the Web URL and does not enter an API URL.

Build the prototype and start the combined Web/API server with a database that has already been provisioned:

```powershell
cd prototype
pnpm run build
cd ../server
$env:WARUN_DB_PATH = "C:\path\to\warun.sqlite3"
node src/run-server.mjs
```

The server binds to `0.0.0.0` by default, serves the built prototype, forwards same-origin `/v1` requests to the existing HTTP server, and prints PC and LAN Web/API URLs. Set `WARUN_SERVER_HOST=127.0.0.1` only for a PC-only run. The Vite proxy remains available for development; set `WARUN_API_ORIGIN` before starting Vite to point it at a non-default local API port.

For production, serve `prototype/dist/client` and proxy `/v1` to the API server on the same origin. Reserve or fix the PC's LAN address in DHCP/router administration; this repository does not change router settings or auto-fix the PC address. Allow the selected Web/API ports through the Windows firewall for the store LAN only.

Tokens remain runtime configuration. Do not put tokens in this file, URLs, localStorage, or logs.

## Customer tablet pairing

The admin client creates a short-lived one-time code with `POST /v1/admin/pairing-codes` using its existing Bearer token. Send JSON containing `role: "customer"`, a free `tableId`, and `expiresAtMs` (60 seconds to 24 hours ahead). The admin Devices screen can issue this code as an in-memory QR image; the raw code is not rendered as text, logged, or put in a URL. Configure the admin Bearer token through the existing runtime injection (`window.WARUN_ADMIN_API_TOKEN` or `window.WARUN_RUNTIME_CONFIG.adminToken`), never localStorage.

Open the same LAN Web URL on A90. In API mode, use the A90 camera's QR reader to read the QR shown by the admin Devices screen, then paste the scanned code into the first-run registration screen with a display name. The browser generates and keeps its device ID in IndexedDB, sends the claim to `/v1/pairings/claim`, and stores the returned credential only in its IndexedDB credential store. The token is used only in the Bearer header; it is not rendered, placed in localStorage, URLs, order payloads, or logs. Reloading keeps the same device registration.

Because schema v1 has no claim ID or encrypted response-recovery field, a lost claim response cannot be safely retried with the same code. Reissue a new pairing code and revoke any orphaned device from the admin client with `POST /v1/admin/devices/revoke`. A used, expired, over-attempt, duplicate-device, or occupied-table code is rejected.

The current HTTP listener is for local verification only. Store operation requires HTTPS (including the LAN Web URL); TLS termination and certificates are outside this change.
