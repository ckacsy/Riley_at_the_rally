'use strict';

/**
 * Unit tests for backend/lib/duel-manager.js
 * Run with: node tests/unit/duel-manager.test.js
 * Uses Node.js built-in test runner (node:test), available since Node 18.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const DuelManager = require('../../lib/duel-manager');
const { DUEL_REQUIRED_CHECKPOINTS } = require('../../lib/rank-config');

// ---------------------------------------------------------------------------
// Test DB setup helpers
// ---------------------------------------------------------------------------

function createTestDb() {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      rank INTEGER DEFAULT 15,
      stars INTEGER DEFAULT 0,
      is_legend INTEGER DEFAULT 0,
      legend_position INTEGER,
      duels_won INTEGER DEFAULT 0,
      duels_lost INTEGER DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE duel_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season_id INTEGER DEFAULT 1,
      race_id TEXT NOT NULL,
      winner_id INTEGER,
      loser_id INTEGER,
      result_type TEXT NOT NULL,
      winner_lap_time_ms INTEGER,
      loser_lap_time_ms INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE player_ranks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      old_rank INTEGER,
      old_stars INTEGER,
      old_is_legend INTEGER DEFAULT 0,
      old_legend_position INTEGER,
      new_rank INTEGER,
      new_stars INTEGER,
      new_is_legend INTEGER DEFAULT 0,
      new_legend_position INTEGER,
      reason TEXT NOT NULL,
      race_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  return db;
}

function insertUser(db, id, opts = {}) {
  const rank = opts.rank ?? 15;
  const stars = opts.stars ?? 0;
  const isLegend = opts.isLegend ? 1 : 0;
  const legendPosition = opts.legendPosition ?? null;
  db.prepare(
    `INSERT INTO users (id, username, rank, stars, is_legend, legend_position, duels_won, duels_lost)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
  ).run(id, `user${id}`, rank, stars, isLegend, legendPosition);
}

// ---------------------------------------------------------------------------
// Mock io builder
// ---------------------------------------------------------------------------

/**
 * Creates a lightweight io mock that records emitted events per socketId.
 * Also exposes a `sockets.sockets` Map so DuelManager can find sockets.
 */
function createMockIo() {
  const socketStore = new Map(); // socketId -> { emitted: [{event, data}], ... }

  const mockIo = {
    sockets: {
      sockets: new Map(),
    },
  };

  function addSocket(socketId) {
    const emitted = [];
    const sock = {
      id: socketId,
      emit(event, data) {
        emitted.push({ event, data });
      },
      emitted,
    };
    mockIo.sockets.sockets.set(socketId, sock);
    socketStore.set(socketId, sock);
    return sock;
  }

  function removeSocket(socketId) {
    mockIo.sockets.sockets.delete(socketId);
    socketStore.delete(socketId);
  }

  return { mockIo, addSocket, removeSocket, socketStore };
}

/** Minimal metrics mock */
function createMockMetrics() {
  return {
    log: () => {},
    recordError: () => {},
  };
}

// ---------------------------------------------------------------------------
// Helper to advance the internal MIN_LAP_TIME_MS clock via fake timer
// We override Date.now() to fast-forward time within a test.
// ---------------------------------------------------------------------------

/** Sleep real milliseconds (for async tests). */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Perform a complete valid lap sequence for a player:
 *   handleStartLap → handleCheckpoint x DUEL_REQUIRED_CHECKPOINTS → handleFinishLap
 * To bypass MIN_LAP_TIME_MS, we monkey-patch Date.now before start and restore after.
 */
