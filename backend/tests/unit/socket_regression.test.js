'use strict';

/**
 * Socket regression tests — Task 7.6
 *
 * Covers core Socket.IO flows using a real server instance + socket.io-client:
 *   1. connect → auth → start_session → control_command → end_session
 *      (happy path, with DB write assertions)
 *   2. double end_session is idempotent / safe
 *   3. reconnect behavior (disconnect auto-ends, new socket can start fresh)
 *   4. unauthorized privileged events are rejected
 *      (start_session, control_command, duel:search, chat:send, chat:delete)
 *
 * Uses Node.js built-in test runner (node:test) + socket.io-client.
 * Run with: node --test tests/unit/socket_regression.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { Server: SocketServer } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const { openDatabase } = require('../../db/connection');
const { setupSocketIo } = require('../../socket/index');
const { runMigrations } = require('../../db/migrate');

// Force-exit after all tests complete — socket.io internal timers otherwise
// keep the Node.js process alive indefinitely.
after(() => setImmediate(() => process.exit(0)));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_EVENT_TIMEOUT_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Close a Socket.IO server and the underlying HTTP server, then close the DB. */
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

/**
 * A real saveRentalSession implementation for tests — writes to the provided DB.
 * @param {import('better-sqlite3').Database} db
 * @param {Array<{id: number, name: string}>} CARS
 */
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

/**
 * Create an in-memory test server.
 *
 * @param {number|null} sessionUserId  userId in socket.request.session (null = unauthenticated)
 * @returns {Promise<{server, io, db, socketState, url}>}
 */
function createTestServer(sessionUserId) {
  const db = openDatabase(':memory:');
  runMigrations(db);

  // Active user with enough balance to start sessions (needs >= 100 RC)
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, password_hash, status, role, balance)
     VALUES (?, ?, ?, 'hash', ?, ?, 500)`
  ).run(1, 'testuser', 'test@t.com', 'active', 'user');

  // Admin user (for chat:delete tests)
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, password_hash, status, role, balance)
     VALUES (?, ?, ?, 'hash', ?, ?, 500)`
  ).run(2, 'adminuser', 'admin@t.com', 'active', 'admin');

  const CARS = [{ id: 1, name: 'Test Car', model: 'Drift Car', cameraUrl: '' }];

  const httpServer = http.createServer();
  const io = new SocketServer(httpServer, {
    cors: { origin: '*' },
    connectTimeout: 500,
    pingTimeout: 200,
    pingInterval: 300,
  });

  const metrics = {
    log() {},
    recordError() {},
    recordCommand() {},
    recordLatency() {},
    clearLatency() {},
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
      // Unref so it doesn't prevent process exit once tests are done
      httpServer.unref();
      resolve({ server: httpServer, io, db, socketState, url: `http://127.0.0.1:${port}` });
    });
  });
}

/** Connect a socket.io client; returns connected socket. */
function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { autoConnect: false, reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
    socket.connect();
  });
}

/** Emit an event and wait for responseEvent (rejects on timeout). */
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
// 1. Happy path — start_session → control_command → end_session
// ---------------------------------------------------------------------------

