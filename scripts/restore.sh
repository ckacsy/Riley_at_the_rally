#!/bin/bash
# scripts/restore.sh — Riley at the Rally restore script
#
# Usage: ./scripts/restore.sh <backup-directory> [--yes]
#
# Arguments:
#   <backup-directory>  Path to backup dir (e.g. backups/2026-04-12_14-30-00)
#   --yes               Skip interactive confirmation prompt (for scripted use)
#
# Environment variables:
#   BACKUP_DIR  — backup storage root (default: <project_root>/backups)

set -euo pipefail

# ---------------------------------------------------------------------------
# Project root detection
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
# Argument parsing
# ---------------------------------------------------------------------------
BACKUP_PATH=""
YES_FLAG=0

for arg in "$@"; do
  case "$arg" in
    --yes) YES_FLAG=1 ;;
    -*) die "Unknown option: $arg" ;;
    *) BACKUP_PATH="$arg" ;;
  esac
done

[[ -n "${BACKUP_PATH}" ]] || die "Usage: $0 <backup-directory> [--yes]"

# Resolve to absolute path
if [[ "${BACKUP_PATH}" != /* ]]; then
  BACKUP_PATH="${PROJECT_ROOT}/${BACKUP_PATH}"
fi

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 CLI not found. Install it with: sudo apt install sqlite3"

[[ -d "${BACKUP_PATH}" ]] || die "Backup directory does not exist: ${BACKUP_PATH}"

MANIFEST="${BACKUP_PATH}/manifest.json"
[[ -f "${MANIFEST}" ]] || die "manifest.json not found in backup directory: ${BACKUP_PATH}"

log "Restore source: ${BACKUP_PATH}"

# ---------------------------------------------------------------------------
# Verify checksums from manifest.json against actual backup files
# ---------------------------------------------------------------------------
log "Verifying checksums from manifest.json..."

# Parse manifest entries using grep/sed (no jq required)
MANIFEST_CONTENT="$(cat "${MANIFEST}")"

# Extract path/sha256 pairs using a simple approach
PATHS=()
CHECKSUMS=()

# Use grep to extract each "path" and "sha256" value
while IFS= read -r line; do
  PATHS+=("$(echo "$line" | sed 's/.*"path": *"\([^"]*\)".*/\1/')")
done < <(grep '"path"' "${MANIFEST}")

while IFS= read -r line; do
  CHECKSUMS+=("$(echo "$line" | sed 's/.*"sha256": *"\([^"]*\)".*/\1/')")
done < <(grep '"sha256"' "${MANIFEST}")

if [[ ${#PATHS[@]} -ne ${#CHECKSUMS[@]} ]]; then
  die "Manifest parsing error: path/checksum count mismatch (${#PATHS[@]} paths, ${#CHECKSUMS[@]} checksums)"
fi

CHECKSUM_ERRORS=0
for i in "${!PATHS[@]}"; do
  REL_PATH="${PATHS[$i]}"
  EXPECTED="${CHECKSUMS[$i]}"
  FULL_PATH="${BACKUP_PATH}/${REL_PATH}"

  if [[ ! -f "${FULL_PATH}" ]]; then
    log "WARNING: File listed in manifest not found: ${REL_PATH} (may be an empty uploads dir)"
    continue
  fi

  ACTUAL="$(sha256sum "${FULL_PATH}" | awk '{print $1}')"
  if [[ "${ACTUAL}" != "${EXPECTED}" ]]; then
    log "ERROR: Checksum mismatch for ${REL_PATH}"
    log "  Expected: ${EXPECTED}"
    log "  Actual:   ${ACTUAL}"
    CHECKSUM_ERRORS=$(( CHECKSUM_ERRORS + 1 ))
  fi
done

[[ ${CHECKSUM_ERRORS} -eq 0 ]] || die "Checksum verification failed for ${CHECKSUM_ERRORS} file(s). Restore aborted."
log "All checksums verified OK."

# ---------------------------------------------------------------------------
# Verify integrity of backed-up SQLite files
# ---------------------------------------------------------------------------
log "Verifying integrity of backed-up SQLite databases..."

while IFS= read -r -d '' DB_FILE; do
  DB_NAME="$(basename "${DB_FILE}")"
  log "Running PRAGMA integrity_check on ${DB_NAME}..."
  INTEGRITY="$(sqlite3 "${DB_FILE}" "PRAGMA integrity_check;")"
  if [[ "${INTEGRITY}" != "ok" ]]; then
    die "Integrity check FAILED for backup ${DB_NAME}: ${INTEGRITY}"
  fi
  log "Integrity check passed: ${DB_NAME}"
done < <(find "${BACKUP_PATH}" -maxdepth 1 -name "*.sqlite" -print0 2>/dev/null)

# ---------------------------------------------------------------------------
# Interactive confirmation (unless --yes)
# ---------------------------------------------------------------------------
if [[ ${YES_FLAG} -eq 0 ]]; then
  echo ""
  echo "  ┌─────────────────────────────────────────────────────────┐"
  echo "  │  WARNING: This will OVERWRITE current database files    │"
  echo "  │  and uploads directory with data from the backup.       │"
  echo "  │                                                         │"
  echo "  │  Backup: ${BACKUP_PATH}"
  echo "  │                                                         │"
  echo "  │  A pre-restore backup will be created automatically.   │"
  echo "  └─────────────────────────────────────────────────────────┘"
  echo ""
  read -r -p "  Type 'yes' to proceed with restore: " CONFIRM
  echo ""
  [[ "${CONFIRM}" == "yes" ]] || { echo "Restore cancelled."; exit 0; }
fi

# ---------------------------------------------------------------------------
# Auto-backup current state before restoring
# ---------------------------------------------------------------------------
PRE_RESTORE_TIMESTAMP="$(date '+%Y-%m-%d_%H-%M-%S')"
PRE_RESTORE_DIR="${BACKUP_DIR}/pre-restore-${PRE_RESTORE_TIMESTAMP}"

log "Creating pre-restore backup at: ${PRE_RESTORE_DIR}"

BACKUP_SCRIPT="${SCRIPT_DIR}/backup.sh"
if [[ -x "${BACKUP_SCRIPT}" ]]; then
  BACKUP_DIR="${BACKUP_DIR}" "${BACKUP_SCRIPT}" && log "Pre-restore backup completed."
  # Rename the just-created timestamped backup to pre-restore-TIMESTAMP
  LATEST_BACKUP="$(find "${BACKUP_DIR}" -maxdepth 1 -mindepth 1 -type d \
    -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_[0-9][0-9]-[0-9][0-9]-[0-9][0-9]' \
    | sort | tail -1)"
  if [[ -n "${LATEST_BACKUP}" ]]; then
    mv "${LATEST_BACKUP}" "${PRE_RESTORE_DIR}"
    log "Pre-restore backup saved as: ${PRE_RESTORE_DIR}"
  fi
else
  log "WARNING: backup.sh not found or not executable. Skipping pre-restore backup."
fi

# ---------------------------------------------------------------------------
# Check if server is running; warn/stop if possible
# ---------------------------------------------------------------------------
log "Checking for running server..."

SERVER_STOPPED=0

# Try PM2 first
if command -v pm2 >/dev/null 2>&1; then
  if pm2 list 2>/dev/null | grep -q 'riley-backend'; then
    log "Found PM2 process 'riley-backend'. Stopping it..."
    pm2 stop riley-backend 2>/dev/null && SERVER_STOPPED=1 && log "Server stopped via PM2."
  fi
fi

# Fall back to checking port 5000
if [[ ${SERVER_STOPPED} -eq 0 ]]; then
  if command -v ss >/dev/null 2>&1 && ss -tlnp 2>/dev/null | grep -q ':5000 '; then
    log "WARNING: Something is listening on port 5000 and could not be stopped automatically."
    log "         Please stop the server manually before restoring, then re-run restore."
    if [[ ${YES_FLAG} -eq 0 ]]; then
      read -r -p "  Press Enter to continue anyway, or Ctrl-C to abort: "
    fi
  elif command -v lsof >/dev/null 2>&1 && lsof -ti:5000 >/dev/null 2>&1; then
    log "WARNING: Something is listening on port 5000 and could not be stopped automatically."
    log "         Please stop the server manually before restoring, then re-run restore."
    if [[ ${YES_FLAG} -eq 0 ]]; then
      read -r -p "  Press Enter to continue anyway, or Ctrl-C to abort: "
    fi
  else
    log "No server detected on port 5000. Proceeding."
  fi
fi

# ---------------------------------------------------------------------------
# Restore SQLite databases
# ---------------------------------------------------------------------------
BACKEND_DIR="${PROJECT_ROOT}/backend"

log "Restoring SQLite databases..."

while IFS= read -r -d '' DB_BACKUP; do
  DB_NAME="$(basename "${DB_BACKUP}")"

  # Determine destination based on known database names
  case "${DB_NAME}" in
    riley.sqlite)
      DB_DEST_DIR="${BACKEND_DIR}/data"
      ;;
    sessions.sqlite)
      DB_DEST_DIR="${BACKEND_DIR}"
      ;;
    *)
      # For any other database, find its original location under backend/
      FOUND_DEST="$(find "${BACKEND_DIR}" -maxdepth 3 -name "${DB_NAME}" 2>/dev/null | head -1)"
      if [[ -n "${FOUND_DEST}" ]]; then
        DB_DEST_DIR="$(dirname "${FOUND_DEST}")"
      else
        DB_DEST_DIR="${BACKEND_DIR}/data"
        log "WARNING: Could not determine original location for ${DB_NAME}, restoring to ${DB_DEST_DIR}/"
      fi
      ;;
  esac

  mkdir -p "${DB_DEST_DIR}"
  DB_DEST="${DB_DEST_DIR}/${DB_NAME}"

  log "Restoring ${DB_NAME} → ${DB_DEST}"

  # Remove any stale WAL/SHM companion files to avoid conflicts
  rm -f "${DB_DEST}-wal" "${DB_DEST}-shm"

  cp "${DB_BACKUP}" "${DB_DEST}"
  log "Restored: ${DB_NAME}"
done < <(find "${BACKUP_PATH}" -maxdepth 1 -name "*.sqlite" -print0 2>/dev/null)

# ---------------------------------------------------------------------------
# Restore uploads directory
# ---------------------------------------------------------------------------
UPLOADS_BACKUP="${BACKUP_PATH}/uploads"
UPLOADS_DEST="${BACKEND_DIR}/uploads"

if [[ -d "${UPLOADS_BACKUP}" ]]; then
  log "Restoring uploads directory..."
  rm -rf "${UPLOADS_DEST}"
  cp -r "${UPLOADS_BACKUP}" "${UPLOADS_DEST}"
  log "Uploads restored to: ${UPLOADS_DEST}"
else
  log "No uploads directory in backup, skipping."
fi

# ---------------------------------------------------------------------------
# Post-restore integrity check
# ---------------------------------------------------------------------------
log "Running post-restore integrity checks..."

while IFS= read -r -d '' DB_DEST; do
  DB_NAME="$(basename "${DB_DEST}")"
  log "PRAGMA integrity_check on restored ${DB_NAME}..."
  INTEGRITY="$(sqlite3 "${DB_DEST}" "PRAGMA integrity_check;")"
  if [[ "${INTEGRITY}" != "ok" ]]; then
    die "Post-restore integrity check FAILED for ${DB_NAME}: ${INTEGRITY}"
  fi
  log "Integrity check passed: ${DB_NAME}"
done < <(find "${BACKEND_DIR}" -maxdepth 3 -name "*.sqlite" -print0 2>/dev/null)

# ---------------------------------------------------------------------------
# Restart PM2 if it was stopped
# ---------------------------------------------------------------------------
if [[ ${SERVER_STOPPED} -eq 1 ]]; then
  log "Restarting PM2 process 'riley-backend'..."
  pm2 start riley-backend 2>/dev/null && log "Server restarted via PM2." || log "WARNING: Failed to restart PM2 process. Start manually with: pm2 start riley-backend"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
log "Restore completed successfully from: ${BACKUP_PATH}"
echo ""
echo "  ✔ Restore complete."
echo ""
echo "  Next steps:"
echo "    1. If the server was stopped and not auto-restarted:"
echo "       pm2 start riley-backend"
echo "       # or: cd backend && node server.js"
echo "    2. Verify the application is working as expected."
echo "    3. Pre-restore backup is saved at: ${PRE_RESTORE_DIR:-<not created>}"
echo ""