function performValidLap(manager, socketId) {
  // Patch currentLapStart to be far in the past so lap time passes MIN check
  const startResult = manager.handleStartLap(socketId);
  if (!startResult.ok) return startResult;

  // Reach into the internal duel to backdate the lap start
  const duel = manager.getDuelBySocketId(socketId);
  if (duel) {
    const player = duel.players.find((p) => p.socketId === socketId);
    if (player && player.currentLapStart) {
      player.currentLapStart -= 30_000; // subtract 30 s (> MIN_LAP_TIME_MS=15 s)
    }
  }

  for (let i = 0; i < DUEL_REQUIRED_CHECKPOINTS; i++) {
    const cpResult = manager.handleCheckpoint(socketId, i);
    if (!cpResult.ok) return cpResult;
  }

  return manager.handleFinishLap(socketId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DuelManager — queue and matching', () => {
  let db, mockIo, addSocket, manager;

  beforeEach(() => {
    db = createTestDb();
    ({ mockIo, addSocket } = createMockIo());
    manager = new DuelManager({ db, io: mockIo, metrics: createMockMetrics() });
    insertUser(db, 1, { rank: 10, stars: 1 });
    insertUser(db, 2, { rank: 10, stars: 2 });
    insertUser(db, 3, { rank: 5, stars: 0 });  // far from rank 10
    insertUser(db, 4, { rank: 1, stars: 3 });  // will become Legend test
  });

  afterEach(() => {
    manager.clear();
    db.close();
  });

  test('isInQueue returns false before joining', () => {
    assert.equal(manager.isInQueue(1), false);
  });

  test('addToQueue: first player is queued, not matched', () => {
    addSocket('s1');
    const result = manager.addToQueue({
      userId: 1, socketId: 's1', username: 'user1',
      rank: 10, stars: 1, isLegend: false, legendPosition: null, carId: 1,
    });
    assert.equal(result.queued, true);
    assert.equal(manager.isInQueue(1), true);
  });

  test('addToQueue: two eligible players → immediate match', () => {
    addSocket('s1');
    addSocket('s2');
    manager.addToQueue({
      userId: 1, socketId: 's1', username: 'user1',
      rank: 10, stars: 1, isLegend: false, legendPosition: null, carId: 1,
    });
    const result = manager.addToQueue({
      userId: 2, socketId: 's2', username: 'user2',
      rank: 10, stars: 2, isLegend: false, legendPosition: null, carId: 2,
    });
    assert.equal(result.matched, true);
    assert.ok(result.duel);
    assert.equal(manager.isInQueue(1), false);
    assert.equal(manager.isInQueue(2), false);
  });

  test('addToQueue: players with rank difference > 2 are not matched', () => {
    addSocket('s1');
    addSocket('s3');
    manager.addToQueue({
      userId: 1, socketId: 's1', username: 'user1',
      rank: 10, stars: 1, isLegend: false, legendPosition: null, carId: 1,
    });
    const result = manager.addToQueue({
      userId: 3, socketId: 's3', username: 'user3',
      rank: 5, stars: 0, isLegend: false, legendPosition: null, carId: 1,
    });
    assert.equal(result.queued, true);
    assert.equal(manager.isInQueue(1), true);
    assert.equal(manager.isInQueue(3), true);
  });

  test('addToQueue: Legend cannot match non-Legend', () => {
    insertUser(db, 5, { rank: 1, stars: 0, isLegend: true, legendPosition: 1 });
    addSocket('s1');
    addSocket('s5');
    manager.addToQueue({
      userId: 1, socketId: 's1', username: 'user1',
      rank: 10, stars: 1, isLegend: false, legendPosition: null, carId: 1,
    });
    const result = manager.addToQueue({
      userId: 5, socketId: 's5', username: 'user5',
      rank: 1, stars: 0, isLegend: true, legendPosition: 1, carId: 1,
    });
    assert.equal(result.queued, true);
  });

  test('removeFromQueue removes waiting player', () => {
    addSocket('s1');
    manager.addToQueue({
      userId: 1, socketId: 's1', username: 'user1',
      rank: 10, stars: 1, isLegend: false, legendPosition: null, carId: 1,
    });
    const result = manager.removeFromQueue(1);
    assert.equal(result.removed, true);
    assert.equal(manager.isInQueue(1), false);
  });

  test('getDuelStatus: searching while in queue', () => {
    addSocket('s1');
    manager.addToQueue({
      userId: 1, socketId: 's1', username: 'user1',
      rank: 10, stars: 1, isLegend: false, legendPosition: null, carId: 1,
    });
    assert.equal(manager.getDuelStatus(1), 'searching');
  });

  test('getDuelStatus: matched after pairing', () => {
    addSocket('s1');
    addSocket('s2');
    manager.addToQueue({
      userId: 1, socketId: 's1', username: 'user1',
      rank: 10, stars: 1, isLegend: false, legendPosition: null, carId: 1,
    });
    manager.addToQueue({
      userId: 2, socketId: 's2', username: 'user2',
      rank: 10, stars: 2, isLegend: false, legendPosition: null, carId: 2,
    });
    assert.equal(manager.getDuelStatus(1), 'matched');
    assert.equal(manager.getDuelStatus(2), 'matched');
  });

  test('duel:matched event is emitted to both sockets when matched', () => {
    const sockA = addSocket('s1');
    const sockB = addSocket('s2');
    manager.addToQueue({
      userId: 1, socketId: 's1', username: 'user1',
      rank: 10, stars: 1, isLegend: false, legendPosition: null, carId: 1,
    });
    manager.addToQueue({
      userId: 2, socketId: 's2', username: 'user2',
      rank: 10, stars: 2, isLegend: false, legendPosition: null, carId: 2,
    });
    const matchedA = sockA.emitted.find((e) => e.event === 'duel:matched');
    const matchedB = sockB.emitted.find((e) => e.event === 'duel:matched');
    assert.ok(matchedA, 'player A should receive duel:matched');
    assert.ok(matchedB, 'player B should receive duel:matched');
    assert.equal(matchedA.data.opponent.username, 'user2');
    assert.equal(matchedB.data.opponent.username, 'user1');
  });
});

