'use strict';

/**
 * Money regression tests — Task 7.6
 *
 * Covers hold→deduct→release invariants, double-charge prevention,
 * and orphan hold recovery.
 *
 * Uses Node.js built-in test runner (node:test).
 * Run with: node --test tests/unit/money_regression.test.js
 *
 * Tests use a mix of:
 *   - Direct function calls (processHoldDeduct extracted from socket closure)
 *   - Real Socket.IO server for hold-creation and session-end flows
 *   - startupRecovery for orphan recovery
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { Server: SocketServer } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const crypto = require('crypto');
const { openDatabase } = require('../../db/connection');
const { setupSocketIo } = require('../../socket/index');
const { runMigrations } = require('../../db/migrate');
const startupRecovery = require('../../lib/startup-recovery');

// Force-exit after all tests complete.
after(() => setImmediate(() => process.exit(0)));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_EVENT_TIMEOUT_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal metrics stub. */
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

/** Create an in-memory DB with migrations applied. */
function createTestDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

/** Insert a user and return its DB id. */
function insertUser(db, username, balance) {
  return db.prepare(
    `INSERT INTO users (username, username_normalized, email, email_normalized, password_hash, status, role, balance)
     VALUES (?, ?, ?, ?, 'hash', 'active', 'user', ?)`
  ).run(username, username.toLowerCase(), `${username}@test.com`, `${username}@test.com`, balance).lastInsertRowid;
}

/** Insert a hold transaction directly (simulates session start). */
function insertHold(db, userId, amount, referenceId) {
  return db.prepare(
    `INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id)
     VALUES (?, 'hold', ?, 0, 'Hold', ?)`
  ).run(userId, -Math.abs(amount), referenceId).lastInsertRowid;
}

/**
 * Minimal processHoldDeduct extracted from socket/index.js for direct unit testing.
 * Mirrors the real implementation exactly.
 */
