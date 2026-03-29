'use strict';

const { performance } = require('perf_hooks');

/**
 * Set up all Socket.IO logic.
 *
 * @param {import('socket.io').Server} io
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   sessionMiddleware: Function,
 *   metrics: object,
 *   RATE_PER_MINUTE: number,
 *   SESSION_MAX_DURATION_MS: number,
 *   INACTIVITY_TIMEOUT_MS: number,
 *   CONTROL_RATE_LIMIT_MAX: number,
 *   CONTROL_RATE_LIMIT_WINDOW_MS: number,
 *   CARS: Array,
 *   saveRentalSession: Function,
 *   ADMIN_USERNAMES: Set,
 * }} deps
 * @returns {{ activeSessions: Map, raceRooms: Map, presenceMap: Map,
 *             presenceGraceTimers: Map, chatRateLimits: Map,
 *             broadcastPresenceUpdate: Function,
 *             clearInactivityTimeout: Function,
 *             clearSessionDurationTimeout: Function,
 *             broadcastCarsUpdate: Function,
 *             processHoldDeduct: Function }}
 */
function setupSocketIo(io, deps) {
  const {
    db,
    sessionMiddleware,
    metrics,
    RATE_PER_MINUTE,
    SESSION_MAX_DURATION_MS,
    INACTIVITY_TIMEOUT_MS,
    CONTROL_RATE_LIMIT_MAX,
    CONTROL_RATE_LIMIT_WINDOW_MS,
    CARS,
    saveRentalSession,
    ADMIN_USERNAMES,
  } = deps;

  // --- Socket-local data structures ---

  // Track active sessions and inactivity timers (keyed by socket.id)
  const activeSessions = new Map();
  const inactivityTimeouts = new Map();
  // Session duration limit timers (keyed by socket.id)
  const sessionDurationTimeouts = new Map();
  // Control-command rate-limit counters (keyed by socket.id)
  const controlCommandCounters = new Map(); // socketId -> { count, windowStart }

  // --- Driver Presence ---
  // presenceMap keyed by userId (dbUserId integer) -> presence entry
  const presenceMap = new Map();
  // Grace-period timers: userId -> setTimeout handle
  const presenceGraceTimers = new Map();
  // Grace period before removing a driver after disconnect (ms)
  const PRESENCE_GRACE_MS = (() => {
    const v = parseInt(process.env.PRESENCE_GRACE_MS || '', 10);
    return (!isNaN(v) && v >= 0) ? v : 10_000;
  })();
  // Stale-entry threshold: remove if no heartbeat within this duration
  const PRESENCE_STALE_MS = 60_000;

  // --- Race Management ---
  const raceRooms = new Map(); // raceId -> race object
  const leaderboard = []; // sorted array of { userId, carName, lapTimeMs, date }
  const MAX_LEADERBOARD = 20;
  let raceCounter = 0;

  // --- Global Chat (DB-backed) ---
  const CHAT_HISTORY_LIMIT = parseInt(process.env.CHAT_HISTORY_LIMIT, 10) || 500;
  const CHAT_COOLDOWN_MS = 700; // min ms between messages per user
  const CHAT_BURST_MAX = 5;     // max burst before enforcing cooldown
  const CHAT_MSG_MAX_LEN = 300;
  // Per-user chat rate-limit state: userId -> { lastSent: timestamp, burst: number }
  const chatRateLimits = new Map();

  // --- Helper functions ---

  /** Minimum balance required to start a session (in RC). */
  const MIN_BALANCE_FOR_SESSION = 100;
  /** Amount held (blocked) at session start (in RC). */
  const HOLD_AMOUNT = 100;

  /**
   * Finalize balance after a session: release unused hold, record deduct transaction.
   * Must be called after actualCost is known (session end).
   */
  function processHoldDeduct(dbUserId, holdAmount, actualCost, carId, durationSeconds) {
    if (!dbUserId || holdAmount == null) return;
    const carName = CARS.find((c) => c.id === carId)?.name || ('Машина #' + carId);
    try {
      db.transaction(() => {
        const releaseAmount = holdAmount - actualCost;
        if (releaseAmount > 0) {
          db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(releaseAmount, dbUserId);
          const afterRelease = db.prepare('SELECT balance FROM users WHERE id = ?').get(dbUserId);
          db.prepare(
            `INSERT INTO transactions (user_id, type, amount, balance_after, description)
             VALUES (?, 'release', ?, ?, ?)`
          ).run(dbUserId, releaseAmount, afterRelease ? afterRelease.balance : 0, 'Возврат блокировки: ' + carName);
        } else if (releaseAmount < 0) {
          // actualCost exceeded hold — deduct the extra (safety guard)
          const extra = -releaseAmount;
          db.prepare('UPDATE users SET balance = MAX(0, balance - ?) WHERE id = ?').run(extra, dbUserId);
        }
        const mins = Math.floor(durationSeconds / 60);
        const secs = durationSeconds % 60;
        const rowAfter = db.prepare('SELECT balance FROM users WHERE id = ?').get(dbUserId);
        db.prepare(
          `INSERT INTO transactions (user_id, type, amount, balance_after, description)
           VALUES (?, 'deduct', ?, ?, ?)`
        ).run(dbUserId, -actualCost, rowAfter ? rowAfter.balance : 0, `Аренда: ${carName}, ${mins}м ${secs}с`);
      })();
    } catch (e) {
      console.error('[Balance] processHoldDeduct error:', e);
    }
  }

  function broadcastPresenceUpdate() {
    const drivers = [...presenceMap.values()].map((e) => ({
      userId: e.userId,
      username: e.username,
      status: e.status,
      connectedAt: e.connectedAt,
      lastSeen: e.lastSeen,
      carId: e.carId || null,
    }));
    io.emit('presence:update', { drivers });
  }

  function schedulePresenceRemoval(userId) {
    if (presenceGraceTimers.has(userId)) {
      clearTimeout(presenceGraceTimers.get(userId));
    }
    const timer = setTimeout(() => {
      presenceMap.delete(userId);
      presenceGraceTimers.delete(userId);
      broadcastPresenceUpdate();
      metrics.log('debug', 'presence_removed', { userId });
    }, PRESENCE_GRACE_MS);
    presenceGraceTimers.set(userId, timer);
  }

  // Periodic stale-entry cleanup
  setInterval(() => {
    const cutoff = Date.now() - PRESENCE_STALE_MS;
    let changed = false;
    for (const [userId, entry] of presenceMap.entries()) {
      if (entry.lastSeen < cutoff) {
        presenceMap.delete(userId);
        if (presenceGraceTimers.has(userId)) {
          clearTimeout(presenceGraceTimers.get(userId));
          presenceGraceTimers.delete(userId);
        }
        changed = true;
        metrics.log('debug', 'presence_stale_removed', { userId });
      }
    }
    if (changed) broadcastPresenceUpdate();
  }, PRESENCE_STALE_MS);

  function broadcastCarsUpdate() {
    const activeCars = new Set([...activeSessions.values()].map((s) => s.carId));
    io.emit('cars_updated', {
      cars: CARS.map((c) => ({ ...c, status: activeCars.has(c.id) ? 'unavailable' : 'available' })),
    });
  }

  function broadcastRacesUpdate() {
    const races = [...raceRooms.values()].map((r) => ({
      id: r.id,
      name: r.name,
      playerCount: r.players.length,
      status: r.status,
      createdAt: r.createdAt,
    }));
    io.emit('races_updated', { races });
  }

  function clearInactivityTimeout(socketId) {
    if (inactivityTimeouts.has(socketId)) {
      clearTimeout(inactivityTimeouts.get(socketId));
      inactivityTimeouts.delete(socketId);
    }
  }

  function setInactivityTimeout(socket) {
    clearInactivityTimeout(socket.id);
    const timeout = setTimeout(() => {
      const session = activeSessions.get(socket.id);
      if (!session) return;
      const endTime = new Date();
      const durationMs = endTime - session.startTime;
      const durationSeconds = Math.floor(durationMs / 1000);
      const durationMinutes = durationMs / 60000;
      const cost = durationMinutes * RATE_PER_MINUTE;
      activeSessions.delete(socket.id);
      inactivityTimeouts.delete(socket.id);
      clearSessionDurationTimeout(socket.id);
      saveRentalSession(session.dbUserId, session.carId, durationSeconds, cost);
      processHoldDeduct(session.dbUserId, session.holdAmount, cost, session.carId, durationSeconds);
      socket.emit('session_ended', { carId: session.carId, durationSeconds, cost, reason: 'inactivity' });
      broadcastCarsUpdate();
      metrics.log('info', 'session_end', {
        userId: session.userId,
        dbUserId: session.dbUserId,
        carId: session.carId,
        durationSeconds,
        cost: parseFloat(cost.toFixed(4)),
        reason: 'inactivity',
      });
    }, INACTIVITY_TIMEOUT_MS);
    inactivityTimeouts.set(socket.id, timeout);
  }

  function clearSessionDurationTimeout(socketId) {
    if (sessionDurationTimeouts.has(socketId)) {
      clearTimeout(sessionDurationTimeouts.get(socketId));
      sessionDurationTimeouts.delete(socketId);
    }
  }

  function setSessionDurationTimeout(socket) {
    clearSessionDurationTimeout(socket.id);
    const timeout = setTimeout(() => {
      const session = activeSessions.get(socket.id);
      if (!session) return;
      const endTime = new Date();
      const durationMs = endTime - session.startTime;
      const durationSeconds = Math.floor(durationMs / 1000);
      const durationMinutes = durationMs / 60000;
      const cost = durationMinutes * RATE_PER_MINUTE;
      activeSessions.delete(socket.id);
      sessionDurationTimeouts.delete(socket.id);
      clearInactivityTimeout(socket.id);
      saveRentalSession(session.dbUserId, session.carId, durationSeconds, cost);
      processHoldDeduct(session.dbUserId, session.holdAmount, cost, session.carId, durationSeconds);
      socket.emit('session_ended', { carId: session.carId, durationSeconds, cost, reason: 'time_limit' });
      broadcastCarsUpdate();
      metrics.log('info', 'session_end', {
        userId: session.userId,
        dbUserId: session.dbUserId,
        carId: session.carId,
        durationSeconds,
        cost: parseFloat(cost.toFixed(4)),
        reason: 'time_limit',
      });
    }, SESSION_MAX_DURATION_MS);
    sessionDurationTimeouts.set(socket.id, timeout);
  }

  // Returns true if the command is within the allowed rate, false if throttled.
  function checkControlRateLimit(socketId) {
    const now = Date.now();
    const entry = controlCommandCounters.get(socketId) || { count: 0, windowStart: now };
    if (now - entry.windowStart >= CONTROL_RATE_LIMIT_WINDOW_MS) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count += 1;
    controlCommandCounters.set(socketId, entry);
    return entry.count <= CONTROL_RATE_LIMIT_MAX;
  }

  function createRaceId() {
    raceCounter += 1;
    return 'race-' + Date.now() + '-' + raceCounter + '-' + Math.random().toString(36).slice(2, 7);
  }

  function serializePlayer(p) {
    return {
      socketId: p.socketId,
      userId: p.userId,
      carId: p.carId,
      carName: p.carName,
      lapCount: p.lapCount,
      bestLapTime: p.bestLapTime,
    };
  }

  function findRaceBySocketId(socketId) {
    for (const race of raceRooms.values()) {
      if (race.players.some((p) => p.socketId === socketId)) return race;
    }
    return null;
  }

  function removeFromRace(socket) {
    const race = findRaceBySocketId(socket.id);
    if (!race) return;
    race.players = race.players.filter((p) => p.socketId !== socket.id);
    socket.leave(race.id);
    if (race.players.length === 0) {
      raceRooms.delete(race.id);
    } else {
      io.to(race.id).emit('race_updated', {
        raceId: race.id,
        raceName: race.name,
        players: race.players.map(serializePlayer),
      });
    }
  }

  function getChatHistory(limit, offset) {
    const lim = (typeof limit === 'number' && limit > 0) ? limit : CHAT_HISTORY_LIMIT;
    const off = (typeof offset === 'number' && offset > 0) ? offset : 0;
    const rows = db.prepare(
      `SELECT id, user_id AS userId, username, text AS message, created_at AS createdAt,
              deleted, deleted_by AS deletedBy, deleted_at AS deletedAt
       FROM chat_messages ORDER BY id DESC LIMIT ? OFFSET ?`
    ).all(lim + 1, off);
    const hasMore = rows.length > lim;
    const messages = rows.slice(0, lim).reverse().map((m) => ({
      id: m.id,
      userId: m.userId,
      username: m.username,
      message: m.deleted === 1 ? null : m.message,
      createdAt: m.createdAt,
      deleted: m.deleted === 1,
    }));
    return { messages, hasMore };
  }

  // --- Session-to-Socket.IO bridge ---
  io.use((socket, next) => {
    sessionMiddleware(socket.request, socket.request.res || {}, next);
  });

  // --- Socket.IO connection handler ---
  io.on('connection', (socket) => {
    metrics.log('debug', 'socket_connect', { socketId: socket.id });

    // Send chat history to newly connected clients
    socket.emit('chat:history', getChatHistory());

    // --- Chat events ---

    socket.on('chat:send', (data) => {
      const { message, userId: clientUserId, username: clientUsername } = data || {};

      // Auth: try HTTP session first, then fall back to client-provided identity
      // (same pattern as presence:hello — validates against DB either way)
      let authUserId, authUsername;
      const sess = socket.request.session;
      if (sess && sess.userId) {
        const user = db.prepare('SELECT username, status FROM users WHERE id = ?').get(sess.userId);
        if (user && user.status === 'active') {
          authUserId = sess.userId;
          authUsername = user.username;
        }
      }
      // Fallback: client-provided userId+username (validated against DB)
      if (!authUserId && Number.isInteger(clientUserId) && clientUsername) {
        const user = db.prepare('SELECT username, status FROM users WHERE id = ? AND username = ?').get(clientUserId, clientUsername);
        if (user && user.status === 'active') {
          authUserId = clientUserId;
          authUsername = user.username;
        }
      }
      if (!authUserId) {
        socket.emit('chat:error', { code: 'auth_required', message: 'Требуется авторизация' });
        return;
      }

      // Rate limiting: per-user cooldown + burst
      const now = Date.now();
      let rateState = chatRateLimits.get(authUserId) || { lastSent: 0, burst: 0 };
      const elapsed = now - rateState.lastSent;
      if (elapsed >= CHAT_COOLDOWN_MS) {
        // Reset burst count based on elapsed time
        rateState.burst = Math.max(0, rateState.burst - Math.floor(elapsed / CHAT_COOLDOWN_MS));
      }
      rateState.burst += 1;
      if (rateState.burst > CHAT_BURST_MAX) {
        socket.emit('chat:error', { code: 'rate_limited', message: 'Слишком быстро, подождите немного' });
        return;
      }
      rateState.lastSent = now;
      chatRateLimits.set(authUserId, rateState);

      // Message validation
      if (!message || typeof message !== 'string') return;
      const trimmed = message.trim();
      if (!trimmed) return;
      if (trimmed.length > CHAT_MSG_MAX_LEN) {
        socket.emit('chat:error', { code: 'too_long', message: `Сообщение не должно превышать ${CHAT_MSG_MAX_LEN} символов` });
        return;
      }

      const result = db.prepare(
        'INSERT INTO chat_messages (user_id, username, text) VALUES (?, ?, ?)'
      ).run(authUserId, authUsername, trimmed);

      // Prune oldest messages beyond the retention limit
      db.prepare(
        'DELETE FROM chat_messages WHERE id NOT IN (SELECT id FROM chat_messages ORDER BY id DESC LIMIT ?)'
      ).run(CHAT_HISTORY_LIMIT);

      const msg = {
        id: result.lastInsertRowid,
        userId: authUserId,
        username: authUsername,
        message: trimmed,
        createdAt: new Date().toISOString(),
        deleted: false,
      };

      io.emit('chat:message', msg);
      metrics.log('debug', 'chat_message', { userId: authUserId, username: authUsername });
    });

    // --- Chat moderation ---

    socket.on('chat:delete', (data) => {
      const { id } = data || {};
      if (!Number.isInteger(id)) return;

      const sess = socket.request.session;
      if (!sess || !sess.userId) {
        socket.emit('chat:error', { code: 'auth_required', message: 'Требуется авторизация' });
        return;
      }
      const adminUser = db.prepare('SELECT username, status FROM users WHERE id = ?').get(sess.userId);
      if (!adminUser || adminUser.status !== 'active' || !ADMIN_USERNAMES.has(adminUser.username.toLowerCase())) {
        socket.emit('chat:error', { code: 'forbidden', message: 'Недостаточно прав' });
        return;
      }

      const now = new Date().toISOString();
      const result = db.prepare(
        'UPDATE chat_messages SET deleted = 1, deleted_by = ?, deleted_at = ? WHERE id = ? AND deleted = 0'
      ).run(adminUser.username, now, id);

      if (result.changes > 0) {
        io.emit('chat:deleted', { id });
        metrics.log('debug', 'chat_delete', { adminUsername: adminUser.username, msgId: id });
      }
    });

    // --- Presence events ---

    socket.on('presence:hello', (data) => {
      const { page, userId, username } = data || {};
      if (page !== 'control') {
        // Non-control pages: send current presence snapshot without registering
        socket.emit('presence:update', {
          drivers: [...presenceMap.values()].map((e) => ({
            userId: e.userId,
            username: e.username,
            status: e.status,
            connectedAt: e.connectedAt,
            lastSeen: e.lastSeen,
            carId: e.carId || null,
          })),
        });
        return;
      }
      if (!Number.isInteger(userId) || !username) return;

      // Cancel any pending grace-period removal for this user
      if (presenceGraceTimers.has(userId)) {
        clearTimeout(presenceGraceTimers.get(userId));
        presenceGraceTimers.delete(userId);
      }

      const now = Date.now();
      const existing = presenceMap.get(userId);
      presenceMap.set(userId, {
        userId,
        username,
        status: 'driving',
        connectedAt: existing ? existing.connectedAt : now,
        lastSeen: now,
        socketId: socket.id,
        carId: existing ? existing.carId : null,
      });

      broadcastPresenceUpdate();
      metrics.log('debug', 'presence_hello', { userId, username });
    });

    socket.on('presence:heartbeat', () => {
      for (const entry of presenceMap.values()) {
        if (entry.socketId === socket.id) {
          entry.lastSeen = Date.now();
          break;
        }
      }
    });

    socket.on('start_session', (data) => {
      const { carId, dbUserId } = data;

      // Require authenticated & verified user
      if (!Number.isInteger(dbUserId)) {
        metrics.log('warn', 'auth_fail', { event: 'start_session', code: 'auth_required', socketId: socket.id });
        metrics.recordError();
        socket.emit('session_error', { message: 'Требуется авторизация.', code: 'auth_required' });
        return;
      }
      const user = db.prepare('SELECT username, status FROM users WHERE id = ?').get(dbUserId);
      if (!user) {
        metrics.log('warn', 'auth_fail', { event: 'start_session', code: 'user_not_found', socketId: socket.id });
        metrics.recordError();
        socket.emit('session_error', { message: 'Пользователь не найден.', code: 'auth_required' });
        return;
      }
      if (user.status === 'pending') {
        metrics.log('warn', 'auth_fail', { event: 'start_session', code: 'pending_verification', userId: dbUserId });
        metrics.recordError();
        socket.emit('session_error', { message: 'Подтвердите email для аренды машины.', code: 'pending_verification' });
        return;
      }
      if (user.status === 'disabled') {
        metrics.log('warn', 'auth_fail', { event: 'start_session', code: 'account_disabled', userId: dbUserId });
        metrics.recordError();
        socket.emit('session_error', { message: 'Аккаунт заблокирован.', code: 'account_disabled' });
        return;
      }

      // Validate that the requested car exists
      if (!CARS.some((c) => c.id === carId)) {
        socket.emit('session_error', { message: 'Неверный идентификатор машины.' });
        return;
      }

      const carAlreadyActive = [...activeSessions.values()].some((s) => s.carId === carId);
      if (carAlreadyActive) {
        socket.emit('session_error', { message: 'Эта машина уже занята. Выберите другую.' });
        return;
      }

      // Check balance and apply hold
      const userBalance = db.prepare('SELECT balance FROM users WHERE id = ?').get(dbUserId);
      const currentBalance = userBalance ? (userBalance.balance || 0) : 0;
      if (currentBalance < MIN_BALANCE_FOR_SESSION) {
        metrics.log('warn', 'session_blocked', { reason: 'insufficient_balance', dbUserId, balance: currentBalance });
        socket.emit('session_error', {
          message: 'Недостаточно средств. Минимальный баланс для аренды: ' + MIN_BALANCE_FOR_SESSION + ' RC.',
          code: 'insufficient_balance',
        });
        return;
      }
      const carName = CARS.find((c) => c.id === carId)?.name || ('Машина #' + carId);
      db.transaction(() => {
        db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(HOLD_AMOUNT, dbUserId);
        const afterHold = db.prepare('SELECT balance FROM users WHERE id = ?').get(dbUserId);
        db.prepare(
          `INSERT INTO transactions (user_id, type, amount, balance_after, description)
           VALUES (?, 'hold', ?, ?, ?)`
        ).run(dbUserId, -HOLD_AMOUNT, afterHold ? afterHold.balance : 0, 'Блокировка: ' + carName);
      })();

      activeSessions.set(socket.id, {
        carId,
        userId: user.username,
        dbUserId,
        startTime: new Date(),
        holdAmount: HOLD_AMOUNT,
      });
      socket.emit('session_started', {
        carId,
        sessionId: socket.id,
        sessionMaxDurationMs: SESSION_MAX_DURATION_MS,
        inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
        cameraUrl: CARS.find((c) => c.id === carId)?.cameraUrl || '',
      });
      setInactivityTimeout(socket);
      setSessionDurationTimeout(socket);
      broadcastCarsUpdate();
      metrics.log('info', 'session_start', { userId: user.username, dbUserId, carId, socketId: socket.id });
    });

    socket.on('control_command', (data) => {
      // Only forward commands from sockets that own an active rental session
      if (!activeSessions.has(socket.id)) {
        return;
      }
      if (!checkControlRateLimit(socket.id)) {
        metrics.recordError();
        socket.emit('control_error', { message: 'Слишком много команд. Подождите немного.', code: 'rate_limited' });
        return;
      }
      metrics.log('info', 'control_command', {
        socketId: socket.id,
        direction: data.direction || null,
        speed: data.speed || 0,
        steering_angle: data.steering_angle || 0,
      });
      setInactivityTimeout(socket);
      const t0 = performance.now();
      socket.broadcast.emit('control_command', data);
      metrics.recordCommand();
      metrics.recordLatency(socket.id, performance.now() - t0);
    });

    socket.on('end_session', (data) => {
      clearInactivityTimeout(socket.id);
      clearSessionDurationTimeout(socket.id);
      const session = activeSessions.get(socket.id);
      if (!session) {
        socket.emit('session_error', { message: 'No active session found.' });
        return;
      }
      const endTime = new Date();
      const durationMs = endTime - session.startTime;
      const durationSeconds = Math.floor(durationMs / 1000);
      const durationMinutes = durationMs / 60000;
      const cost = durationMinutes * RATE_PER_MINUTE;
      activeSessions.delete(socket.id);
      saveRentalSession(session.dbUserId, session.carId, durationSeconds, cost);
      processHoldDeduct(session.dbUserId, session.holdAmount, cost, session.carId, durationSeconds);
      socket.emit('session_ended', { carId: session.carId, durationSeconds, cost });
      broadcastCarsUpdate();
      metrics.log('info', 'session_end', {
        userId: session.userId,
        dbUserId: session.dbUserId,
        carId: session.carId,
        durationSeconds,
        cost: parseFloat(cost.toFixed(4)),
        reason: 'user',
      });
    });

    socket.on('disconnect', () => {
      clearInactivityTimeout(socket.id);
      clearSessionDurationTimeout(socket.id);
      controlCommandCounters.delete(socket.id);
      metrics.clearLatency(socket.id);
      const session = activeSessions.get(socket.id);
      const hadSession = !!session;
      if (hadSession) {
        const endTime = new Date();
        const durationMs = endTime - session.startTime;
        const durationSeconds = Math.floor(durationMs / 1000);
        const durationMinutes = durationMs / 60000;
        const cost = durationMinutes * RATE_PER_MINUTE;
        activeSessions.delete(socket.id);
        saveRentalSession(session.dbUserId, session.carId, durationSeconds, cost);
        processHoldDeduct(session.dbUserId, session.holdAmount, cost, session.carId, durationSeconds);
        broadcastCarsUpdate();
        metrics.log('info', 'session_end', {
          userId: session.userId,
          dbUserId: session.dbUserId,
          carId: session.carId,
          durationSeconds,
          cost: parseFloat(cost.toFixed(4)),
          reason: 'disconnect',
        });
      } else {
        activeSessions.delete(socket.id);
      }
      removeFromRace(socket);
      if (hadSession) broadcastCarsUpdate();
      broadcastRacesUpdate();
      // Schedule grace-period removal from presence
      for (const [userId, entry] of presenceMap.entries()) {
        if (entry.socketId === socket.id) {
          schedulePresenceRemoval(userId);
          break;
        }
      }
      metrics.log('debug', 'socket_disconnect', { socketId: socket.id, hadSession });
    });

    // --- Race events ---

    socket.on('join_race', (data) => {
      const { raceId, carId, carName, dbUserId } = data || {};

      // Require authenticated & verified user
      if (!Number.isInteger(dbUserId)) {
        metrics.log('warn', 'auth_fail', { event: 'join_race', code: 'auth_required', socketId: socket.id });
        metrics.recordError();
        socket.emit('race_error', { message: 'Требуется авторизация.', code: 'auth_required' });
        return;
      }
      const user = db.prepare('SELECT username, status FROM users WHERE id = ?').get(dbUserId);
      if (!user) {
        metrics.log('warn', 'auth_fail', { event: 'join_race', code: 'user_not_found', socketId: socket.id });
        metrics.recordError();
        socket.emit('race_error', { message: 'Пользователь не найден.', code: 'auth_required' });
        return;
      }
      if (user.status === 'pending') {
        metrics.log('warn', 'auth_fail', { event: 'join_race', code: 'pending_verification', userId: dbUserId });
        metrics.recordError();
        socket.emit('race_error', { message: 'Подтвердите email для участия в гонках.', code: 'pending_verification' });
        return;
      }
      if (user.status === 'disabled') {
        metrics.log('warn', 'auth_fail', { event: 'join_race', code: 'account_disabled', userId: dbUserId });
        metrics.recordError();
        socket.emit('race_error', { message: 'Аккаунт заблокирован.', code: 'account_disabled' });
        return;
      }

      removeFromRace(socket);

      let race;
      if (raceId && raceRooms.has(raceId)) {
        race = raceRooms.get(raceId);
      } else {
        const newId = createRaceId();
        race = {
          id: newId,
          name: 'Гонка #' + (raceRooms.size + 1),
          players: [],
          status: 'racing',
          createdAt: new Date().toISOString(),
        };
        raceRooms.set(newId, race);
      }

      const player = {
        socketId: socket.id,
        userId: user.username,
        dbUserId,
        carId: carId || null,
        carName: carName || ('Машина #' + (carId || '?')),
        lapCount: 0,
        bestLapTime: null,
        currentLapStart: null,
      };
      race.players.push(player);
      socket.join(race.id);

      socket.emit('race_joined', {
        raceId: race.id,
        raceName: race.name,
        players: race.players.map(serializePlayer),
        leaderboard: leaderboard.slice(0, 10),
      });

      io.to(race.id).emit('race_updated', {
        raceId: race.id,
        raceName: race.name,
        players: race.players.map(serializePlayer),
      });

      broadcastRacesUpdate();

      metrics.log('info', 'race_join', { userId: user.username, dbUserId, raceId: race.id, socketId: socket.id });
    });

    socket.on('leave_race', () => {
      const race = findRaceBySocketId(socket.id);
      const raceId = race ? race.id : null;
      removeFromRace(socket);
      socket.emit('race_left');
      broadcastRacesUpdate();
      if (raceId) metrics.log('info', 'race_leave', { socketId: socket.id, raceId });
    });

    socket.on('start_lap', () => {
      const race = findRaceBySocketId(socket.id);
      if (!race) return;
      const player = race.players.find((p) => p.socketId === socket.id);
      if (!player) return;
      player.currentLapStart = Date.now();
      socket.emit('lap_started', { startTime: player.currentLapStart });
    });

    socket.on('end_lap', () => {
      const race = findRaceBySocketId(socket.id);
      if (!race) return;
      const player = race.players.find((p) => p.socketId === socket.id);
      if (!player || !player.currentLapStart) return;

      const lapTimeMs = Date.now() - player.currentLapStart;
      player.currentLapStart = null;
      player.lapCount++;

      const isPersonalBest = !player.bestLapTime || lapTimeMs < player.bestLapTime;
      if (isPersonalBest) player.bestLapTime = lapTimeMs;

      leaderboard.push({
        userId: player.userId,
        carName: player.carName,
        lapTimeMs,
        date: new Date().toISOString(),
      });
      leaderboard.sort((a, b) => a.lapTimeMs - b.lapTimeMs);
      if (leaderboard.length > MAX_LEADERBOARD) leaderboard.length = MAX_LEADERBOARD;

      if (player.dbUserId) {
        try {
          db.prepare(
            'INSERT INTO lap_times (user_id, car_id, car_name, lap_time_ms, race_id) VALUES (?, ?, ?, ?, ?)'
          ).run(player.dbUserId, player.carId, player.carName, lapTimeMs, race.id);
          metrics.log('info', 'lap_save_success', {
            userId: player.userId,
            dbUserId: player.dbUserId,
            carName: player.carName,
            lapTimeMs,
            raceId: race.id,
            isPersonalBest,
          });
        } catch (e) {
          metrics.log('error', 'lap_save_fail', { userId: player.userId, error: e.message });
          metrics.recordError();
        }
      }

      const isGlobalRecord = leaderboard[0].lapTimeMs === lapTimeMs && leaderboard[0].userId === player.userId;

      io.to(race.id).emit('lap_recorded', {
        userId: player.userId,
        carName: player.carName,
        lapTimeMs,
        isPersonalBest,
        isGlobalRecord,
        leaderboard: leaderboard.slice(0, 10),
      });

      io.to(race.id).emit('race_updated', {
        raceId: race.id,
        raceName: race.name,
        players: race.players.map(serializePlayer),
      });

      metrics.log('info', 'lap_recorded', {
        userId: player.userId,
        carName: player.carName,
        lapTimeMs,
        isPersonalBest,
        isGlobalRecord,
        raceId: race.id,
      });
    });
  });

  return {
    activeSessions,
    raceRooms,
    presenceMap,
    presenceGraceTimers,
    chatRateLimits,
    broadcastPresenceUpdate,
    clearInactivityTimeout,
    clearSessionDurationTimeout,
    broadcastCarsUpdate,
    processHoldDeduct,
  };
}

module.exports = { setupSocketIo };