// ---------------------------------------------------------------------------

describe('DuelManager — lap validation', () => {
  let db, mockIo, addSocket, manager;

  function setupMatchedDuel() {
    addSocket('sA');
    addSocket('sB');
    manager.addToQueue({
      userId: 1, socketId: 'sA', username: 'userA',
      rank: 10, stars: 0, isLegend: false, legendPosition: null, carId: 1,
    });
    manager.addToQueue({
      userId: 2, socketId: 'sB', username: 'userB',
      rank: 10, stars: 0, isLegend: false, legendPosition: null, carId: 2,
    });
  }

  beforeEach(() => {
    db = createTestDb();
    ({ mockIo, addSocket } = createMockIo());
    manager = new DuelManager({ db, io: mockIo, metrics: createMockMetrics() });
    insertUser(db, 1, { rank: 10, stars: 0 });
    insertUser(db, 2, { rank: 10, stars: 0 });
    setupMatchedDuel();
  });

  afterEach(() => {
    manager.clear();
    db.close();
  });

  test('handleStartLap transitions duel to in_progress', () => {
    const result = manager.handleStartLap('sA');
    assert.equal(result.ok, true);
    assert.equal(manager.getDuelStatus(1), 'in_progress');
  });

  test('handleStartLap twice fails', () => {
    manager.handleStartLap('sA');
    const result = manager.handleStartLap('sA');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'lap_already_started');
  });

  test('handleCheckpoint requires correct order', () => {
    manager.handleStartLap('sA');
    // Skip checkpoint 0, try to submit checkpoint 1 directly
    const result = manager.handleCheckpoint('sA', 1);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'wrong_checkpoint_order');
  });

  test('handleCheckpoint in order succeeds', () => {
    manager.handleStartLap('sA');
    for (let i = 0; i < DUEL_REQUIRED_CHECKPOINTS; i++) {
      const r = manager.handleCheckpoint('sA', i);
      assert.equal(r.ok, true, `checkpoint ${i} should succeed`);
    }
  });

  test('handleFinishLap rejected when checkpoints incomplete', () => {
    manager.handleStartLap('sA');
    // Only submit one checkpoint, not all
    manager.handleCheckpoint('sA', 0);
    const result = manager.handleFinishLap('sA');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'checkpoints_incomplete');
  });

  test('handleFinishLap rejected when lap is too fast', () => {
    manager.handleStartLap('sA');
    for (let i = 0; i < DUEL_REQUIRED_CHECKPOINTS; i++) {
      manager.handleCheckpoint('sA', i);
    }
    // Do NOT backdate currentLapStart — lap time will be ~0 ms < MIN_LAP_TIME_MS
    const result = manager.handleFinishLap('sA');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'lap_too_fast');
  });

  test('handleFinishLap without prior start is rejected', () => {
    const result = manager.handleFinishLap('sA');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'lap_not_started');
  });
});

// ---------------------------------------------------------------------------

