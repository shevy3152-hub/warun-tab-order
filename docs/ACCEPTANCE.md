# Automated P0 acceptance

検証日: 2026-08-12

## Scope

This acceptance uses a temporary SQLite database created by the test process. It does not connect to `server/var/warun.sqlite3`, a production database, A90, or a pairing flow.

## Result

- Credential-first customer bootstrap selects API mode when an IndexedDB credential is present.
- Missing credentials do not silently select demo mode.
- One customer order returns `created` and persists exactly one row in `orders`, one row in `order_items`, and one `order.created` row in `event_log`.
- Re-sending the same intent with the same client order ID returns `replayed` and does not add rows.
- Kitchen snapshot exposes the active order; serving its item changes the order to `completed` and appends the completion event.
- Admin order history returns the completed order.
- Reload-equivalent bootstrap selects API mode again and performs no additional order POST when the outbox is empty.
- API customer order display stays in memory and does not write demo orders to `localStorage`.

## Commands

- `node --test` in `prototype/`: 33/33 passed.
- `node --test` in `server/`: 315/315 passed.
- Direct Vite build: passed.
- Sites worker tests: included in the prototype suite and passed.
- `git diff --check`: required to pass before commit.

No token, credential, pairing code, or order payload is recorded in this document.
