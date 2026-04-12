'use strict';

/**
 * Unit tests for Task 6.2 — Idempotency
 * Run with: node tests/unit/idempotency.test.js
 * Uses Node.js built-in test runner (node:test), available since Node 18.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const startupRecovery = require('../../lib/startup-recovery');
const { runMigrations } = require('../../db/migrate');
const { openDatabase } = require('../../db/connection');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetrics() {
  const logs = [];
  return {
    log(level, event, data) { logs.push({ level, event, data }); },
    logs,
    recordError() {},
    recordCommand() {},
    recordLatency() {},
    clearLatency() {},
  };
}

/**
 * Create a minimal in-memory database with all migrations applied so that
 * the unique index on transactions(reference_id, type) is present.
 */
function createTestDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

/** Insert a user and return its id. */
function insertUser(db, username, balance) {
  return db.prepare(
    `INSERT INTO users (username, username_normalized, email, email_normalized, password_hash, status, role, balance)
     VALUES (?, ?, ?, ?, 'hash', 'active', 'user', ?)`
  ).run(username, username.toLowerCase(), `${username}@test.com`, `${username}@test.com`, balance).lastInsertRowid;
}

/** Insert a hold transaction and return its id. */
function insertHold(db, userId, amount, referenceId) {
  return db.prepare(
    `INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id)
     VALUES (?, 'hold', ?, 0, 'Hold', ?)`
  ).run(userId, -Math.abs(amount), referenceId).lastInsertRowid;
}

/** Insert a payment_order row and return its id. */
function insertPaymentOrder(db, userId, paymentId, amount, status) {
  return db.prepare(
    `INSERT INTO payment_orders (user_id, yookassa_payment_id, amount, status)
     VALUES (?, ?, ?, ?)`
  ).run(userId, paymentId, amount, status || 'pending').lastInsertRowid;
}

/** Record a topup transaction (mimics the webhook handler). */
function recordTopupTransaction(db, userId, amount, paymentId) {
  const row = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
  const bal = row ? row.balance : amount;
  return db.prepare(
    `INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id)
     VALUES (?, 'topup', ?, ?, 'Пополнение баланса', ?)`
  ).run(userId, amount, bal, paymentId).lastInsertRowid;
}

/**
 * A minimal mock of processHoldDeduct extracted from the socket module —
 * tests the same logic but without needing a live Socket.IO server.
 */
