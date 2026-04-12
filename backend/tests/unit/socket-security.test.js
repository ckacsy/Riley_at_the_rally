'use strict';

/**
 * Socket security tests — Task 7.1
 *
 * Tests that privileged socket events:
 *   1. Reject unauthenticated requests (no userId in session)
 *   2. Reject banned/inactive users where status check is required
 *   3. Reject malformed / out-of-range payloads
 *   4. Enforce rate limits
 *
 * Uses Node.js built-in test runner (node:test) + socket.io-client.
 * Run with: node tests/unit/socket-security.test.js
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
 * Create an in-memory test server.
 *
 * @param {number|null} sessionUserId  userId in socket.request.session (null = unauthenticated)
 * @returns {Promise<{server, io, db, socketState, url}>}
 */
function createTestServer(sessionUserId) {
  const db = openDatabase(':memory:');
  runMigrations(db);

  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, password_hash, status, role, balance)
     VALUES (?, ?, ?, 'hash', ?, ?, 200)`
  ).run(1, 'activeuser',  'active@t.com',  'active', 'user');
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, password_hash, status, role, balance)
     VALUES (?, ?, ?, 'hash', ?, ?, 200)`
  ).run(2, 'banneduser',  'banned@t.com',  'banned', 'user');
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, password_hash, status, role, balance)
     VALUES (?, ?, ?, 'hash', ?, ?, 200)`
  ).run(3, 'adminuser',   'admin@t.com',   'active', 'admin');

  const httpServer = http.createServer();
  const io = new SocketServer(httpServer, {
    cors: { origin: '*' },
    connectTimeout: 500,
    pingTimeout: 200,
    pingInterval: 300,
  });

  const metrics = { log() {}, recordError() {}, recordCommand() {}, recordLatency() {}, clearLatency() {} };

  const socketState = setupSocketIo(io, {
    db,
    sessionMiddleware: (req, _res, next) => { req.session = { userId: sessionUserId }; next(); },
    metrics,
    RATE_PER_MINUTE: 10,
    SESSION_MAX_DURATION_MS: 10 * 60 * 1000,
    INACTIVITY_TIMEOUT_MS: 2 * 60 * 1000,
    CONTROL_RATE_LIMIT_MAX: 20,
    CONTROL_RATE_LIMIT_WINDOW_MS: 1000,
    CARS: [{ id: 1, name: 'Test Car', model: 'Drift Car', cameraUrl: '' }],
    saveRentalSession: () => {},
  });

  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address();
      // Unref the server so it doesn't prevent process exit once tests are done
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
function emitAndWait(socket, emitEvent, emitData, responseEvent, timeoutMs = 800) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${responseEvent} (sent ${emitEvent})`)), timeoutMs);
    socket.once(responseEvent, (data) => { clearTimeout(timer); resolve(data); });
    emitData !== undefined ? socket.emit(emitEvent, emitData) : socket.emit(emitEvent);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Pure unit tests — validators.js (no server needed)
// ---------------------------------------------------------------------------

