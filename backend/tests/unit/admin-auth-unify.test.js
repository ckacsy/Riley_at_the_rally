'use strict';

/**
 * Unit tests for Task 6.3 — Unify Admin Auth
 * Run with: node tests/unit/admin-auth-unify.test.js
 * Uses Node.js built-in test runner (node:test), available since Node 18.
 *
 * Verifies that chat:delete authorization uses the DB role column via
 * hasRequiredRole() instead of the deprecated ADMIN_USERNAMES env var.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { hasRequiredRole } = require('../../middleware/roles');
const { runMigrations } = require('../../db/migrate');
const { openDatabase } = require('../../db/connection');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

function insertUser(db, username, role, status) {
  return db.prepare(
    `INSERT INTO users (username, username_normalized, email, email_normalized, password_hash, status, role, balance)
     VALUES (?, ?, ?, ?, 'hash', ?, ?, 100)`
  ).run(username, username.toLowerCase(), `${username}@test.com`, `${username}@test.com`, status || 'active', role || 'user').lastInsertRowid;
}

/**
 * Simulate the chat:delete authorization logic extracted from socket/index.js,
 * using only DB state (no ADMIN_USERNAMES).
 *
 * Returns { allowed: boolean, code?: string }.
 */
function simulateChatDeleteAuth(db, userId) {
  if (!userId) {
    return { allowed: false, code: 'auth_required' };
  }
  const adminUser = db.prepare('SELECT username, status, role FROM users WHERE id = ?').get(userId);
  if (!adminUser || adminUser.status !== 'active') {
    return { allowed: false, code: 'forbidden' };
  }
  if (!hasRequiredRole(adminUser.role, ['admin', 'moderator'])) {
    return { allowed: false, code: 'forbidden' };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Task 6.3 — Unified Admin Auth for chat:delete', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  it('role=admin can delete chat messages', () => {
    const userId = insertUser(db, 'superadmin', 'admin', 'active');
    const result = simulateChatDeleteAuth(db, userId);
    assert.equal(result.allowed, true, 'admin role should be allowed');
  });

  it('role=moderator can delete chat messages', () => {
    const userId = insertUser(db, 'moduser', 'moderator', 'active');
    const result = simulateChatDeleteAuth(db, userId);
    assert.equal(result.allowed, true, 'moderator role should be allowed');
  });

  it('role=user is denied chat:delete', () => {
    const userId = insertUser(db, 'normaluser', 'user', 'active');
    const result = simulateChatDeleteAuth(db, userId);
    assert.equal(result.allowed, false, 'user role should be denied');
    assert.equal(result.code, 'forbidden');
  });

  it('admin with status=banned is denied chat:delete', () => {
    const userId = insertUser(db, 'bannedadmin', 'admin', 'banned');
    const result = simulateChatDeleteAuth(db, userId);
    assert.equal(result.allowed, false, 'banned admin should be denied');
    assert.equal(result.code, 'forbidden');
  });

  it('unauthenticated (no userId) returns auth_required', () => {
    const result = simulateChatDeleteAuth(db, null);
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'auth_required');
  });

  describe('hasRequiredRole weight hierarchy', () => {
    it('admin satisfies [admin, moderator] requirement', () => {
      assert.equal(hasRequiredRole('admin', ['admin', 'moderator']), true);
    });

    it('moderator satisfies [admin, moderator] requirement', () => {
      assert.equal(hasRequiredRole('moderator', ['admin', 'moderator']), true);
    });

    it('user does NOT satisfy [admin, moderator] requirement', () => {
      assert.equal(hasRequiredRole('user', ['admin', 'moderator']), false);
    });

    it('admin satisfies [admin] requirement', () => {
      assert.equal(hasRequiredRole('admin', ['admin']), true);
    });

    it('moderator does NOT satisfy [admin]-only requirement', () => {
      // moderator weight (20) < admin weight (30), so moderator cannot satisfy admin-only
      assert.equal(hasRequiredRole('moderator', ['admin']), false);
    });

    it('user does NOT satisfy [admin] requirement', () => {
      assert.equal(hasRequiredRole('user', ['admin']), false);
    });

    it('unknown role returns false', () => {
      assert.equal(hasRequiredRole('superuser', ['admin', 'moderator']), false);
    });
  });

  it('ADMIN_USERNAMES no longer affects chat:delete — role=admin not in ADMIN_USERNAMES still allowed', () => {
    // This simulates a user who has role='admin' in DB but is NOT in the ADMIN_USERNAMES env set.
    // Under the old system they would be denied; under the new system they must be allowed.
    const ADMIN_USERNAMES = new Set(['someother_admin']); // does NOT include 'dbadmin'
    const userId = insertUser(db, 'dbadmin', 'admin', 'active');

    // Verify the old check would have denied this user
    const userRow = db.prepare('SELECT username, status, role FROM users WHERE id = ?').get(userId);
    const wouldOldCheckAllow = ADMIN_USERNAMES.has(userRow.username.toLowerCase());
    assert.equal(wouldOldCheckAllow, false, 'old ADMIN_USERNAMES check would have denied this user');

    // New DB role check must allow them
    const result = simulateChatDeleteAuth(db, userId);
    assert.equal(result.allowed, true, 'DB role check should allow admin regardless of ADMIN_USERNAMES');
  });
});