describe('DuelManager — first valid finish wins', () => {
  let db, mockIo, addSocket, manager;

  beforeEach(() => {
    db = createTestDb();
    ({ mockIo, addSocket } = createMockIo());
    manager = new DuelManager({ db, io: mockIo, metrics: createMockMetrics() });
    insertUser(db, 1, { rank: 10, stars: 0 });
    insertUser(db, 2, { rank: 10, stars: 0 });
    addSocket('sA');
    addSocket('sB');
    manager.addToQueue({
      userId: 1, socketId: 'sA', username: 'userA',
      rank: 10, stars: 0, isLegend: false, legendPosition: null, carId: 1,
    });
    manager.addToQueue({
      userId: 2, socketId: 'sB', username: 'userB',
      rank: 10, stars: 0, isLegend: false, legendPosition: null, carId: 2,
    });
  });

  afterEach(() => {
    manager.clear();
    db.close();
  });

  test('first valid finish resolves duel immediately', () => {
    const result = performValidLap(manager, 'sA');
    assert.equal(result.ok, true);
    assert.equal(result.resolved, true);

    // Duel should now be gone from active maps
    assert.equal(manager.getDuelBySocketId('sA'), null);
    assert.equal(manager.getDuelBySocketId('sB'), null);
  });

  test('winner receives duel:result win, loser receives loss', () => {
    const sockA = mockIo.sockets.sockets.get('sA');
    const sockB = mockIo.sockets.sockets.get('sB');

    performValidLap(manager, 'sA');

    const resultA = sockA.emitted.find((e) => e.event === 'duel:result');
    const resultB = sockB.emitted.find((e) => e.event === 'duel:result');

    assert.ok(resultA, 'A should get duel:result');
    assert.ok(resultB, 'B should get duel:result');
    assert.equal(resultA.data.result, 'win');
    assert.equal(resultB.data.result, 'loss');
  });

  test('rank changes are applied after win', () => {
    performValidLap(manager, 'sA');

    const winner = db.prepare('SELECT rank, stars, duels_won FROM users WHERE id = 1').get();
    const loser = db.prepare('SELECT rank, stars, duels_lost FROM users WHERE id = 2').get();

    assert.equal(winner.duels_won, 1);
    assert.equal(loser.duels_lost, 1);
    // rank 10/0 + win → rank 10/1 (protected zone, no star loss on loss)
    assert.equal(winner.stars, 1);
    // rank 10/0 loss → protected zone, no change
    assert.equal(loser.stars, 0);
  });

  test('second finish attempt is ignored (duel already resolved)', () => {
    performValidLap(manager, 'sA');

    // Player B also tries to finish after the duel is resolved
    const resultB = performValidLap(manager, 'sB');
    assert.equal(resultB.ok, false);
    assert.equal(resultB.error, 'not_in_duel');
  });

  test('duel_results row is persisted exactly once', () => {
    performValidLap(manager, 'sA');

    // Try a second resolution — should be no-op
    performValidLap(manager, 'sB');

    const rows = db.prepare('SELECT * FROM duel_results').all();
    assert.equal(rows.length, 1, 'should have exactly one duel_results row');
    assert.equal(rows[0].result_type, 'win');
    assert.equal(rows[0].winner_id, 1);
    assert.equal(rows[0].loser_id, 2);
  });
});

// ---------------------------------------------------------------------------