describe('socket validators — unit', () => {
  const {
    requireAuth, requireActiveUser, requireSessionOwner,
    socketRateLimit, validatePayload,
  } = require('../../socket/validators');

  it('requireAuth returns userId from session', () => {
    assert.strictEqual(requireAuth({ request: { session: { userId: 42 } } }), 42);
  });

  it('requireAuth returns null when no session / no userId', () => {
    assert.strictEqual(requireAuth({ request: {} }), null);
    assert.strictEqual(requireAuth({ request: { session: {} } }), null);
    assert.strictEqual(requireAuth({ request: { session: { userId: null } } }), null);
  });

  it('requireActiveUser returns user for active session', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    db.prepare(`INSERT OR IGNORE INTO users (id, username, email, password_hash, status, role, balance)
      VALUES (99, 'u', 'u@t.com', 'h', 'active', 'user', 0)`).run();
    const user = requireActiveUser({ request: { session: { userId: 99 } } }, db);
    assert.ok(user && user.status === 'active');
    db.close();
  });

  it('requireActiveUser returns null for banned user', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    db.prepare(`INSERT OR IGNORE INTO users (id, username, email, password_hash, status, role, balance)
      VALUES (98, 'b', 'b@t.com', 'h', 'banned', 'user', 0)`).run();
    assert.strictEqual(requireActiveUser({ request: { session: { userId: 98 } } }, db), null);
    db.close();
  });

  it('requireSessionOwner returns session when userId matches', () => {
    const sessions = new Map([['sid1', { dbUserId: 5, carId: 1 }]]);
    const session = requireSessionOwner({ id: 'sid1', request: { session: { userId: 5 } } }, sessions);
    assert.ok(session && session.carId === 1);
  });

  it('requireSessionOwner returns null when userId does not match (session hijacking)', () => {
    const sessions = new Map([['sid1', { dbUserId: 5, carId: 1 }]]);
    // Attacker has socket.id but different userId
    assert.strictEqual(requireSessionOwner({ id: 'sid1', request: { session: { userId: 99 } } }, sessions), null);
  });

  it('requireSessionOwner returns null when no session in map', () => {
    assert.strictEqual(requireSessionOwner({ id: 'nope', request: { session: { userId: 5 } } }, new Map()), null);
  });

  it('socketRateLimit allows calls within limit', () => {
    const m = new Map();
    assert.strictEqual(socketRateLimit(m, 'k', 3, 1000), true);
    assert.strictEqual(socketRateLimit(m, 'k', 3, 1000), true);
    assert.strictEqual(socketRateLimit(m, 'k', 3, 1000), true);
  });

  it('socketRateLimit blocks calls over limit', () => {
    const m = new Map();
    socketRateLimit(m, 'k', 2, 1000);
    socketRateLimit(m, 'k', 2, 1000);
    assert.strictEqual(socketRateLimit(m, 'k', 2, 1000), false);
  });

  it('socketRateLimit resets after window expires', async () => {
    const m = new Map();
    socketRateLimit(m, 'k', 1, 30); // window = 30ms
    assert.strictEqual(socketRateLimit(m, 'k', 1, 30), false); // blocked
    await sleep(40);
    assert.strictEqual(socketRateLimit(m, 'k', 1, 30), true); // window reset
  });

  it('validatePayload: valid data returns null', () => {
    const s = {
      direction: { type: 'string', required: true, enum: ['forward', 'backward', 'stop'] },
      speed: { type: 'number', required: true, min: -100, max: 100 },
    };
    assert.strictEqual(validatePayload({ direction: 'forward', speed: 50 }, s), null);
  });

  it('validatePayload: missing required field returns error', () => {
    const err = validatePayload({}, { direction: { type: 'string', required: true } });
    assert.ok(err && err.includes('direction'));
  });

  it('validatePayload: wrong type returns error', () => {
    assert.ok(validatePayload({ speed: 'fast' }, { speed: { type: 'number' } }));
  });

  it('validatePayload: out-of-range number returns error', () => {
    assert.ok(validatePayload({ speed: 200 }, { speed: { type: 'number', max: 100 } }));
  });

  it('validatePayload: invalid enum value returns error', () => {
    assert.ok(validatePayload({ d: 'sideways' }, { d: { type: 'string', enum: ['forward', 'backward'] } }));
  });
});

// ---------------------------------------------------------------------------
// Integration tests — unauthenticated (sessionUserId = null)
// ---------------------------------------------------------------------------

