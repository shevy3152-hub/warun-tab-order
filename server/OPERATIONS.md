# Warun operational runbook

## Startup

Production startup requires `WARUN_ENV=production`, `WARUN_DB_PATH`, and `WARUN_WEB_ROOT`. Both paths must be absolute and outside the repository. The server refuses missing or relative production paths. Development-only relative defaults must not be used for store data.

Keep `node src/run-server.mjs` in the foreground and stop it with `Ctrl+C`. The startup output contains only PC/LAN URLs; never place tokens, credentials, pairing codes, or order payloads in logs.

Plain HTTP is for local verification only. Store operation requires HTTPS and an appropriate certificate.

## SQLite backup and restore

Quiesce the server before a file-level backup, or use SQLite's online backup mechanism. When WAL mode is active, do not copy only the main database file; preserve the database together with its WAL/SHM state or create a consistent online backup.

Restore into an isolated path first and verify:

- `PRAGMA integrity_check` returns `ok`.
- `PRAGMA user_version` is `1`.
- `orders`, `order_items`, and `event_log` counts match the backup manifest.
- A read-only server check can load kitchen snapshot and completed history.

Only after these checks should the operational database be replaced. Keep at least one prior known-good backup and record verification metadata without storing secrets or customer order contents.
