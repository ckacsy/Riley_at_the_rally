'use strict';

const path = require('path');
const fs = require('fs');
const { openDatabase } = require('../db/connection');

module.exports = function createTokenCleanup(db, metrics, dbDir) {
  return function runTokenCleanup() {
    const now = new Date().toISOString();
    let totalDeleted = 0;

    try {
      const r = db.prepare('DELETE FROM email_verification_tokens WHERE expires_at < ?').run(now);
      if (r.changes > 0) {
        totalDeleted += r.changes;
        metrics.log('debug', 'token_cleanup', { table: 'email_verification_tokens', deleted: r.changes });
      }
    } catch (e) {
      metrics.log('error', 'token_cleanup_error', { table: 'email_verification_tokens', error: e.message });
    }

    try {
      const r = db.prepare('DELETE FROM password_reset_tokens WHERE expires_at < ?').run(now);
      if (r.changes > 0) {
        totalDeleted += r.changes;
        metrics.log('debug', 'token_cleanup', { table: 'password_reset_tokens', deleted: r.changes });
      }
    } catch (e) {
      metrics.log('error', 'token_cleanup_error', { table: 'password_reset_tokens', error: e.message });
    }

    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const r = db.prepare('DELETE FROM magic_links WHERE expires_at < ?').run(cutoff);
      if (r.changes > 0) {
        totalDeleted += r.changes;
        metrics.log('debug', 'token_cleanup', { table: 'magic_links', deleted: r.changes });
      }
    } catch (e) {
      metrics.log('error', 'token_cleanup_error', { table: 'magic_links', error: e.message });
    }

    try {
      const sessionsDbPath = path.join(dbDir, 'sessions.sqlite');
      if (fs.existsSync(sessionsDbPath)) {
        const sessDb = openDatabase(sessionsDbPath, { timeout: 5000 });
        try {
          const r = sessDb.prepare('DELETE FROM sessions WHERE expired < ?').run(Date.now());
          if (r.changes > 0) {
            totalDeleted += r.changes;
            metrics.log('debug', 'token_cleanup', { table: 'sessions', deleted: r.changes });
          }
        } finally {
          sessDb.close();
        }
      }
    } catch (e) {
      metrics.log('error', 'token_cleanup_error', { table: 'sessions', error: e.message });
    }

    if (totalDeleted > 0) {
      metrics.log('info', 'token_cleanup_complete', { totalDeleted });
    }
  };
};