describe('socket security — unauthenticated requests', () => {
  let ctx;
  before(async () => { ctx = await createTestServer(null); });
  after(() => teardown(ctx));

  it('chat:send → auth_required', async () => {
    const s = await connect(ctx.url);
    const err = await emitAndWait(s, 'chat:send', { message: 'hi' }, 'chat:error');
    s.disconnect();
    assert.strictEqual(err.code, 'auth_required');
  });

  it('chat:delete → auth_required', async () => {
    ctx.db.prepare("INSERT OR IGNORE INTO chat_messages (id, user_id, username, text) VALUES (100, 1, 'u', 'msg')").run();
    const s = await connect(ctx.url);
    const err = await emitAndWait(s, 'chat:delete', { id: 100 }, 'chat:error');
    s.disconnect();
    assert.strictEqual(err.code, 'auth_required');
  });

  it('start_session → auth_required', async () => {
    const s = await connect(ctx.url);
    const err = await emitAndWait(s, 'start_session', { carId: 1 }, 'session_error');
    s.disconnect();
    assert.strictEqual(err.code, 'auth_required');
  });

  it('join_race → auth_required', async () => {
    const s = await connect(ctx.url);
    const err = await emitAndWait(s, 'join_race', {}, 'race_error');
    s.disconnect();
    assert.strictEqual(err.code, 'auth_required');
  });

  it('duel:search → auth_required', async () => {
    const s = await connect(ctx.url);
    const err = await emitAndWait(s, 'duel:search', undefined, 'duel:error');
    s.disconnect();
    assert.strictEqual(err.code, 'auth_required');
  });

  it('control_command without session → silently dropped (no error)', async () => {
    const s = await connect(ctx.url);
    let got = false;
    s.once('control_error', () => { got = true; });
    s.emit('control_command', { direction: 'forward', speed: 50 });
    await sleep(200);
    s.disconnect();
    assert.strictEqual(got, false, 'no session → silent drop');
  });
});

// ---------------------------------------------------------------------------
// Integration tests — banned user (sessionUserId = 2)
// ---------------------------------------------------------------------------

describe('socket security — banned user rejected', () => {
  let ctx;
  before(async () => { ctx = await createTestServer(2); });
  after(() => teardown(ctx));

  it('chat:send with banned user → chat:error', async () => {
    const s = await connect(ctx.url);
    const err = await emitAndWait(s, 'chat:send', { message: 'hi' }, 'chat:error');
    s.disconnect();
    assert.ok(['auth_required', 'forbidden'].includes(err.code), `unexpected code: ${err.code}`);
  });

  it('start_session with banned user → session_error (not auth_required)', async () => {
    const s = await connect(ctx.url);
    const err = await emitAndWait(s, 'start_session', { carId: 1 }, 'session_error');
    s.disconnect();
    assert.notStrictEqual(err.code, 'auth_required', 'banned user IS authenticated; should fail on status check');
    assert.ok(err.code, 'should have an error code');
  });

  it('join_race with banned user → race_error', async () => {
    const s = await connect(ctx.url);
    const err = await emitAndWait(s, 'join_race', {}, 'race_error');
    s.disconnect();
    assert.ok(err.code, 'should receive error code');
  });

  it('duel:search with banned user → duel:error with account_banned', async () => {
    const s = await connect(ctx.url);
    const err = await emitAndWait(s, 'duel:search', undefined, 'duel:error');
    s.disconnect();
    assert.strictEqual(err.code, 'account_banned');
  });
});

// ---------------------------------------------------------------------------
// Integration tests — input validation (no session needed)
// ---------------------------------------------------------------------------

