# Schema v23 migration and recovery

Schema v23 adds nullable `menu_items.archived_at_ms` and an index for the administrator-only archived product list. The v22-to-v23 migration is additive: existing products remain in place with `archived_at_ms = NULL`; order history and image files are not changed.

## Recovery after migration

- Before starting v23, make and verify a separate database backup using the existing database backup procedure. Keep the v22 release and backup together.
- If v23 has started and **no database writes have occurred since the upgrade**, stop the service, preserve the current v23 database as evidence, and restore the verified v22 backup together with the v22 release. Check `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, and the expected product/order counts before restarting.
- If any v23 database write has occurred, do not restore the older v22 database as a simple rollback. It would lose writes made since the backup, including archive/restore state. Preserve the current database and backup, keep the service stopped if integrity is uncertain, and recover forward with a corrected v23 release or a separately reviewed reconciliation from a v23-compatible backup.
- Never try to downgrade by dropping `archived_at_ms` or lowering `PRAGMA user_version`; that does not restore deleted product rows and can discard lifecycle changes.
- Do not remove image files during either recovery path. Product image files are intentionally independent of catalog row deletion.
