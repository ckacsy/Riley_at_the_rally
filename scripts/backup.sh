#!/bin/bash
# scripts/backup.sh — Riley at the Rally backup script
#
# Usage: ./scripts/backup.sh
#
# Example cron line (daily at 03:00, keep logs):
#   0 3 * * * cd /path/to/Riley_at_the_rally && ./scripts/backup.sh >> backups/backup.log 2>&1
#
# Environment variables:
#   BACKUP_KEEP_DAYS  — number of daily backups to retain (default: 7)
#   BACKUP_DIR        — backup destination directory (default: <project_root>/backups)

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
SCRIPT_VERSION="1.0.0"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"

# ---------------------------------------------------------------------------
# Project root detection: the scripts/ dir lives at PROJECT_ROOT/scripts/
# so PROJECT_ROOT is one level up from the directory containing this script.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BACKUP_DIR="${BACKUP_DIR:-${PROJECT_ROOT}/backups}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

die() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 CLI not found. Install it with: sudo apt install sqlite3"

# ---------------------------------------------------------------------------
# Prepare backup destination
# ---------------------------------------------------------------------------
TIMESTAMP="$(date '+%Y-%m-%d_%H-%M-%S')"
BACKUP_DEST="${BACKUP_DIR}/${TIMESTAMP}"

mkdir -p "${BACKUP_DEST}"
log "Backup destination: ${BACKUP_DEST}"

# ---------------------------------------------------------------------------
# Discover SQLite databases under backend/
# ---------------------------------------------------------------------------
BACKEND_DIR="${PROJECT_ROOT}/backend"

declare -a DB_FILES=()
while IFS= read -r -d '' f; do
  DB_FILES+=("$f")
done < <(find "${BACKEND_DIR}" -maxdepth 3 -name "*.sqlite" -print0 2>/dev/null)

if [[ ${#DB_FILES[@]} -eq 0 ]]; then
  log "WARNING: No .sqlite files found under ${BACKEND_DIR}. Continuing without database backups."
fi

# ---------------------------------------------------------------------------
# Back up each database using SQLite's .backup command (WAL-safe)
# ---------------------------------------------------------------------------
declare -a BACKED_UP_DBS=()

for DB_SRC in "${DB_FILES[@]}"; do
  DB_NAME="$(basename "${DB_SRC}")"
  DB_DEST="${BACKUP_DEST}/${DB_NAME}"

  log "Backing up database: ${DB_SRC} → ${DB_DEST}"
  sqlite3 "${DB_SRC}" ".backup '${DB_DEST}'" || die "Failed to back up ${DB_SRC}"

  BACKED_UP_DBS+=("${DB_DEST}")
  log "Database backup complete: ${DB_NAME}"
done

# ---------------------------------------------------------------------------
# Verify integrity of backed-up databases
# ---------------------------------------------------------------------------
for DB_DEST in "${BACKED_UP_DBS[@]}"; do
  DB_NAME="$(basename "${DB_DEST}")"
  log "Running PRAGMA integrity_check on ${DB_NAME}..."
  INTEGRITY="$(sqlite3 "${DB_DEST}" "PRAGMA integrity_check;")"
  if [[ "${INTEGRITY}" != "ok" ]]; then
    die "Integrity check FAILED for ${DB_NAME}: ${INTEGRITY}"
  fi
  log "Integrity check passed: ${DB_NAME}"
done

# ---------------------------------------------------------------------------
# Back up uploads directory
# ---------------------------------------------------------------------------
UPLOADS_SRC="${BACKEND_DIR}/uploads"
UPLOADS_DEST="${BACKUP_DEST}/uploads"

if [[ -d "${UPLOADS_SRC}" ]]; then
  log "Backing up uploads: ${UPLOADS_SRC} → ${UPLOADS_DEST}"
  cp -r "${UPLOADS_SRC}" "${UPLOADS_DEST}"
  log "Uploads backup complete."
else
  log "WARNING: uploads directory not found at ${UPLOADS_SRC}, skipping."
  mkdir -p "${UPLOADS_DEST}"
fi

# ---------------------------------------------------------------------------
# Generate manifest.json
# ---------------------------------------------------------------------------
log "Generating manifest.json..."

MANIFEST_FILE="${BACKUP_DEST}/manifest.json"

# Build file list entries (databases + uploads files)
FILE_ENTRIES=""
FIRST=1

add_manifest_entry() {
  local FILE_PATH="$1"
  local REL_PATH="${FILE_PATH#${BACKUP_DEST}/}"
  local FILE_SIZE
  FILE_SIZE="$(stat -c%s "${FILE_PATH}" 2>/dev/null || echo 0)"
  local FILE_CHECKSUM
  FILE_CHECKSUM="$(sha256sum "${FILE_PATH}" | awk '{print $1}')"

  if [[ ${FIRST} -eq 0 ]]; then
    FILE_ENTRIES+=","
  fi
  FILE_ENTRIES+="$(printf '\n    {"path": "%s", "size": %d, "sha256": "%s"}' "${REL_PATH}" "${FILE_SIZE}" "${FILE_CHECKSUM}")"
  FIRST=0
}

for DB_DEST in "${BACKED_UP_DBS[@]}"; do
  add_manifest_entry "${DB_DEST}"
done

# Include all files in uploads backup
if [[ -d "${UPLOADS_DEST}" ]]; then
  while IFS= read -r -d '' f; do
    add_manifest_entry "$f"
  done < <(find "${UPLOADS_DEST}" -type f -print0 2>/dev/null)
fi

printf '{
  "version": "%s",
  "timestamp": "%s",
  "backup_keep_days": %d,
  "files": [%s
  ]
}\n' \
  "${SCRIPT_VERSION}" \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  "${BACKUP_KEEP_DAYS}" \
  "${FILE_ENTRIES}" \
  > "${MANIFEST_FILE}"

log "manifest.json written."

# ---------------------------------------------------------------------------
# Rotation: remove backup directories older than BACKUP_KEEP_DAYS
# ---------------------------------------------------------------------------
log "Rotating backups (keeping last ${BACKUP_KEEP_DAYS} daily backups)..."

# Find backup dirs matching YYYY-MM-DD_HH-MM-SS pattern, sorted oldest first
mapfile -t OLD_BACKUPS < <(
  find "${BACKUP_DIR}" -maxdepth 1 -mindepth 1 -type d \
    -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_[0-9][0-9]-[0-9][0-9]-[0-9][0-9]' \
    | sort
)

TOTAL=${#OLD_BACKUPS[@]}
TO_DELETE=$(( TOTAL - BACKUP_KEEP_DAYS ))

if [[ ${TO_DELETE} -gt 0 ]]; then
  for (( i=0; i<TO_DELETE; i++ )); do
    log "Removing old backup: ${OLD_BACKUPS[$i]}"
    rm -rf "${OLD_BACKUPS[$i]}"
  done
else
  log "No old backups to remove (${TOTAL} total, keeping up to ${BACKUP_KEEP_DAYS})."
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
log "Backup completed successfully: ${BACKUP_DEST}"
