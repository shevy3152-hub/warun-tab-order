# Warun operational runbook

## Startup

Production startup requires `WARUN_ENV=production`, `WARUN_DB_PATH`, and `WARUN_WEB_ROOT`. Both paths must be absolute and outside the repository. The server refuses missing or relative production paths. Development-only relative defaults must not be used for store data.

Keep `node src/run-server.mjs` in the foreground and stop it with `Ctrl+C`. The startup output contains only PC/LAN URLs; never place tokens, credentials, pairing codes, or order payloads in logs.

Plain HTTP is for local verification only. Store operation requires HTTPS and an appropriate certificate.

## SQLite backup and restore

Quiesce the server before a file-level backup, or use SQLite's online backup mechanism. When WAL mode is active, do not copy only the main database file; preserve the database together with its WAL/SHM state or create a consistent online backup.

Restore into an isolated path first and verify:

- `PRAGMA integrity_check` returns `ok`.
- `PRAGMA user_version` is `2`.
- `orders`, `order_items`, and `event_log` counts match the backup manifest.
- A read-only server check can load kitchen snapshot and completed history.

## Browser device registration

The preferred customer registration flow is request-and-approve: open `/pairing.html` on the tablet, then use the admin Devices screen to select an available table and explicitly approve the pending request. The tablet polls with its IndexedDB-held request secret and claims exactly once after approval. The server stores only the request-secret hash and returns the device token only in the successful claim response.

The legacy pairing-code endpoints remain available for controlled recovery. Do not place request secrets, pairing codes, or device tokens in URLs, logs, screenshots, localStorage, or order payloads. Pairing and registration are intended for HTTPS in store operation; plain HTTP is local verification only.

If a successful claim response is lost after the server commits the device, do not automatically retry or reissue a token. Revoke the affected device through the admin flow and create a new registration request; the stored token hash cannot recover the raw token.

Only after these checks should the operational database be replaced. Keep at least one prior known-good backup and record verification metadata without storing secrets or customer order contents.