describe('socket security — input validation (no session)', () => {
  let ctx;
  before(async () => { ctx = await createTestServer(1); });
  after(() => teardown(ctx));

  it('start_session: non-integer carId → invalid_car_id', async () => {
    const s = await connect(ctx.url);
    const err = await emitAndWait(s, 'start_session', { carId: 'bad' }, 'session_error');
    s.disconnect();
    assert.strictEqual(err.code, 'invalid_car_id');
  });

  it('start_session: carId=0 → invalid_car_id', async () => {
    const s = await connect(ctx.url);
    const err = await emitAndWait(s, 'start_session', { carId: 0 }, 'session_error');
    s.disconnect();
    assert.strictEqual(err.code, 'invalid_car_id');
  });

  it('start_session: unknown carId → session_error', async () => {
    const s = await connect(ctx.url);
    const err = await emitAndWait(s, 'start_session', { carId: 999 }, 'session_error');
    s.disconnect();
    assert.ok(err, 'should get error for unknown car');
  });

  it('chat:delete: non-integer id → silently dropped', async () => {
    const s = await connect(ctx.url);
    let got = false;
    s.once('chat:error', () => { got = true; });
    s.emit('chat:delete', { id: 'bad' });
    await sleep(200);
    s.disconnect();
    assert.strictEqual(got, false, 'non-integer id should be silently dropped before auth');
  });

  it('chat:delete: id=-1 → silently dropped', async () => {
    const s = await connect(ctx.url);
    let got = false;
    s.once('chat:error', () => { got = true; });
    s.emit('chat:delete', { id: -1 });
    await sleep(200);
    s.disconnect();
    assert.strictEqual(got, false, 'negative id silently dropped');
  });

  it('duel:checkpoint: negative index → duel:error', async () => {
    const s = await connect(ctx.url);
    const err = await emitAndWait(s, 'duel:checkpoint', { index: -1 }, 'duel:error');
    s.disconnect();
    assert.ok(err.code, 'should have error code');
  });

  it('presence:hello: invalid page → silently dropped', async () => {
    const s = await connect(ctx.url);
    let gotUpdate = false;
    // For non-control pages, server emits presence:update;
    // for invalid page it should be dropped silently
    s.once('presence:update', () => { gotUpdate = true; });
    s.emit('presence:hello', { page: 'evil_injection' });
    await sleep(200);
    s.disconnect();
    assert.strictEqual(gotUpdate, false, 'invalid page should be silently dropped');
  });
});

// ---------------------------------------------------------------------------
// Integration tests — control_command (active session required)
// Each test gets its own server to avoid car-busy collisions.
// ---------------------------------------------------------------------------