describe('DuelManager — disconnect handling', () => {
  let db, mockIo, addSocket, manager;

  function setupMatchedDuel() {
    addSocket('sA');
    addSocket('sB');
    manager.addToQueue({
      userId: 1, socketId: 'sA', username: 'userA',
      rank: 10, stars: 0, isLegend: false, legendPosition: null, carId: 1,
    });
    manager.addToQueue({
      userId: 2, socketId: 'sB', username: 'userB',
      rank: 10, stars: 0, isLegend: false, legendPosition: null, carId: 2,
    });
  }

  beforeEach(() => {
    db = createTestDb();
    ({ mockIo, addSocket } = createMockIo());
    manager = new DuelManager({ db, io: mockIo, metrics: createMockMetrics() });
    insertUser(db, 1, { rank: 10, stars: 0 });
    insertUser(db, 2, { rank: 10, stars: 0 });
  });

  afterEach(() => {
    manager.clear();
    db.close();
  });

  test('disconnect before start cancels duel without rank changes', () => {
    setupMatchedDuel();

    const { affectedDuel } = manager.handleDisconnect('sA');
    assert.ok(affectedDuel, 'should affect the duel');

    // No rank changes
    const u1 = db.prepare('SELECT rank, stars, duels_won, duels_lost FROM users WHERE id = 1').get();
    const u2 = db.prepare('SELECT rank, stars, duels_won, duels_lost FROM users WHERE id = 2').get();
    assert.equal(u1.duels_won + u1.duels_lost, 0);
    assert.equal(u2.duels_won + u2.duels_lost, 0);

    const row = db.prepare('SELECT * FROM duel_results').get();
    assert.ok(row, 'result should be persisted');
    assert.equal(row.result_type, 'cancel');
    assert.equal(row.winner_id, null);
    assert.equal(row.loser_id, null);
  });

  test('disconnect after start counts as a loss for the disconnecting player', () => {
    setupMatchedDuel();

    // Start the duel
    manager.handleStartLap('sA');
    assert.equal(manager.getDuelStatus(1), 'in_progress');

    // Player A disconnects
    manager.handleDisconnect('sA');

    const u1 = db.prepare('SELECT rank, stars, duels_won, duels_lost FROM users WHERE id = 1').get();
    const u2 = db.prepare('SELECT rank, stars, duels_won, duels_lost FROM users WHERE id = 2').get();
    assert.equal(u1.duels_lost, 1, 'disconnecting player should lose');
    assert.equal(u2.duels_won, 1, 'remaining player should win');
  });

  test('opponent receives duel:result win after other player disconnects mid-duel', () => {
    setupMatchedDuel();
    manager.handleStartLap('sA');

    const sockB = mockIo.sockets.sockets.get('sB');
    manager.handleDisconnect('sA');

    const resultB = sockB.emitted.find((e) => e.event === 'duel:result');
    assert.ok(resultB, 'remaining player should get duel:result');
    assert.equal(resultB.data.result, 'win');
  });

  test('disconnect from queue removes player without duel side effects', () => {
    addSocket('sA');
    manager.addToQueue({
      userId: 1, socketId: 'sA', username: 'userA',
      rank: 10, stars: 0, isLegend: false, legendPosition: null, carId: 1,
    });
    assert.equal(manager.isInQueue(1), true);

    manager.handleDisconnect('sA');
    assert.equal(manager.isInQueue(1), false);

    // No DB writes
    const rows = db.prepare('SELECT * FROM duel_results').all();
    assert.equal(rows.length, 0);
  });

  test('duplicate disconnect does not apply result twice', () => {
    setupMatchedDuel();
    manager.handleStartLap('sA');

    manager.handleDisconnect('sA');
    manager.handleDisconnect('sA'); // second disconnect — should be no-op

    const rows = db.prepare('SELECT * FROM duel_results').all();
    assert.equal(rows.length, 1, 'only one result row should exist');
  });
});

// ---------------------------------------------------------------------------

describe('DuelManager — timeout', () => {
  let db, mockIo, addSocket, manager;

  beforeEach(() => {
    db = createTestDb();
    ({ mockIo, addSocket } = createMockIo());
    manager = new DuelManager({ db, io: mockIo, metrics: createMockMetrics() });
    insertUser(db, 1, { rank: 10, stars: 0 });
    insertUser(db, 2, { rank: 10, stars: 0 });
    addSocket('sA');
    addSocket('sB');
    manager.addToQueue({
      userId: 1, socketId: 'sA', username: 'userA',
      rank: 10, stars: 0, isLegend: false, legendPosition: null, carId: 1,
    });
    manager.addToQueue({
      userId: 2, socketId: 'sB', username: 'userB',
      rank: 10, stars: 0, isLegend: false, legendPosition: null, carId: 2,
    });
  });

  afterEach(() => {
    manager.clear();
    db.close();
  });

  test('manual timeout via _handleDuelTimeout — no rank changes, result_type=timeout', () => {
    manager.handleStartLap('sA');

    const duel = manager.getDuelBySocketId('sA');
    const duelId = duel.id;

    // Trigger timeout manually (without waiting DUEL_TIMEOUT_MS)
    manager._handleDuelTimeout(duelId);

    const u1 = db.prepare('SELECT duels_won, duels_lost FROM users WHERE id = 1').get();
    const u2 = db.prepare('SELECT duels_won, duels_lost FROM users WHERE id = 2').get();
    assert.equal(u1.duels_won + u1.duels_lost, 0, 'no rank changes on timeout');
    assert.equal(u2.duels_won + u2.duels_lost, 0);

    const row = db.prepare('SELECT result_type FROM duel_results').get();
    assert.ok(row, 'result should be persisted');
    assert.equal(row.result_type, 'timeout');
  });

  test('timeout after resolution is a no-op', () => {
    const duel = manager.getDuelBySocketId('sA');
    const duelId = duel.id;

    performValidLap(manager, 'sA');

    // Now trigger timeout — should be no-op
    manager._handleDuelTimeout(duelId);

    const rows = db.prepare('SELECT * FROM duel_results').all();
    assert.equal(rows.length, 1, 'only the win result should exist');
  });
});