describe('socket regression — happy path', () => {
  let ctx;
  before(async () => { ctx = await createTestServer(1); });
  after(() => teardown(ctx));

  it('start_session emits session_started and creates hold transaction in DB', async () => {
    const s = await connect(ctx.url);
    try {
      const started = await emitAndWait(s, 'start_session', { carId: 1 }, 'session_started');

      assert.strictEqual(started.carId, 1, 'session_started.carId must be 1');
      assert.ok(started.sessionRef, 'session_started must include sessionRef');
      assert.ok(typeof started.sessionMaxDurationMs === 'number', 'session_started must include sessionMaxDurationMs');

      // DB: hold transaction must exist
      const hold = ctx.db.prepare(
        "SELECT * FROM transactions WHERE user_id = 1 AND type = 'hold' AND reference_id = ?"
      ).get(started.sessionRef);
      assert.ok(hold, 'Hold transaction must exist in DB');
      assert.ok(hold.amount < 0, 'Hold amount must be negative (funds blocked)');

      // DB: user balance must be reduced
      const balRow = ctx.db.prepare('SELECT balance FROM users WHERE id = 1').get();
      assert.ok(balRow.balance < 500, 'User balance must decrease after hold');

      // Clean up
      await emitAndWait(s, 'end_session', undefined, 'session_ended');
    } finally {
      s.disconnect();
    }
  });

  it('control_command during active session is forwarded without error', async () => {
    const s = await connect(ctx.url);
    try {
      await emitAndWait(s, 'start_session', { carId: 1 }, 'session_started');

      let gotError = false;
      s.once('control_error', () => { gotError = true; });
      s.emit('control_command', { direction: 'forward', speed: 50 });
      await sleep(300);
      assert.strictEqual(gotError, false, 'Valid control_command must not produce control_error');

      await emitAndWait(s, 'end_session', undefined, 'session_ended');
    } finally {
      s.disconnect();
    }
  });

  it('end_session emits session_ended and writes rental_session + deduct to DB', async () => {
    const s = await connect(ctx.url);
    try {
      const started = await emitAndWait(s, 'start_session', { carId: 1 }, 'session_started');
      const sessionRef = started.sessionRef;

      const ended = await emitAndWait(s, 'end_session', undefined, 'session_ended');
      assert.strictEqual(ended.carId, 1, 'session_ended.carId must be 1');
      assert.ok(typeof ended.durationSeconds === 'number', 'session_ended must include durationSeconds');
      assert.ok(typeof ended.cost === 'number', 'session_ended must include cost');

      // DB: deduct transaction must exist
      const deduct = ctx.db.prepare(
        "SELECT * FROM transactions WHERE user_id = 1 AND type = 'deduct' AND reference_id = ?"
      ).get(sessionRef);
      assert.ok(deduct, 'Deduct transaction must exist in DB after end_session');

      // DB: rental_sessions row must exist
      const rentalRow = ctx.db.prepare(
        'SELECT * FROM rental_sessions WHERE user_id = 1 AND session_ref = ?'
      ).get(sessionRef);
      assert.ok(rentalRow, 'rental_sessions row must exist after end_session');
      assert.ok(rentalRow.duration_seconds >= 0, 'rental_sessions.duration_seconds must be >= 0');
    } finally {
      s.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Double end_session — idempotent / safe
// ---------------------------------------------------------------------------

describe('socket regression — double end_session', () => {
  let ctx;
  before(async () => { ctx = await createTestServer(1); });
  after(() => teardown(ctx));

  it('second end_session returns no_active_session without double-charging', async () => {
    const s = await connect(ctx.url);
    try {
      const started = await emitAndWait(s, 'start_session', { carId: 1 }, 'session_started');
      const sessionRef = started.sessionRef;

      // First end — should succeed
      await emitAndWait(s, 'end_session', undefined, 'session_ended');

      // Second end — should return session_error
      const err = await emitAndWait(s, 'end_session', undefined, 'session_error');
      assert.strictEqual(err.code, 'no_active_session', 'Second end must return no_active_session');

      // Exactly one deduct transaction must exist (no double-charge)
      const deducts = ctx.db.prepare(
        "SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = 1 AND type = 'deduct' AND reference_id = ?"
      ).get(sessionRef);
      assert.strictEqual(deducts.cnt, 1, 'Must be exactly one deduct after double end_session');
    } finally {
      s.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Reconnect behavior
// ---------------------------------------------------------------------------

describe('socket regression — reconnect', () => {
  let ctx;
  before(async () => { ctx = await createTestServer(1); });
  after(() => teardown(ctx));

  it('disconnect during session auto-ends it; new socket can start a fresh session', async () => {
    // First connection: start a session then abruptly disconnect
    const s1 = await connect(ctx.url);
    const started1 = await emitAndWait(s1, 'start_session', { carId: 1 }, 'session_started');
    const firstRef = started1.sessionRef;

    // Disconnect — server handles the session teardown in the 'disconnect' handler
    s1.disconnect();
    // Give the server time to process the disconnect event
    await sleep(300);

    // activeSessions map must be empty after disconnect
    assert.strictEqual(
      ctx.socketState.activeSessions.size, 0,
      'activeSessions must be empty after socket disconnect'
    );

    // Deduct must have been written for the auto-ended session
    const deduct1 = ctx.db.prepare(
      "SELECT * FROM transactions WHERE user_id = 1 AND type = 'deduct' AND reference_id = ?"
    ).get(firstRef);
    assert.ok(deduct1, 'Deduct must be written when session ends on disconnect');

    // Second connection: must be able to start a new session without errors
    const s2 = await connect(ctx.url);
    try {
      const started2 = await emitAndWait(s2, 'start_session', { carId: 1 }, 'session_started');
      assert.ok(started2.sessionRef, 'New session must have a sessionRef');
      assert.notStrictEqual(
        started2.sessionRef, firstRef,
        'New sessionRef must differ from the previous one'
      );

      // End cleanly
      await emitAndWait(s2, 'end_session', undefined, 'session_ended');
    } finally {
      s2.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Unauthorized privileged events (unauthenticated socket)
// ---------------------------------------------------------------------------

describe('socket regression — unauthorized privileged events', () => {
  let ctx;
  // sessionUserId = null → socket.request.session.userId is falsy → unauthenticated
  before(async () => { ctx = await createTestServer(null); });
  after(() => teardown(ctx));

  it('start_session without auth → session_error auth_required', async () => {
    const s = await connect(ctx.url);
    try {
      const err = await emitAndWait(s, 'start_session', { carId: 1 }, 'session_error');
      assert.strictEqual(err.code, 'auth_required', 'Must reject with auth_required');
    } finally {
      s.disconnect();
    }
  });

  it('control_command without auth and no session → silently rejected (no crash)', async () => {
    // requireSessionOwner returns null → handler returns without emitting anything.
    // We verify: no control_error emitted and the server does not crash.
    const s = await connect(ctx.url);
    try {
      let gotControlError = false;
      s.once('control_error', () => { gotControlError = true; });
      s.emit('control_command', { direction: 'forward', speed: 50 });
      await sleep(300);
      assert.strictEqual(gotControlError, false, 'No control_error when no active session');
    } finally {
      s.disconnect();
    }
  });

  it('duel:search without auth → duel:error auth_required', async () => {
    const s = await connect(ctx.url);
    try {
      const err = await emitAndWait(s, 'duel:search', undefined, 'duel:error');
      assert.strictEqual(err.code, 'auth_required', 'duel:search must reject with auth_required');
    } finally {
      s.disconnect();
    }
  });

  it('chat:send without auth → chat:error auth_required', async () => {
    const s = await connect(ctx.url);
    try {
      const err = await emitAndWait(s, 'chat:send', { message: 'hello' }, 'chat:error');
      assert.strictEqual(err.code, 'auth_required', 'chat:send must reject with auth_required');
    } finally {
      s.disconnect();
    }
  });

  it('chat:delete without auth → chat:error auth_required', async () => {
    const s = await connect(ctx.url);
    try {
      const err = await emitAndWait(s, 'chat:delete', { id: 1 }, 'chat:error');
      assert.strictEqual(err.code, 'auth_required', 'chat:delete must reject with auth_required');
    } finally {
      s.disconnect();
    }
  });
});