describe('socket security — control_command with active session', () => {
  it('unknown field in payload → invalid_payload', async () => {
    const ctx = await createTestServer(1);
    const s = await connect(ctx.url);
    try {
      await emitAndWait(s, 'start_session', { carId: 1 }, 'session_started');
      const err = await emitAndWait(s, 'control_command',
        { direction: 'forward', speed: 50, hack: 1 }, 'control_error');
      assert.strictEqual(err.code, 'invalid_payload');
    } finally {
      s.disconnect();
      await teardown(ctx);
    }
  });

  it('invalid direction → invalid_direction', async () => {
    const ctx = await createTestServer(1);
    const s = await connect(ctx.url);
    try {
      await emitAndWait(s, 'start_session', { carId: 1 }, 'session_started');
      const err = await emitAndWait(s, 'control_command',
        { direction: 'sideways' }, 'control_error');
      assert.strictEqual(err.code, 'invalid_direction');
    } finally {
      s.disconnect();
      await teardown(ctx);
    }
  });

  it('speed out of range → invalid_speed', async () => {
    const ctx = await createTestServer(1);
    const s = await connect(ctx.url);
    try {
      await emitAndWait(s, 'start_session', { carId: 1 }, 'session_started');
      const err = await emitAndWait(s, 'control_command',
        { speed: 999 }, 'control_error');
      assert.strictEqual(err.code, 'invalid_speed');
    } finally {
      s.disconnect();
      await teardown(ctx);
    }
  });

  it('valid command with correct owner → no error (silently forwarded)', async () => {
    const ctx = await createTestServer(1);
    const s = await connect(ctx.url);
    try {
      await emitAndWait(s, 'start_session', { carId: 1 }, 'session_started');
      let gotError = false;
      s.once('control_error', () => { gotError = true; });
      s.emit('control_command', { direction: 'forward', speed: 50 });
      await sleep(200);
      assert.strictEqual(gotError, false, 'valid command for correct owner should not produce error');
    } finally {
      s.disconnect();
      await teardown(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests — end_session userId cross-check
// ---------------------------------------------------------------------------

describe('socket security — end_session cross-check', () => {
  it('end_session without active session → no_active_session', async () => {
    const ctx = await createTestServer(1);
    const s = await connect(ctx.url);
    try {
      const err = await emitAndWait(s, 'end_session', undefined, 'session_error');
      assert.strictEqual(err.code, 'no_active_session');
    } finally {
      s.disconnect();
      await teardown(ctx);
    }
  });

  it('end_session with mismatched userId → forbidden', async () => {
    const ctx = await createTestServer(1);
    const s = await connect(ctx.url);
    try {
      // Inject a fake session into activeSessions that belongs to userId=2
      // but the socket's session says userId=1
      ctx.socketState.activeSessions.set(s.id, {
        dbUserId: 2,   // different user
        carId: 1,
        startTime: new Date(),
        holdAmount: 100,
        sessionRef: 'fake-ref',
        userId: 'banneduser',
      });
      const err = await emitAndWait(s, 'end_session', undefined, 'session_error');
      assert.strictEqual(err.code, 'forbidden');
    } finally {
      ctx.socketState.activeSessions.delete(s.id);
      s.disconnect();
      await teardown(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests — rate limits
// ---------------------------------------------------------------------------

describe('socket security — rate limits', () => {
  it('chat:delete: 11th delete in 10s → rate_limited (admin user)', async () => {
    const ctx = await createTestServer(3); // userId=3 (adminuser)
    for (let i = 200; i < 215; i++) {
      ctx.db.prepare("INSERT OR IGNORE INTO chat_messages (id, user_id, username, text) VALUES (?, 3, 'adminuser', 'msg')").run(i);
    }
    const s = await connect(ctx.url);
    try {
      for (let i = 0; i < 10; i++) {
        s.emit('chat:delete', { id: 200 + i });
        await sleep(5);
      }
      const err = await emitAndWait(s, 'chat:delete', { id: 214 }, 'chat:error');
      assert.strictEqual(err.code, 'rate_limited');
    } finally {
      s.disconnect();
      await teardown(ctx);
    }
  });

  it('duel:cancel_search: 11th call in 1s → rate_limited', async () => {
    const ctx = await createTestServer(1);
    const s = await connect(ctx.url);
    try {
      let rateLimited = false;
      s.on('duel:error', (e) => { if (e.code === 'rate_limited') rateLimited = true; });
      for (let i = 0; i < 11; i++) s.emit('duel:cancel_search');
      await sleep(200);
      assert.strictEqual(rateLimited, true, 'should be rate limited after 10 duel events/sec');
    } finally {
      s.disconnect();
      await teardown(ctx);
    }
  });

  it('join_race: 11th join in 1 min → rate_limited', async () => {
    const ctx = await createTestServer(1);
    const s = await connect(ctx.url);
    try {
      let rateLimited = false;
      s.on('race_error', (e) => { if (e.code === 'rate_limited') rateLimited = true; });
      for (let i = 0; i < 11; i++) { s.emit('join_race', {}); await sleep(5); }
      await sleep(300);
      assert.strictEqual(rateLimited, true, 'should be rate limited after 10 join_race per minute');
    } finally {
      s.disconnect();
      await teardown(ctx);
    }
  });

  it('presence:hello: 6th call in 1 min → silently dropped', async () => {
    const ctx = await createTestServer(1);
    const s = await connect(ctx.url);
    try {
      let updateCount = 0;
      s.on('presence:update', () => { updateCount++; });
      for (let i = 0; i < 6; i++) {
        s.emit('presence:hello', { page: 'broadcast' });
        await sleep(10);
      }
      await sleep(200);
      // First 5 get presence:update; 6th is silently dropped by rate limiter
      assert.ok(updateCount <= 5, `expected ≤5 updates, got ${updateCount}`);
    } finally {
      s.disconnect();
      await teardown(ctx);
    }
  });
});