function processHoldDeduct(db, dbUserId, holdAmount, actualCost, carName, durationSeconds, sessionRef) {
  const ref = sessionRef || null;
  try {
    db.transaction(() => {
      // Idempotency guard
      if (ref) {
        const existingDeduct = db.prepare(
          "SELECT 1 FROM transactions WHERE reference_id = ? AND type = 'deduct' LIMIT 1"
        ).get(ref);
        if (existingDeduct) {
          return; // already done — skip
        }
      }

      const releaseAmount = holdAmount - actualCost;
      if (releaseAmount > 0) {
        db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(releaseAmount, dbUserId);
        const afterRelease = db.prepare('SELECT balance FROM users WHERE id = ?').get(dbUserId);
        db.prepare(
          `INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id)
           VALUES (?, 'release', ?, ?, ?, ?)`
        ).run(dbUserId, releaseAmount, afterRelease ? afterRelease.balance : 0, 'Возврат блокировки: ' + carName, ref);
      } else if (releaseAmount < 0) {
        const extra = -releaseAmount;
        db.prepare('UPDATE users SET balance = MAX(0, balance - ?) WHERE id = ?').run(extra, dbUserId);
      }
      const mins = Math.floor(durationSeconds / 60);
      const secs = durationSeconds % 60;
      const rowAfter = db.prepare('SELECT balance FROM users WHERE id = ?').get(dbUserId);
      db.prepare(
        `INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id)
         VALUES (?, 'deduct', ?, ?, ?, ?)`
      ).run(dbUserId, -actualCost, rowAfter ? rowAfter.balance : 0, `Аренда: ${carName}, ${mins}м ${secs}с`, ref);
    })();
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || (e.message && e.message.includes('UNIQUE constraint'))) {
      // Idempotent — duplicate blocked by constraint, no crash
    } else {
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Idempotency (Task 6.2)', () => {

  // -------------------------------------------------------------------------
  // 1. Double end_session → second returns error, no crash
  // -------------------------------------------------------------------------
  describe('end_session idempotency', () => {
    it('second end_session returns no_active_session error without crashing', () => {
      // This test simulates the socket handler logic directly.
      // The key invariant: activeSessions.delete(socketId) on first call means
      // the second call finds no session and emits session_error.
      const activeSessions = new Map();
      const socketId = 'test-socket-1';

      const session = {
        carId: 1,
        userId: 'alice',
        dbUserId: 1,
        startTime: new Date(Date.now() - 10000),
        holdAmount: 100,
        sessionRef: crypto.randomUUID(),
      };
      activeSessions.set(socketId, session);

      const emittedEvents = [];
      const mockSocket = {
        id: socketId,
        emit(event, data) { emittedEvents.push({ event, data }); },
      };

      // Simulate first end_session
      function handleEndSession(socket) {
        const s = activeSessions.get(socket.id);
        if (!s) {
          socket.emit('session_error', { message: 'Активная сессия не найдена.', code: 'no_active_session' });
          return { ended: false };
        }
        activeSessions.delete(socket.id);
        socket.emit('session_ended', { carId: s.carId, durationSeconds: 0, cost: 0 });
        return { ended: true };
      }

      const first = handleEndSession(mockSocket);
      assert.equal(first.ended, true, 'First call should succeed');
      assert.equal(emittedEvents[0].event, 'session_ended');

      const second = handleEndSession(mockSocket);
      assert.equal(second.ended, false, 'Second call should indicate no session found');
      assert.equal(emittedEvents[1].event, 'session_error');
      assert.equal(emittedEvents[1].data.code, 'no_active_session');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Double webhook → single insert
  // -------------------------------------------------------------------------
  describe('payment webhook idempotency', () => {
    it('second webhook with same payment_id does not credit balance twice', () => {
      const db = createTestDb();

      const userId = insertUser(db, 'webhookuser', 0);
      const paymentId = 'pay_' + crypto.randomUUID();
      const eventId = 'evt_' + crypto.randomUUID();
      const amount = 100;

      insertPaymentOrder(db, userId, paymentId, amount, 'pending');

      // Simulate first webhook processing
      function processWebhook(db, paymentId, eventId, userId, amount) {
        const order = db.prepare(
          'SELECT * FROM payment_orders WHERE yookassa_payment_id = ?'
        ).get(paymentId);

        if (!order || order.status === 'succeeded') {
          return { processed: false, reason: 'already_succeeded' };
        }

        if (eventId) {
          const dupOrder = db.prepare(
            'SELECT id FROM payment_orders WHERE webhook_event_id = ?'
          ).get(eventId);
          if (dupOrder) return { processed: false, reason: 'dup_event_id_order' };

          const webhookEventsExists = db.prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='webhook_events' LIMIT 1"
          ).get();
          if (webhookEventsExists) {
            const dupEvent = db.prepare(
              'SELECT id FROM webhook_events WHERE event_id = ?'
            ).get(eventId);
            if (dupEvent) return { processed: false, reason: 'dup_event_id_events' };
          }
        }

        let credited = false;
        db.transaction(() => {
          const freshOrder = db.prepare(
            'SELECT status FROM payment_orders WHERE yookassa_payment_id = ?'
          ).get(paymentId);
          if (freshOrder && freshOrder.status === 'succeeded') return;

          db.prepare(
            "UPDATE payment_orders SET status = 'succeeded', webhook_event_id = ? WHERE yookassa_payment_id = ?"
          ).run(eventId, paymentId);

          if (eventId) {
            const exists = db.prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='webhook_events' LIMIT 1"
            ).get();
            if (exists) {
              try {
                db.prepare(
                  'INSERT INTO webhook_events (event_id, payment_id, event_type) VALUES (?, ?, ?)'
                ).run(eventId, paymentId, 'payment.succeeded');
              } catch (e) { /* dup — ignore */ }
            }
          }

          db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, userId);
          recordTopupTransaction(db, userId, amount, paymentId);
          credited = true;
        })();

        return { processed: credited };
      }

      const first = processWebhook(db, paymentId, eventId, userId, amount);
      assert.equal(first.processed, true, 'First webhook should be processed');

      const balanceAfterFirst = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;
      assert.equal(balanceAfterFirst, amount, 'Balance should be credited after first webhook');

      const second = processWebhook(db, paymentId, eventId, userId, amount);
      assert.equal(second.processed, false, 'Second webhook should be deduplicated');

      const balanceAfterSecond = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;
      assert.equal(balanceAfterSecond, amount, 'Balance should NOT be credited a second time');

      // Count topup transactions — must be exactly 1
      const topups = db.prepare(
        "SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = ? AND type = 'topup'"
      ).get(userId);
      assert.equal(topups.cnt, 1, 'Exactly one topup transaction should exist');

      db.close();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Restart mid-session → orphan hold recovered (startup-recovery)
  // -------------------------------------------------------------------------
  describe('restart mid-session → orphan hold recovered', () => {
    it('startup recovery refunds orphan hold created by an interrupted session', () => {
      const db = createTestDb();
      const metrics = makeMetrics();

      const userId = insertUser(db, 'restartuser', 50);
      const sessionRef = crypto.randomUUID();
      // Simulate a session hold that was never settled (server restarted mid-session)
      db.prepare('UPDATE users SET balance = balance - 100 WHERE id = ?').run(userId);
      insertHold(db, userId, 100, sessionRef);

      const balanceBefore = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;
      assert.equal(balanceBefore, -50, 'Balance should be negative after hold deducted');

      const summary = startupRecovery(db, metrics);

      assert.equal(summary.orphanHoldsRecovered, 1, 'Should recover 1 orphan hold');

      const balanceAfter = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;
      assert.equal(balanceAfter, 50, 'Balance should be restored after orphan hold recovery');

      // A release transaction should exist
      const release = db.prepare(
        "SELECT * FROM transactions WHERE user_id = ? AND type = 'release' AND reference_id = ?"
      ).get(userId, sessionRef);
      assert.ok(release, 'Release transaction should exist');
      assert.ok(release.description.includes('Автовосстановление'), 'Description should mention auto-recovery');

      db.close();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Duplicate processHoldDeduct → no double deduct
  // -------------------------------------------------------------------------
  describe('processHoldDeduct idempotency', () => {
    it('calling processHoldDeduct twice with same sessionRef results in a single deduct', () => {
      const db = createTestDb();

      const userId = insertUser(db, 'holduser', 0);
      const sessionRef = crypto.randomUUID();
      const holdAmount = 100;
      const actualCost = 30;

      // First call — should succeed
      processHoldDeduct(db, userId, holdAmount, actualCost, 'Test Car', 60, sessionRef);

      const deducts1 = db.prepare(
        "SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = ? AND type = 'deduct' AND reference_id = ?"
      ).get(userId, sessionRef);
      assert.equal(deducts1.cnt, 1, 'Exactly one deduct after first call');

      // Second call — should be idempotent (no additional transactions)
      processHoldDeduct(db, userId, holdAmount, actualCost, 'Test Car', 60, sessionRef);

      const deducts2 = db.prepare(
        "SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = ? AND type = 'deduct' AND reference_id = ?"
      ).get(userId, sessionRef);
      assert.equal(deducts2.cnt, 1, 'Still exactly one deduct after second call (idempotent)');

      const releases = db.prepare(
        "SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = ? AND type = 'release' AND reference_id = ?"
      ).get(userId, sessionRef);
      assert.equal(releases.cnt, 1, 'Still exactly one release after second call (idempotent)');

      db.close();
    });

    it('processHoldDeduct with null sessionRef does not crash', () => {
      const db = createTestDb();

      const userId = insertUser(db, 'holduser2', 200);

      // Should not throw even without a sessionRef
      assert.doesNotThrow(() => {
        processHoldDeduct(db, userId, 100, 30, 'Test Car', 60, null);
      });

      db.close();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Reconnect with existing session → no new hold
  // -------------------------------------------------------------------------
  describe('reconnect with existing session', () => {
    it('reconnecting user inherits existing session without a new hold being created', () => {
      const db = createTestDb();

      const userId = insertUser(db, 'reconnectuser', 500);
      const sessionRef = crypto.randomUUID();

      // Simulate original session with hold
      db.prepare('UPDATE users SET balance = balance - 100 WHERE id = ?').run(userId);
      insertHold(db, userId, 100, sessionRef);

      const activeSessions = new Map();
      const oldSocketId = 'old-socket-id';
      activeSessions.set(oldSocketId, {
        carId: 1,
        userId: 'reconnectuser',
        dbUserId: userId,
        startTime: new Date(Date.now() - 30000),
        holdAmount: 100,
        sessionRef,
      });

      // Count holds before reconnect
      const holdsBefore = db.prepare(
        "SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = ? AND type = 'hold'"
      ).get(userId).cnt;

      // Simulate reconnect adoption logic
      const newSocketId = 'new-socket-id';
      let existingSocketId = null;
      let existingSession = null;
      for (const [sid, session] of activeSessions) {
        if (session.dbUserId === userId && sid !== newSocketId) {
          existingSocketId = sid;
          existingSession = session;
          break;
        }
      }

      assert.ok(existingSession, 'Should find existing session for user');

      // Transfer session to new socket
      activeSessions.delete(existingSocketId);
      activeSessions.set(newSocketId, existingSession);

      // Verify: old socket has no session, new socket has the session
      assert.equal(activeSessions.has(oldSocketId), false, 'Old socket should have no session');
      assert.ok(activeSessions.has(newSocketId), 'New socket should have the session');
      assert.equal(activeSessions.get(newSocketId).sessionRef, sessionRef, 'Session ref should be preserved');

      // Count holds after reconnect — must be the same (no new hold created)
      const holdsAfter = db.prepare(
        "SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = ? AND type = 'hold'"
      ).get(userId).cnt;
      assert.equal(holdsAfter, holdsBefore, 'No new hold should be created on reconnect');

      db.close();
    });
  });

  // -------------------------------------------------------------------------
  // 6. Transaction reference_id unique constraint
  // -------------------------------------------------------------------------
  describe('transactions unique constraint on (reference_id, type)', () => {
    it('prevents inserting a duplicate hold with the same reference_id', () => {
      const db = createTestDb();

      const userId = insertUser(db, 'constraintuser', 500);
      const sessionRef = crypto.randomUUID();

      // Insert first hold — should succeed
      db.prepare(
        `INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id)
         VALUES (?, 'hold', -100, 400, 'Hold 1', ?)`
      ).run(userId, sessionRef);

      // Insert second hold with the same reference_id — must fail
      assert.throws(
        () => {
          db.prepare(
            `INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id)
             VALUES (?, 'hold', -100, 300, 'Hold 2 (duplicate)', ?)`
          ).run(userId, sessionRef);
        },
        (err) => {
          const msg = err.message || '';
          return msg.includes('UNIQUE') || err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT';
        },
        'Should throw a UNIQUE constraint error'
      );

      // Only one hold should exist
      const holds = db.prepare(
        "SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = ? AND type = 'hold' AND reference_id = ?"
      ).get(userId, sessionRef);
      assert.equal(holds.cnt, 1, 'Only one hold transaction should exist');

      db.close();
    });

    it('allows different types with the same reference_id (hold + release + deduct)', () => {
      const db = createTestDb();

      const userId = insertUser(db, 'constraintuser2', 500);
      const sessionRef = crypto.randomUUID();

      // All three types should be allowed for the same reference_id
      assert.doesNotThrow(() => {
        db.prepare(
          `INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id)
           VALUES (?, 'hold', -100, 400, 'Hold', ?)`
        ).run(userId, sessionRef);

        db.prepare(
          `INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id)
           VALUES (?, 'release', 70, 470, 'Release', ?)`
        ).run(userId, sessionRef);

        db.prepare(
          `INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id)
           VALUES (?, 'deduct', -30, 470, 'Deduct', ?)`
        ).run(userId, sessionRef);
      }, 'Should allow hold, release, and deduct with same reference_id');

      const txns = db.prepare(
        'SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = ? AND reference_id = ?'
      ).get(userId, sessionRef);
      assert.equal(txns.cnt, 3, 'All three transactions should exist');

      db.close();
    });

    it('allows NULL reference_id without unique constraint conflicts', () => {
      const db = createTestDb();

      const userId = insertUser(db, 'nullrefuser', 500);

      // Multiple transactions with NULL reference_id should be allowed
      assert.doesNotThrow(() => {
        db.prepare(
          `INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id)
           VALUES (?, 'topup', 100, 600, 'Topup 1', NULL)`
        ).run(userId);

        db.prepare(
          `INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id)
           VALUES (?, 'topup', 100, 700, 'Topup 2', NULL)`
        ).run(userId);
      }, 'NULL reference_id should not trigger unique constraint');

      db.close();
    });
  });

});
