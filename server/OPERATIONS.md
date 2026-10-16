# Warun operational runbook

## Startup

Production startup requires `WARUN_ENV=production`, `WARUN_DB_PATH`, and `WARUN_WEB_ROOT`. Both paths must be absolute and outside the repository. The server refuses missing or relative production paths. Development-only relative defaults must not be used for store data.

`WARUN_PRODUCT_IMAGE_STORAGE_PATH` is optional for startup and read-only image URI serving. If it is unset, image uploads are unavailable and return HTTP 503 with a configuration message; existing order, kitchen, and menu image URI routes remain available. When configured, use an absolute writable directory outside the release tree, `prototype/public`, and `prototype/dist`. The repository safe-copy launcher preserves an explicitly supplied value or defaults it to `%LOCALAPPDATA%\WarunTabOrder\product-images`. QA launchers should use their own isolated image directory when exercising uploads; they do not inherit the safe-copy launcher's LocalAppData default.

Keep `node src/run-server.mjs` in the foreground and stop it with `Ctrl+C`. The startup output contains only PC/LAN URLs; never place tokens, credentials, pairing codes, or order payloads in logs.

Plain HTTP is for local verification only. Store operation requires HTTPS and an appropriate certificate.

## SQLite backup and restore

Quiesce the server before a file-level backup, or use SQLite's online backup mechanism. When WAL mode is active, do not copy only the main database file; preserve the database together with its WAL/SHM state or create a consistent online backup.

Restore into an isolated path first and verify:

- `PRAGMA integrity_check` returns `ok`.
- `PRAGMA user_version` is `2` after the v1-to-v2 additive migration.
- `orders`, `order_items`, and `event_log` counts match the backup manifest.
- A read-only server check can load kitchen snapshot and completed history.

Only after these checks should the operational database be replaced. Keep at least one prior known-good backup and record verification metadata without storing secrets or customer order contents.
