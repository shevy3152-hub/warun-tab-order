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

The admin client creates a short-lived one-time code with `POST /v1/admin/pairing-codes` using its existing Bearer token. Send JSON containing `role: "customer"`, a free `tableId`, and `expiresAtMs` (60 seconds to 24 hours ahead). The admin Devices screen issues a standard QR image whose payload is the LAN `pairing.html#p=<code>` URL fragment; the raw code is not rendered as text or logged. Configure the admin Bearer token through the existing runtime injection (`window.WARUN_ADMIN_API_TOKEN` or `window.WARUN_RUNTIME_CONFIG.adminToken`), never localStorage.

Open the same LAN Web URL on A90. In API mode, use the A90 camera's QR reader to read the QR shown by the admin Devices screen; the `pairing.html` page opens and pre-fills the one-time code from the URL fragment, so only the display name needs confirmation before registration. The browser generates and keeps its device ID in IndexedDB, sends the claim to `/v1/pairings/claim`, and stores the returned credential only in its IndexedDB credential store. The admin token is used only in the Bearer header; it is not rendered, placed in localStorage, QR payloads, order payloads, or logs. Reloading keeps the same device registration.

Because schema v1 has no claim ID or encrypted response-recovery field, a lost claim response cannot be safely retried with the same code. Reissue a new pairing code and revoke any orphaned device from the admin client with `POST /v1/admin/devices/revoke`. A used, expired, over-attempt, duplicate-device, or occupied-table code is rejected.

The current HTTP listener is for local verification only. Store operation requires HTTPS (including the LAN Web URL); TLS termination and certificates are outside this change.

## Staff HTML is local to the store PC

Management and kitchen use the same Windows PC that runs the server; the kitchen
monitor is a video output, not a separate network client. Open
`http://127.0.0.1:<WebPort>/admin.html#/admin/devices` for management and
`http://127.0.0.1:<WebPort>/admin.html#/kitchen` for the kitchen. The worktree's
Windows launcher uses these local staff URLs. The safe-copy launcher already uses
a local URL. An existing staff bookmark using the PC's LAN address must change.

The combined server requires a loopback TCP peer (IPv4 127/8, IPv6 ::1, or an
IPv4-mapped IPv6 loopback) before serving staff entries. It also requires a single
Host containing a literal loopback address or exactly localhost, with this Web
listener's port, to reject DNS rebinding via arbitrary hostnames. Forwarded, Origin
and X-Forwarded-For headers do not establish permission. Denials are generic and
do not read HTML or construct the staff runtime configuration.

Only the exact /admin.html request target receives staff credentials. Staff path
aliases, case and encoded variants are also subject to the local boundary;
noncanonical paths that normalize to /admin.html are rejected. Public index.html,
customer/pairing SPA fallbacks and shared scripts contain no server-injected staff
credentials, including when a browser adds a staff route in its URL fragment.

Customer HTML, pairing, same-origin /v1 APIs, SSE and images remain LAN accessible;
existing API device authentication and role authorization remain in place. The
guard applies in development, safe-copy and production modes of run-server.mjs.
Vite development/preview and the Sites worker serve tokenless frontend assets;
the configured Vite proxy forwards only /v1 to the API listener, not staff HTML.

Do not expose the staff endpoint through a LAN-facing proxy or TCP forwarder
which reconnects from loopback and supplies a local Host. That would cross the
trusted boundary and must be denied at the proxy/forwarder as well. No staff HTML
proxy is configured by these repository launchers; externally configured proxies
and Windows port-forwarding rules need separate deployment review.
