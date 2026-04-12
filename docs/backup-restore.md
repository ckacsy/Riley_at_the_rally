# Backup & Restore Guide

## Overview

This guide covers the backup and restore system for the **Riley at the Rally** backend.

### What is backed up

| Item | Source | Backed-up as |
|------|--------|--------------|
| Main database | `backend/data/riley.sqlite` | `<backup>/riley.sqlite` |
| Sessions database | `backend/sessions.sqlite` | `<backup>/sessions.sqlite` (if present) |
| Uploaded files (avatars, etc.) | `backend/uploads/` | `<backup>/uploads/` |
| Backup metadata | _(generated)_ | `<backup>/manifest.json` |

### Where backups are stored

By default, backups live in the `backups/` directory at the project root:

```
backups/
  2026-04-12_03-00-01/
    riley.sqlite
    sessions.sqlite
    uploads/
    manifest.json
  2026-04-11_03-00-01/
    ...
```

The `backups/` directory is excluded from version control (see `.gitignore`).

### Backup format

Each backup is a self-contained directory named `YYYY-MM-DD_HH-MM-SS`. It contains:

- **`riley.sqlite`** — consistent point-in-time snapshot of the main database, created using SQLite's `.backup` command (WAL-safe; guaranteed consistent even if WAL mode is active).
- **`sessions.sqlite`** — same for the session store, if it exists.
- **`uploads/`** — full copy of the user-uploads directory.
- **`manifest.json`** — metadata:

```json
{
  "version": "1.0.0",
  "timestamp": "2026-04-12T03:00:01Z",
  "backup_keep_days": 7,
  "files": [
    {"path": "riley.sqlite",    "size": 524288, "sha256": "abc123..."},
    {"path": "sessions.sqlite", "size": 16384,  "sha256": "def456..."},
    {"path": "uploads/avatar_42.jpg", "size": 43210, "sha256": "789abc..."}
  ]
}
```

---

## Prerequisites

The `sqlite3` CLI must be installed on the host machine:

```bash
# Debian / Ubuntu / Raspberry Pi OS
sudo apt install sqlite3
```

Verify it is available:

```bash
sqlite3 --version
```

---

## Quick start

### Manual backup

Run from the project root:

```bash
./scripts/backup.sh
```

### Automated daily backup via cron

Add to the system crontab (`crontab -e`) to run every day at 03:00:

```cron
0 3 * * * cd /path/to/Riley_at_the_rally && ./scripts/backup.sh >> backups/backup.log 2>&1
```

Replace `/path/to/Riley_at_the_rally` with the absolute path to the project root.

### Restore from backup

```bash
./scripts/restore.sh backups/2026-04-12_03-00-01
```

Or with an absolute path:

```bash
./scripts/restore.sh /path/to/Riley_at_the_rally/backups/2026-04-12_03-00-01
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKUP_KEEP_DAYS` | `7` | Number of most-recent backups to retain; older ones are deleted automatically. |
| `BACKUP_DIR` | `<project_root>/backups` | Directory where backup snapshots are stored. |

Example — keep 14 backups, store on an external drive:

```bash
BACKUP_KEEP_DAYS=14 BACKUP_DIR=/mnt/usb/riley-backups ./scripts/backup.sh
```

---

## Rotation policy

After every successful backup, the script removes backup directories that exceed the retention window. Directories are matched by the `YYYY-MM-DD_HH-MM-SS` naming pattern. Pre-restore backups (`pre-restore-*`) are **not** removed by rotation.

---

## Restore procedure

`restore.sh` performs these steps automatically:

1. **Validates** the backup directory and `manifest.json` exist.
2. **Verifies SHA-256 checksums** of all files against `manifest.json`.
3. **Runs `PRAGMA integrity_check`** on each backed-up SQLite file.
4. **Prompts for confirmation** (skipped with `--yes`).
5. **Creates a pre-restore backup** of the current state at `backups/pre-restore-TIMESTAMP/`.
6. **Stops the server** if a PM2 process named `riley-backend` is detected; otherwise warns if port 5000 is in use.
7. **Copies SQLite files** to their original locations, removing stale WAL/SHM companion files.
8. **Copies the uploads directory**.
9. **Runs post-restore `PRAGMA integrity_check`** on all restored databases.
10. **Restarts PM2** if it was stopped automatically.
11. **Prints success message** with next-steps instructions.

### Scripted (non-interactive) restore

Pass `--yes` to skip the confirmation prompt:

```bash
./scripts/restore.sh backups/2026-04-12_03-00-01 --yes
```

---

## Disaster recovery scenarios

### "Database is corrupted"

```bash
# List available backups (newest first)
ls -lt backups/ | head -10

# Restore the latest backup
./scripts/restore.sh backups/2026-04-12_03-00-01
```

After restore, verify:

```bash
sqlite3 backend/data/riley.sqlite "PRAGMA integrity_check;"
# Expected output: ok
```

### "Accidentally deleted user data"

1. Restore from the backup taken before the deletion:

   ```bash
   ./scripts/restore.sh backups/2026-04-11_03-00-01
   ```

2. The server's migration system will replay any pending migrations automatically on next start:

   ```bash
   pm2 start riley-backend
   # or: cd backend && node server.js
   ```

3. If data was deleted between the backup and now, you may need to re-enter it manually via the admin panel.

### "Server won't start after failed migration"

1. Identify the last working backup (before the migration was deployed).
2. Restore it:

   ```bash
   ./scripts/restore.sh backups/2026-04-10_03-00-01
   ```

3. Fix the migration file in `backend/db/migrations/`.
4. Start the server. See also `docs/migration-recovery.md`.

### "Need to migrate to new hardware"

On the **old machine**:

```bash
./scripts/backup.sh
# Copy the latest backup to the new machine
scp -r backups/2026-04-12_03-00-01 newhost:/path/to/Riley_at_the_rally/backups/
```

On the **new machine**:

```bash
./scripts/restore.sh backups/2026-04-12_03-00-01 --yes
pm2 start riley-backend
```

---

## Testing your backups

To verify a backup is valid without touching the production environment:

```bash
# 1. Create a backup
./scripts/backup.sh

# 2. Check the manifest exists and is non-empty
LATEST=$(ls -td backups/[0-9]* | head -1)
cat "$LATEST/manifest.json"

# 3. Manually run integrity check on the backed-up databases
for db in "$LATEST"/*.sqlite; do
  echo -n "Checking $(basename $db)... "
  sqlite3 "$db" "PRAGMA integrity_check;"
done

# 4. Verify checksums (example for riley.sqlite)
sha256sum "$LATEST/riley.sqlite"
# Compare with the sha256 value in manifest.json
grep '"riley.sqlite"' "$LATEST/manifest.json"
```

For a full restore test in an isolated environment:

```bash
# Set a different BACKUP_DIR to avoid mixing with production backups
BACKUP_DIR=/tmp/test-restore ./scripts/restore.sh backups/2026-04-12_03-00-01 --yes
```

---

## Troubleshooting

### `sqlite3 CLI not found`

```bash
sudo apt install sqlite3
```

### `Integrity check FAILED`

The backup file or restored file is corrupt. Try an older backup:

```bash
ls -lt backups/
./scripts/restore.sh backups/<older-timestamp>
```

### `Checksum mismatch`

The backup files may have been tampered with or corrupted in transit. Use a different backup snapshot.

### `Something is listening on port 5000`

The restore script could not stop the server automatically. Stop it manually:

```bash
pm2 stop riley-backend
# or find and kill the node process
kill $(lsof -ti:5000)
```

Then re-run restore.