// ---------------------------------------------------------------------------

describe('DuelManager — rank rules on duel resolution', () => {
  let db, mockIo, addSocket, manager;

  function matchAndWin(userId1, socketId1, userId2, socketId2, winnerSocketId) {
    manager.addToQueue({
      userId: userId1, socketId: socketId1, username: `user${userId1}`,
      rank: db.prepare('SELECT rank FROM users WHERE id = ?').get(userId1).rank,
      stars: db.prepare('SELECT stars FROM users WHERE id = ?').get(userId1).stars,
      isLegend: false, legendPosition: null, carId: 1,
    });
    manager.addToQueue({
      userId: userId2, socketId: socketId2, username: `user${userId2}`,
      rank: db.prepare('SELECT rank FROM users WHERE id = ?').get(userId2).rank,
      stars: db.prepare('SELECT stars FROM users WHERE id = ?').get(userId2).stars,
      isLegend: false, legendPosition: null, carId: 2,
    });
    return performValidLap(manager, winnerSocketId);
  }

  beforeEach(() => {
    db = createTestDb();
    ({ mockIo, addSocket } = createMockIo());
    manager = new DuelManager({ db, io: mockIo, metrics: createMockMetrics() });
  });

  afterEach(() => {
    manager.clear();
    db.close();
  });

  test('win at rank 1/3 promotes winner to Legend', () => {
    insertUser(db, 1, { rank: 1, stars: 3 });
    insertUser(db, 2, { rank: 1, stars: 2 });
    addSocket('sA');
    addSocket('sB');

    matchAndWin(1, 'sA', 2, 'sB', 'sA');

    const winner = db.prepare('SELECT is_legend, legend_position FROM users WHERE id = 1').get();
    assert.equal(winner.is_legend, 1, 'winner should be Legend');
    assert.ok(winner.legend_position >= 1, 'should have a legend position');
  });

  test('loss in hard-loss zone at 0 stars demotes', () => {
    insertUser(db, 1, { rank: 3, stars: 1 });
    insertUser(db, 2, { rank: 3, stars: 0 }); // loser at 0 stars → demote
    addSocket('sA');
    addSocket('sB');

    matchAndWin(1, 'sA', 2, 'sB', 'sA');

    const loser = db.prepare('SELECT rank, stars FROM users WHERE id = 2').get();
    assert.equal(loser.rank, 4, 'should demote from rank 3 to rank 4');
    assert.equal(loser.stars, 3, 'should have 3 stars after demotion');
  });

  test('loss in protected zone does not change rank or stars', () => {
    insertUser(db, 1, { rank: 12, stars: 1 });
    insertUser(db, 2, { rank: 12, stars: 2 });
    addSocket('sA');
    addSocket('sB');

    matchAndWin(1, 'sA', 2, 'sB', 'sA');

    const loser = db.prepare('SELECT rank, stars FROM users WHERE id = 2').get();
    assert.equal(loser.rank, 12);
    assert.equal(loser.stars, 2, 'protected zone: no star loss');
  });

  test('player_ranks history rows are written for both players', () => {
    insertUser(db, 1, { rank: 10, stars: 1 });
    insertUser(db, 2, { rank: 10, stars: 1 });
    addSocket('sA');
    addSocket('sB');

    matchAndWin(1, 'sA', 2, 'sB', 'sA');

    const rows = db.prepare('SELECT user_id, reason FROM player_ranks').all();
    const winRow = rows.find((r) => r.user_id === 1);
    const lossRow = rows.find((r) => r.user_id === 2);
    assert.ok(winRow, 'winner should have a player_ranks row');
    assert.ok(lossRow, 'loser should have a player_ranks row');
    assert.equal(winRow.reason, 'duel_win');
    assert.equal(lossRow.reason, 'duel_loss');
  });
});
