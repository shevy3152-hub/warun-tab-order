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