function processHoldDeduct(db, dbUserId, holdAmount, actualCost, carName, durationSeconds, sessionRef) {
  const ref = sessionRef || null;
  try {
    db.transaction(() => {
      if (ref) {
        const existingDeduct = db.prepare(
          "SELECT 1 FROM transactions WHERE reference_id = ? AND type = 'deduct' LIMIT 1"
        ).get(ref);
        if (existingDeduct) return; // idempotent
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
// Socket server helpers (shared across socket-based money tests)
// ---------------------------------------------------------------------------

function makeSaveRentalSession(db, CARS) {
  return (dbUserId, carId, durationSeconds, cost, sessionRef, terminationReason) => {
    if (!dbUserId) return;
    const carName = (CARS.find((c) => c.id === carId) || {}).name || ('Машина #' + carId);
    try {
      db.prepare(
        `INSERT INTO rental_sessions
           (user_id, car_id, car_name, duration_seconds, cost, session_ref, termination_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(dbUserId, carId, carName, durationSeconds, cost, sessionRef || null, terminationReason || null);
    } catch (_) { /* ignore */ }
  };
}

function createSocketServer(sessionUserId) {
  const db = createTestDb();
  const CARS = [{ id: 1, name: 'Test Car', model: 'Drift Car', cameraUrl: '' }];

  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, password_hash, status, role, balance)
     VALUES (?, ?, ?, 'hash', ?, ?, 500)`
  ).run(1, 'moneyuser', 'money@t.com', 'active', 'user');

  const httpServer = http.createServer();
  const io = new SocketServer(httpServer, {
    cors: { origin: '*' },
    connectTimeout: 500,
    pingTimeout: 200,
    pingInterval: 300,
  });

  const metrics = {
    log() {}, recordError() {}, recordCommand() {}, recordLatency() {}, clearLatency() {},
  };

  const socketState = setupSocketIo(io, {
    db,
    sessionMiddleware: (req, _res, next) => { req.session = { userId: sessionUserId }; next(); },
    metrics,
    RATE_PER_MINUTE: 10,
    SESSION_MAX_DURATION_MS: 10 * 60 * 1000,
    INACTIVITY_TIMEOUT_MS: 2 * 60 * 1000,
    CONTROL_RATE_LIMIT_MAX: 20,
    CONTROL_RATE_LIMIT_WINDOW_MS: 1000,
    CARS,
    saveRentalSession: makeSaveRentalSession(db, CARS),
  });

  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address();
      httpServer.unref();
      resolve({ server: httpServer, io, db, socketState, url: `http://127.0.0.1:${port}` });
    });
  });
}

function teardown(ctx) {
  return new Promise((resolve) => {
    clearInterval(ctx.socketState.heartbeatCheckInterval);
    clearInterval(ctx.socketState.chatPruneInterval);
    ctx.io.disconnectSockets(true);
    ctx.io.close(() => {
      ctx.server.close(() => {
        try { ctx.db.close(); } catch (_) {}
        resolve();
      });
    });
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { autoConnect: false, reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
    socket.connect();
  });
}

function emitAndWait(socket, emitEvent, emitData, responseEvent, timeoutMs = DEFAULT_EVENT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for ${responseEvent} (sent ${emitEvent})`)),
      timeoutMs
    );
    socket.once(responseEvent, (data) => { clearTimeout(timer); resolve(data); });
    if (emitData !== undefined) {
      socket.emit(emitEvent, emitData);
    } else {
      socket.emit(emitEvent);
    }
  });
}

// ---------------------------------------------------------------------------
// A. Hold created when session starts (via real socket server)
// ---------------------------------------------------------------------------

describe('money regression — hold created on session start', () => {
  let ctx;
  before(async () => { ctx = await createSocketServer(1); });
  after(() => teardown(ctx));

  it('start_session deducts hold from balance and inserts hold transaction', async () => {
    const balBefore = ctx.db.prepare('SELECT balance FROM users WHERE id = 1').get().balance;
    assert.strictEqual(balBefore, 500, 'Initial balance must be 500');

    const s = await connect(ctx.url);
    try {
      const started = await emitAndWait(s, 'start_session', { carId: 1 }, 'session_started');
      const sessionRef = started.sessionRef;

      // Balance must have decreased by HOLD_AMOUNT (100)
      const balAfter = ctx.db.prepare('SELECT balance FROM users WHERE id = 1').get().balance;
      assert.strictEqual(balAfter, 400, 'Balance must decrease by 100 after hold');

      // Exactly one hold transaction for this sessionRef
      const holds = ctx.db.prepare(
        "SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = 1 AND type = 'hold' AND reference_id = ?"
      ).get(sessionRef);
      assert.strictEqual(holds.cnt, 1, 'Exactly one hold transaction must exist');

      // Hold amount must be negative (funds removed from balance)
      const hold = ctx.db.prepare(
        "SELECT amount FROM transactions WHERE user_id = 1 AND type = 'hold' AND reference_id = ?"
      ).get(sessionRef);
      assert.ok(hold.amount < 0, 'Hold amount must be negative');

      // Clean up
      await emitAndWait(s, 'end_session', undefined, 'session_ended');
    } finally {
      s.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// B. Deduct + release flow at session end (via real socket server)
// ---------------------------------------------------------------------------

describe('money regression — deduct and release on session end', () => {
  let ctx;
  before(async () => { ctx = await createSocketServer(1); });
  after(() => teardown(ctx));

  it('end_session creates deduct and (if applicable) release transactions', async () => {
    const s = await connect(ctx.url);
    try {
      const started = await emitAndWait(s, 'start_session', { carId: 1 }, 'session_started');
      const sessionRef = started.sessionRef;

      await emitAndWait(s, 'end_session', undefined, 'session_ended');

      // Deduct must exist
      const deduct = ctx.db.prepare(
        "SELECT * FROM transactions WHERE user_id = 1 AND type = 'deduct' AND reference_id = ?"
      ).get(sessionRef);
      assert.ok(deduct, 'Deduct transaction must exist after end_session');
      assert.ok(deduct.amount <= 0, 'Deduct amount must be <= 0');

      // Because cost = durationMinutes * RATE_PER_MINUTE and the session is very short
      // (< 1 second), cost ≈ 0 which is < holdAmount (100).
      // Therefore a release transaction must also exist.
      const release = ctx.db.prepare(
        "SELECT * FROM transactions WHERE user_id = 1 AND type = 'release' AND reference_id = ?"
      ).get(sessionRef);
      assert.ok(release, 'Release transaction must exist when cost < hold amount');
      assert.ok(release.amount > 0, 'Release amount must be positive (credit back)');

      // Total balance change: balance = 500 - 100 (hold) + release_amount - actual_cost
      // Since cost ≈ 0 for a sub-second session, balance ≈ 500
      const balFinal = ctx.db.prepare('SELECT balance FROM users WHERE id = 1').get().balance;
      assert.ok(balFinal > 400, 'Balance must be largely restored after release');
    } finally {
      s.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// C. No double deduct on duplicate session end (direct function + socket)
// ---------------------------------------------------------------------------

describe('money regression — no double deduct', () => {
  it('processHoldDeduct called twice with same sessionRef yields exactly one deduct', () => {
    const db = createTestDb();
    const userId = insertUser(db, 'noDoubleUser', 0);
    const sessionRef = crypto.randomUUID();
    const holdAmount = 100;
    const actualCost = 30;

    // First call
    processHoldDeduct(db, userId, holdAmount, actualCost, 'Test Car', 60, sessionRef);

    const after1 = db.prepare(
      "SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = ? AND type = 'deduct' AND reference_id = ?"
    ).get(userId, sessionRef);
    assert.strictEqual(after1.cnt, 1, 'Exactly one deduct after first call');

    // Second call — must be idempotent
    processHoldDeduct(db, userId, holdAmount, actualCost, 'Test Car', 60, sessionRef);

    const after2 = db.prepare(
      "SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = ? AND type = 'deduct' AND reference_id = ?"
    ).get(userId, sessionRef);
    assert.strictEqual(after2.cnt, 1, 'Still exactly one deduct after second call (no double charge)');

    const releases = db.prepare(
      "SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = ? AND type = 'release' AND reference_id = ?"
    ).get(userId, sessionRef);
    assert.strictEqual(releases.cnt, 1, 'Exactly one release (no double release)');

    db.close();
  });

  it('double end_session via socket does not double-charge the user', async () => {
    const ctx = await createSocketServer(1);
    const s = await connect(ctx.url);
    try {
      const started = await emitAndWait(s, 'start_session', { carId: 1 }, 'session_started');
      const sessionRef = started.sessionRef;

      await emitAndWait(s, 'end_session', undefined, 'session_ended');

      // Second end — must return session_error
      const err = await emitAndWait(s, 'end_session', undefined, 'session_error');
      assert.strictEqual(err.code, 'no_active_session');

      // Single deduct in DB
      const deducts = ctx.db.prepare(
        "SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = 1 AND type = 'deduct' AND reference_id = ?"
      ).get(sessionRef);
      assert.strictEqual(deducts.cnt, 1, 'Exactly one deduct after double end_session via socket');
    } finally {
      s.disconnect();
      await teardown(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// D. Hold→deduct→release flow correctness (direct unit test)
// ---------------------------------------------------------------------------

describe('money regression — hold→deduct→release invariants', () => {
  it('full flow: hold deducted from balance; release returns unused hold; deduct records actual cost', () => {
    const db = createTestDb();
    const initialBalance = 200;
    const userId = insertUser(db, 'flowUser', initialBalance);
    const sessionRef = crypto.randomUUID();
    const holdAmount = 100;
    const actualCost = 30;

    // Simulate hold (session start): deduct hold from balance
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(holdAmount, userId);
    insertHold(db, userId, holdAmount, sessionRef);

    const balAfterHold = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;
    assert.strictEqual(balAfterHold, initialBalance - holdAmount,
      'Balance must decrease by holdAmount after hold');

    // Simulate session end: processHoldDeduct with actualCost < holdAmount
    processHoldDeduct(db, userId, holdAmount, actualCost, 'Test Car', 60, sessionRef);

    const balAfterEnd = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;
    // Expected: initialBalance - holdAmount + (holdAmount - actualCost) - actualCost
    //         = initialBalance - actualCost - actualCost
    // Wait: hold already deducted. processHoldDeduct adds back release and deducts cost.
    // balance after hold: initialBalance - holdAmount
    // processHoldDeduct releases (holdAmount - actualCost), deducts actualCost
    // net: balance = (initialBalance - holdAmount) + (holdAmount - actualCost) = initialBalance - actualCost
    const expectedBalance = initialBalance - actualCost;
    assert.strictEqual(
      Math.round(balAfterEnd * 100) / 100,
      expectedBalance,
      'Final balance must equal initialBalance minus actualCost'
    );

    // Verify transaction types
    const txs = db.prepare(
      "SELECT type, amount FROM transactions WHERE reference_id = ? ORDER BY id"
    ).all(sessionRef);

    const types = txs.map((t) => t.type);
    assert.ok(types.includes('hold'), 'Must have hold transaction');
    assert.ok(types.includes('release'), 'Must have release transaction');
    assert.ok(types.includes('deduct'), 'Must have deduct transaction');

    db.close();
  });

  it('cost equals hold: no release transaction is created', () => {
    const db = createTestDb();
    const userId = insertUser(db, 'exactCostUser', 100);
    const sessionRef = crypto.randomUUID();
    const holdAmount = 100;
    const actualCost = 100; // exactly equal — no release needed

    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(holdAmount, userId);
    insertHold(db, userId, holdAmount, sessionRef);

    processHoldDeduct(db, userId, holdAmount, actualCost, 'Test Car', 60, sessionRef);

    const release = db.prepare(
      "SELECT 1 FROM transactions WHERE reference_id = ? AND type = 'release'"
    ).get(sessionRef);
    assert.ok(!release, 'No release transaction when cost equals hold amount');

    const deduct = db.prepare(
      "SELECT * FROM transactions WHERE reference_id = ? AND type = 'deduct'"
    ).get(sessionRef);
    assert.ok(deduct, 'Deduct transaction must exist');

    db.close();
  });
});

// ---------------------------------------------------------------------------
// E. Orphan hold recovery via startupRecovery
// ---------------------------------------------------------------------------

describe('money regression — orphan hold recovery', () => {
  it('startupRecovery refunds an orphan hold (no matching release/deduct)', () => {
    const db = createTestDb();
    const metrics = makeMetrics();

    const userId = insertUser(db, 'orphanUser', 50);
    const sessionRef = crypto.randomUUID();
    const holdAmount = 100;

    // Simulate a server restart mid-session: balance was deducted, hold row exists,
    // but no matching release/deduct (server crashed before end_session).
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(holdAmount, userId);
    insertHold(db, userId, holdAmount, sessionRef);

    const balBeforeRecovery = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;
    assert.strictEqual(balBeforeRecovery, -50, 'Balance must be negative after orphan hold');

    const summary = startupRecovery(db, metrics);

    assert.strictEqual(summary.orphanHoldsRecovered, 1, 'Must recover exactly 1 orphan hold');

    const balAfterRecovery = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;
    assert.strictEqual(balAfterRecovery, 50, 'Balance must be restored after orphan recovery');

    // Release transaction must be present
    const release = db.prepare(
      "SELECT * FROM transactions WHERE user_id = ? AND type = 'release' AND reference_id = ?"
    ).get(userId, sessionRef);
    assert.ok(release, 'Release transaction must be inserted by startupRecovery');
    assert.ok(
      release.description && release.description.includes('Автовосстановление'),
      'Release description must mention auto-recovery'
    );

    db.close();
  });

  it('startupRecovery does not release a hold that is already settled (has deduct)', () => {
    const db = createTestDb();
    const metrics = makeMetrics();

    const userId = insertUser(db, 'settledUser', 100);
    const sessionRef = crypto.randomUUID();
    const holdAmount = 100;
    const actualCost = 30;

    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(holdAmount, userId);
    insertHold(db, userId, holdAmount, sessionRef);

    // Settle the hold (simulate normal session end before restart)
    processHoldDeduct(db, userId, holdAmount, actualCost, 'Test Car', 60, sessionRef);

    const balBeforeRecovery = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;

    const summary = startupRecovery(db, metrics);

    // This hold is already settled — must NOT be recovered again
    assert.strictEqual(summary.orphanHoldsRecovered, 0, 'Settled hold must not be recovered');

    const balAfterRecovery = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;
    assert.strictEqual(balAfterRecovery, balBeforeRecovery, 'Balance must not change for settled hold');

    db.close();
  });

  it('startupRecovery handles multiple orphan holds independently', () => {
    const db = createTestDb();
    const metrics = makeMetrics();

    const user1 = insertUser(db, 'orphanA', 50);
    const user2 = insertUser(db, 'orphanB', 50);
    const ref1 = crypto.randomUUID();
    const ref2 = crypto.randomUUID();

    db.prepare('UPDATE users SET balance = balance - 100 WHERE id = ?').run(user1);
    db.prepare('UPDATE users SET balance = balance - 100 WHERE id = ?').run(user2);
    insertHold(db, user1, 100, ref1);
    insertHold(db, user2, 100, ref2);

    const summary = startupRecovery(db, metrics);

    assert.strictEqual(summary.orphanHoldsRecovered, 2, 'Both orphan holds must be recovered');

    const bal1 = db.prepare('SELECT balance FROM users WHERE id = ?').get(user1).balance;
    const bal2 = db.prepare('SELECT balance FROM users WHERE id = ?').get(user2).balance;
    assert.strictEqual(bal1, 50, 'User 1 balance must be restored');
    assert.strictEqual(bal2, 50, 'User 2 balance must be restored');

    db.close();
  });
});
