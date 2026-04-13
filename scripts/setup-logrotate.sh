#!/usr/bin/env bash
# Setup PM2 log rotation for Riley at the Rally backend.
# Retention: 14 days, max 10MB per file, compress old logs.
#
# Usage:
#   bash scripts/setup-logrotate.sh
#
# Requires pm2 to be installed globally.

set -e

echo "[logrotate] Installing pm2-logrotate module..."
pm2 install pm2-logrotate

echo "[logrotate] Configuring retention and size limits..."
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
pm2 set pm2-logrotate:workerInterval 30
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'

echo "[logrotate] Configuration applied:"
pm2 conf pm2-logrotate 2>/dev/null || true

echo "[logrotate] Done. Logs will be rotated daily, kept for 14 days, max 10MB each."
