'use strict';

/**
 * Unit tests for backend/lib/startup-recovery.js
 * Run with: node tests/unit/startup-recovery.test.js
 * Uses Node.js built-in test runner (node:test), available since Node 18.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const startupRecovery = require('../../lib/startup-recovery');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Silent metrics stub — collects log calls for inspection if needed. */
function makeMetrics() {
  const logs = [];
  return {
    log(level, event, data) {
      logs.push({ level, event, data });
    },
    logs,
  };
}

/**
 * Create a minimal in-memory database with the tables needed by
 * startupRecovery.  Columns match the real schema (from migrations 001–014).
 */
function createTestDb() {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE users (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE transactions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      type         TEXT NOT NULL,
      amount       REAL NOT NULL,
      balance_after REAL NOT NULL DEFAULT 0,
      description  TEXT,
      reference_id TEXT,
      created_at   TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE rental_sessions (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id            INTEGER,
      car_id             INTEGER,
      car_name           TEXT,
      duration_seconds   INTEGER,
      cost               REAL,
      session_ref        TEXT,
      termination_reason TEXT,
      created_at         TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE devices (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      car_id       INTEGER NOT NULL,
      name         TEXT,
      device_key_hash TEXT NOT NULL DEFAULT 'hash',
      status       TEXT NOT NULL DEFAULT 'active',
      last_seen_at TEXT,
      created_at   TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return db;
}

/** Insert a user and return its id. */
function insertUser(db, username, balance) {
  const result = db.prepare(
    'INSERT INTO users (username, balance) VALUES (?, ?)'
  ).run(username, balance);
  return result.lastInsertRowid;
}

/** Insert a hold transaction and return its id. */
function insertHold(db, userId, amount, referenceId, createdAt) {
  const balanceAfter = 0;
  const result = db.prepare(
    `INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id, created_at)
     VALUES (?, 'hold', ?, ?, 'Hold', ?, ?)`
  ).run(userId, -Math.abs(amount), balanceAfter, referenceId, createdAt || 'now');
  return result.lastInsertRowid;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startupRecovery', () => {

  // -------------------------------------------------------------------------
  // 1. Orphan hold recovery
  // -------------------------------------------------------------------------
  describe('orphan hold recovery', () => {
    it('refunds a hold with no matching release or deduct', () => {
      const db = createTestDb();
      const metrics = makeMetrics();

      const userId = insertUser(db, 'alice', 50);
      insertHold(db, userId, 100, 'ref-orphan-1');

      const summary = startupRecovery(db, metrics);

      // Balance should be restored: 50 + 100 = 150
      const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
      assert.equal(user.balance, 150);

      // A release transaction should have been created
      const release = db.prepare(
        "SELECT * FROM transactions WHERE user_id = ? AND type = 'release'"
      ).get(userId);
      assert.ok(release, 'release transaction should exist');
      assert.equal(release.amount, 100);
      assert.equal(release.reference_id, 'ref-orphan-1');
      assert.ok(
        release.description.includes('Автовосстановление'),
        'description should mention auto-recovery'
      );

      assert.equal(summary.orphanHoldsRecovered, 1);

      db.close();
    });

    // -----------------------------------------------------------------------
    // 2. No false positives — hold that already has a deduct is NOT refunded
    // -----------------------------------------------------------------------
    it('does not refund a hold that already has a matching deduct', () => {
      const db = createTestDb();
      const metrics = makeMetrics();

      const userId = insertUser(db, 'bob', 200);
      insertHold(db, userId, 100, 'ref-settled-1');
      // Add a deduct with the same reference_id (simulates completed session)
      db.prepare(
        `INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id)
         VALUES (?, 'deduct', ?, 170, 'Deduct', ?)`
      ).run(userId, -30, 'ref-settled-1');

      const summary = startupRecovery(db, metrics);

      // Balance unchanged
      const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
      assert.equal(user.balance, 200);

      // No extra release transaction
      const releases = db.prepare(
        "SELECT * FROM transactions WHERE user_id = ? AND type = 'release'"
      ).all(userId);
      assert.equal(releases.length, 0);

      assert.equal(summary.orphanHoldsRecovered, 0);

      db.close();
    });

    // -----------------------------------------------------------------------
    // 3. Multiple orphans — all recovered
    // -----------------------------------------------------------------------
    it('recovers multiple orphan holds across different users', () => {
      const db = createTestDb();
      const metrics = makeMetrics();

      const user1 = insertUser(db, 'carol', 0);
      const user2 = insertUser(db, 'dave', 50);
      insertHold(db, user1, 100, 'ref-multi-1');
      insertHold(db, user2, 100, 'ref-multi-2');

      const summary = startupRecovery(db, metrics);

      const u1 = db.prepare('SELECT balance FROM users WHERE id = ?').get(user1);
      const u2 = db.prepare('SELECT balance FROM users WHERE id = ?').get(user2);
      assert.equal(u1.balance, 100);
      assert.equal(u2.balance, 150);

      assert.equal(summary.orphanHoldsRecovered, 2);

      db.close();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Stale session cleanup
  // -------------------------------------------------------------------------
  describe('stale session cleanup', () => {
    it('marks old incomplete sessions as terminated', () => {
      const db = createTestDb();
      const metrics = makeMetrics();

      const userId = insertUser(db, 'eve', 100);
      // Insert a session that has no duration_seconds (never completed),
      // with a created_at far in the past (2 hours ago)
      db.prepare(
        `INSERT INTO rental_sessions (user_id, car_id, car_name, duration_seconds, cost, created_at)
         VALUES (?, 1, 'Test Car', NULL, NULL, datetime('now', '-2 hours'))`
      ).run(userId);

      const summary = startupRecovery(db, metrics);

      const session = db.prepare('SELECT * FROM rental_sessions WHERE user_id = ?').get(userId);
      assert.equal(session.termination_reason, 'server_restart');
      assert.equal(summary.staleSessions, 1);

      db.close();
    });

    it('does not touch recently created incomplete sessions', () => {
      const db = createTestDb();
      const metrics = makeMetrics();

      const userId = insertUser(db, 'frank', 100);
      // Insert a session that has no duration_seconds but was created just now
      db.prepare(
        `INSERT INTO rental_sessions (user_id, car_id, car_name, duration_seconds, cost, created_at)
         VALUES (?, 1, 'Test Car', NULL, NULL, datetime('now', '-1 minute'))`
      ).run(userId);

      startupRecovery(db, metrics);

      const session = db.prepare('SELECT * FROM rental_sessions WHERE user_id = ?').get(userId);
      assert.equal(session.termination_reason, null, 'recent session should not be terminated');

      db.close();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Device state reset
  // -------------------------------------------------------------------------
  describe('device state reset', () => {
    it('clears last_seen_at for active devices', () => {
      const db = createTestDb();
      const metrics = makeMetrics();

      db.prepare(
        `INSERT INTO devices (car_id, name, device_key_hash, status, last_seen_at)
         VALUES (1, 'Pi-1', 'hash1', 'active', datetime('now', '-5 minutes'))`
      ).run();
      db.prepare(
        `INSERT INTO devices (car_id, name, device_key_hash, status, last_seen_at)
         VALUES (2, 'Pi-2', 'hash2', 'active', datetime('now', '-1 minutes'))`
      ).run();

      const summary = startupRecovery(db, metrics);

      const devices = db.prepare('SELECT last_seen_at FROM devices WHERE status = ?').all('active');
      for (const d of devices) {
        assert.equal(d.last_seen_at, null, 'last_seen_at should be cleared');
      }

      assert.equal(summary.devicesReset, 2);

      db.close();
    });
  });

  // -------------------------------------------------------------------------
  // 6. Idempotency — running twice recovers nothing the second time
  // -------------------------------------------------------------------------
  describe('idempotency', () => {
    it('does not double-refund on a second run', () => {
      const db = createTestDb();
      const metrics = makeMetrics();

      const userId = insertUser(db, 'grace', 50);
      insertHold(db, userId, 100, 'ref-idem-1');

      // First run
      const first = startupRecovery(db, metrics);
      assert.equal(first.orphanHoldsRecovered, 1);

      const balanceAfterFirst = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;

      // Second run — the hold now has a matching release, so no orphan
      const second = startupRecovery(db, metrics);
      assert.equal(second.orphanHoldsRecovered, 0);

      const balanceAfterSecond = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;
      assert.equal(balanceAfterFirst, balanceAfterSecond, 'balance should not change on second run');

      db.close();
    });
  });

  // -------------------------------------------------------------------------
  // 7. Return value — summary object has correct counts
  // -------------------------------------------------------------------------
  describe('return value', () => {
    it('returns summary with correct counts', () => {
      const db = createTestDb();
      const metrics = makeMetrics();

      // User with one orphan hold
      const userId = insertUser(db, 'heidi', 0);
      insertHold(db, userId, 100, 'ref-summary-1');

      // Old stale session
      db.prepare(
        `INSERT INTO rental_sessions (user_id, duration_seconds, created_at)
         VALUES (?, NULL, datetime('now', '-2 hours'))`
      ).run(userId);

      // Active device
      db.prepare(
        `INSERT INTO devices (car_id, device_key_hash, status, last_seen_at)
         VALUES (3, 'hash3', 'active', datetime('now', '-10 minutes'))`
      ).run();

      const summary = startupRecovery(db, metrics);

      assert.equal(typeof summary.orphanHoldsRecovered, 'number');
      assert.equal(typeof summary.staleSessions, 'number');
      assert.equal(typeof summary.devicesReset, 'number');

      assert.equal(summary.orphanHoldsRecovered, 1);
      assert.equal(summary.staleSessions, 1);
      assert.equal(summary.devicesReset, 1);

      db.close();
    });
  });

});
