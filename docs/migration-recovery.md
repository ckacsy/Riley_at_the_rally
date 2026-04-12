# Migration Recovery Guide

## How the migration system works

Migrations live in `backend/db/migrations/` as numbered `.sql` or `.js` files (e.g. `001_initial_schema.sql`, `002_add_user_fields.js`). They are applied in lexicographic order on every server startup by `backend/db/migrate.js`.

The `schema_migrations` table tracks which migrations have been applied:

```sql
CREATE TABLE schema_migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT UNIQUE NOT NULL,
  applied_at  TEXT DEFAULT CURRENT_TIMESTAMP,
  checksum    TEXT
);
```

- `filename` — the migration file name (unique; prevents re-running).
- `applied_at` — timestamp of when the migration was applied.
- `checksum` — SHA-256 hash of the file contents at apply time; useful for detecting post-apply modifications.

**Each migration runs inside a single SQLite transaction.** Both the migration SQL/JS and the `INSERT INTO schema_migrations` are committed atomically. If anything fails, the entire migration rolls back and no partial state is left in the database.

After a failure the server logs a clear error and **stops processing further migrations**. It then throws the error, which prevents the server from starting. This is intentional: continuing with a potentially broken schema could cause data corruption.

---

## What happens on failure

1. The migration's transaction is automatically rolled back by `better-sqlite3`.
2. The failed migration is **not** recorded in `schema_migrations`.
3. All previously applied migrations remain intact.
4. No subsequent migrations are attempted.
5. The server logs:
   ```
   [migrate] ERROR: Migration "NNN_name.sql" failed: <error message>
   [migrate] Fix the migration or the database state, then restart the server.
   ```
6. The server process exits with an unhandled error (startup is aborted).

---

## Recovery steps

### "Migration X failed due to a SQL syntax error"

1. Open `backend/db/migrations/NNN_name.sql` and fix the SQL syntax.
2. Restart the server. The migration will be retried (it was never recorded as applied).

### "Migration X failed due to a data issue (constraint violation, etc.)"

1. Identify the conflicting data using the SQLite CLI:
   ```sh
   sqlite3 data/riley.sqlite
   ```
2. Inspect and manually fix the problematic rows.
3. Restart the server. The migration will be retried.

### "Schema is corrupted from a pre-transaction-safety migration"

If the database was partially mutated before transaction safety was added (i.e., the old `migrate.js` without transactions was used), you may need to manually recover:

1. **Take a backup first** (see [Backup recommendation](#backup-recommendation)).
2. Open the SQLite CLI:
   ```sh
   sqlite3 data/riley.sqlite
   ```
3. Identify what was partially applied. Compare `schema_migrations` entries with the actual schema:
   ```sql
   SELECT filename FROM schema_migrations ORDER BY id;
   .schema
   ```
4. Manually undo any partial changes (e.g., `DROP TABLE IF EXISTS ...`).
5. If the migration was partially recorded in `schema_migrations`, remove it:
   ```sql
   DELETE FROM schema_migrations WHERE filename = 'NNN_name.sql';
   ```
6. Fix the migration file if needed, then restart the server.

### "Need to re-run a migration"

> ⚠️ Use with caution — re-running a migration that already applied changes may fail or duplicate data.

1. Take a backup.
2. Open the SQLite CLI and delete the record:
   ```sql
   DELETE FROM schema_migrations WHERE filename = 'NNN_name.sql';
   ```
3. Restart the server. The migration will be re-applied.

### "Checksum mismatch detected"

If you modified a migration file after it was applied (the recorded `checksum` no longer matches the file), the system will not automatically detect this — but you can check manually:

```sh
node -e "
const crypto = require('crypto');
const fs = require('fs');
const file = 'backend/db/migrations/NNN_name.sql';
console.log(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
"
```

Compare the output to the stored checksum:
```sql
SELECT checksum FROM schema_migrations WHERE filename = 'NNN_name.sql';
```

If the file was intentionally modified (e.g., whitespace cleanup) and the change is safe:
1. Recompute the checksum using the command above.
2. Update it in the database:
   ```sql
   UPDATE schema_migrations SET checksum = '<new-sha256>' WHERE filename = 'NNN_name.sql';
   ```

If the modification was accidental, revert the file to its original state and restart.

---

## Backup recommendation

**Always back up the database before deploying new migrations**, especially in production:

```sh
cp data/riley.sqlite data/riley.sqlite.bak-$(date +%Y%m%d-%H%M%S)
```

Or use the project's backup script (see `docs/backup-restore.md` once Sprint 5.6 is complete).

To verify database integrity after any manual intervention:
```sql
PRAGMA integrity_check;
```

The output should be `ok`. Any other output indicates corruption.
