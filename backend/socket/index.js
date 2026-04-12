'use strict';

const { performance } = require('perf_hooks');
const crypto = require('crypto');
const { getAccessBlockReason, hasRequiredRole } = require('../middleware/roles');
const DuelManager = require('../lib/duel-manager');
const { DUEL_TIMEOUT_MS } = require('../lib/rank-config');
const { verifyDeviceKey } = require('../lib/device-auth');
const { HOLD_AMOUNT, HEARTBEAT_STALE_MS, HEARTBEAT_CHECK_INTERVAL_MS } = require('../config/constants');

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
 * }} deps
 * @returns {{ activeSessions: Map, raceRooms: Map, presenceMap: Map,
 *             presenceGraceTimers: Map, chatRateLimits: Map,
 *             broadcastPresenceUpdate: Function,
 *             clearInactivityTimeout: Function,
 *             clearSessionDurationTimeout: Function,
 *             broadcastCarsUpdate: Function,
 *             processHoldDeduct: Function,
 *             deviceSockets: Map }}
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
  } = deps;

  // --- Socket-local data structures ---

  // Track active sessions and inactivity timers (keyed by socket.id)
  const activeSessions = new Map();
  const inactivityTimeouts = new Map();
  // Session duration limit timers (keyed by socket.id)
  const sessionDurationTimeouts = new Map();
  // Control-command rate-limit counters (keyed by socket.id)
  const controlCommandCounters = new Map(); // socketId -> { count, windowStart }

  // --- Device tracking ---
  // deviceSockets: carId (number) -> socket
  const deviceSockets = new Map();

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

  // --- Duel Management ---
  const duelManager = new DuelManager({
    db,
    io,
    metrics,
    getActiveSession: (socketId) => activeSessions.get(socketId),
  });

  // --- Global Chat (DB-backed) ---
  const CHAT_HISTORY_LIMIT = parseInt(process.env.CHAT_HISTORY_LIMIT, 10) || 500;
  const CHAT_COOLDOWN_MS = 700; // min ms between messages per user
  const CHAT_BURST_MAX = 5;     // max burst before enforcing cooldown
  const CHAT_MSG_MAX_LEN = 300;
  // Per-user chat rate-limit state: userId -> { lastSent: timestamp, burst: number }
  const chatRateLimits = new Map();

  // Per-user session-start rate-limit state: userId -> { count: number, windowStart: timestamp }
  const sessionStartRateLimits = new Map();
  const SESSION_START_MAX = 5;       // max attempts per window
  const SESSION_START_WINDOW_MS = 60 * 1000; // 1 minute

  // Per-user duel-search rate-limit state: userId -> { count: number, windowStart: timestamp }
  const duelSearchRateLimits = new Map();
  const DUEL_SEARCH_MAX = 3;         // max searches per window
  const DUEL_SEARCH_WINDOW_MS = 60 * 1000; // 1 minute

  // --- Helper functions ---

  /** Minimum balance required to start a session (in RC). */
  const MIN_BALANCE_FOR_SESSION = 100;

  /**
   * Finalize balance after a session: release unused hold, record deduct transaction.
   * Must be called after actualCost is known (session end).
   */
  function processHoldDeduct(dbUserId, holdAmount, actualCost, carId, durationSeconds, sessionRef) {
    if (!dbUserId || holdAmount == null) return;
    const carName = CARS.find((c) => c.id === carId)?.name || ('Машина #' + carId);
    const ref = sessionRef || null;
    try {
      db.transaction(() => {
        // Idempotency guard: if a deduct already exists for this reference, skip entirely.
        if (ref) {
          const existingDeduct = db.prepare(
            "SELECT 1 FROM transactions WHERE reference_id = ? AND type = 'deduct' LIMIT 1"
          ).get(ref);
          if (existingDeduct) {
            console.warn('[Balance] processHoldDeduct: deduct already recorded for ref:', ref, '— skipping (idempotent)');
            return;
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
          // actualCost exceeded hold — deduct the extra (safety guard)
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
        console.warn('[Balance] processHoldDeduct: duplicate transaction blocked by constraint for ref:', ref);
      } else {
        console.error('[Balance] processHoldDeduct error:', e);
      }
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
    const maintRows = db.prepare('SELECT car_id FROM car_maintenance WHERE enabled = 1').all();
    const maintenanceCars = new Set(maintRows.map((r) => r.car_id));
    io.emit('cars_updated', {
      cars: CARS.map((c) => {
        let status;
        if (maintenanceCars.has(c.id)) {
          status = 'maintenance';
        } else if (activeCars.has(c.id)) {
          status = 'unavailable';
        } else {
          status = 'available';
        }
        return { ...c, status };
      }),
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
      saveRentalSession(session.dbUserId, session.carId, durationSeconds, cost, session.sessionRef, 'inactivity');
      processHoldDeduct(session.dbUserId, session.holdAmount, cost, session.carId, durationSeconds, session.sessionRef);
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
      saveRentalSession(session.dbUserId, session.carId, durationSeconds, cost, session.sessionRef, 'duration_limit');
      processHoldDeduct(session.dbUserId, session.holdAmount, cost, session.carId, durationSeconds, session.sessionRef);
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

    // --- Device authentication ---
    // If the connecting socket provides carId + deviceKey it is an RC device,
    // not a browser user. Handle it separately and return early.
    const { carId: rawCarId, deviceKey } = socket.handshake.auth || {};
    if (rawCarId != null && deviceKey) {
      const result = verifyDeviceKey(db, Number(rawCarId), String(deviceKey));
      if (!result.valid) {
        metrics.log('warn', 'device_auth_fail', {
          carId: rawCarId,
          reason: result.reason,
          ip: socket.handshake.address,
        });
        socket.emit('device:auth_error', { reason: result.reason });
        socket.disconnect(true);
        return;
      }

      // Successful device auth
      socket.data.isDevice = true;
      socket.data.deviceId = result.device.id;
      socket.data.carId = Number(rawCarId);
      socket.join(`car:${rawCarId}`);

      // Kick any previously connected socket for this car
      const existing = deviceSockets.get(Number(rawCarId));
      if (existing && existing.id !== socket.id) {
        existing.emit('device:kicked', { reason: 'new_connection' });
        existing.disconnect(true);
      }

      deviceSockets.set(Number(rawCarId), socket);

      // Update last_seen_at
      db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
        .run(new Date().toISOString(), result.device.id);

      socket.emit('device:auth_ok', { deviceId: result.device.id, carId: Number(rawCarId) });

      metrics.log('info', 'device_connected', {
        deviceId: result.device.id,
        carId: Number(rawCarId),
      });

      // --- Device heartbeat ---
      socket.on('device:heartbeat', (_data) => {
        const carIdNum = Number(rawCarId);
        const deviceId = result.device.id;
        db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
          .run(new Date().toISOString(), deviceId);
        socket.emit('device:heartbeat_ack', { ts: new Date().toISOString() });
        metrics.log('debug', 'device_heartbeat', { deviceId, carId: carIdNum });
      });

      socket.on('disconnect', () => {
        if (deviceSockets.get(Number(rawCarId))?.id === socket.id) {
          deviceSockets.delete(Number(rawCarId));
        }
        metrics.log('info', 'device_disconnected', {
          deviceId: result.device.id,
          carId: Number(rawCarId),
        });
      });

      return; // Don't execute user logic for device sockets
    }

    // --- Reconnect adoption: if this user already has an active session on a
    //     different socket, migrate it to the new socket without creating a new
    //     hold transaction.
    const reconnectSess = socket.request.session;
    const reconnectUserId = reconnectSess && reconnectSess.userId;
    if (reconnectUserId) {
      let existingSocketId = null;
      let existingSession = null;
      for (const [sid, session] of activeSessions) {
        if (session.dbUserId === reconnectUserId && sid !== socket.id) {
          existingSocketId = sid;
          existingSession = session;
          break;
        }
      }
      if (existingSocketId && existingSession) {
        // Transfer session ownership to the new socket
        activeSessions.delete(existingSocketId);
        activeSessions.set(socket.id, existingSession);

        // Clear timers on the old socket and start fresh ones on the new socket
        clearInactivityTimeout(existingSocketId);
        clearSessionDurationTimeout(existingSocketId);
        controlCommandCounters.delete(existingSocketId);

        setInactivityTimeout(socket);
        setSessionDurationTimeout(socket);

        socket.emit('session_resumed', {
          carId: existingSession.carId,
          sessionId: socket.id,
          sessionRef: existingSession.sessionRef,
          sessionMaxDurationMs: SESSION_MAX_DURATION_MS,
          inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
          cameraUrl: CARS.find((c) => c.id === existingSession.carId)?.cameraUrl || '',
        });

        metrics.log('info', 'session_reconnect', {
          userId: existingSession.userId,
          dbUserId: reconnectUserId,
          oldSocketId: existingSocketId,
          newSocketId: socket.id,
          carId: existingSession.carId,
        });
      }
    }

    // Send chat history to newly connected clients
    socket.emit('chat:history', getChatHistory());

    // --- Chat events ---

    socket.on('chat:send', (data) => {
      const { message } = data || {};

      // Auth: require HTTP session — no fallback to client-provided identity
      let authUserId, authUsername;
      const sess = socket.request.session;
      if (sess && sess.userId) {
        const user = db.prepare('SELECT username, status FROM users WHERE id = ?').get(sess.userId);
        if (user && user.status === 'active') {
          authUserId = sess.userId;
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
      const adminUser = db.prepare('SELECT username, status, role FROM users WHERE id = ?').get(sess.userId);
      if (!adminUser || adminUser.status !== 'active') {
        socket.emit('chat:error', { code: 'forbidden', message: 'Недостаточно прав' });
        return;
      }
      // Use DB role-based check instead of env-based ADMIN_USERNAMES
      if (!hasRequiredRole(adminUser.role, ['admin', 'moderator'])) {
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
      const { page } = data || {};
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

      // Require HTTP session authentication — ignore client-provided userId/username
      const sess = socket.request.session;
      const userId = sess && sess.userId;
      if (!userId) return;

      const user = db.prepare('SELECT username, status FROM users WHERE id = ?').get(userId);
      if (!user || user.status !== 'active') return;
      const username = user.username;

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
      const sess = socket.request.session;
      if (!sess || !sess.userId) return;
      for (const entry of presenceMap.values()) {
        if (entry.socketId === socket.id) {
          entry.lastSeen = Date.now();
          break;
        }
      }
    });

    socket.on('start_session', (data) => {
      const { carId } = data;

      // Read dbUserId from server-side session (not client payload) to prevent spoofing
      const sess = socket.request.session;
      const dbUserId = sess && sess.userId;

      // Require authenticated user
      if (!dbUserId) {
        metrics.log('warn', 'auth_fail', { event: 'start_session', code: 'auth_required', socketId: socket.id });
        metrics.recordError();
        socket.emit('session_error', { message: 'Требуется авторизация.', code: 'auth_required' });
        return;
      }

      // Rate limit: max SESSION_START_MAX attempts per SESSION_START_WINDOW_MS per user
      if (process.env.NODE_ENV !== 'test') {
        const now = Date.now();
        let ssrl = sessionStartRateLimits.get(dbUserId) || { count: 0, windowStart: now };
        if (now - ssrl.windowStart >= SESSION_START_WINDOW_MS) {
          ssrl = { count: 0, windowStart: now };
        }
        ssrl.count += 1;
        sessionStartRateLimits.set(dbUserId, ssrl);
        if (ssrl.count > SESSION_START_MAX) {
          socket.emit('session_error', { message: 'Слишком много попыток запуска сессии. Попробуйте через минуту.', code: 'rate_limited' });
          return;
        }
      }

      const user = db.prepare('SELECT username, status FROM users WHERE id = ?').get(dbUserId);
      if (!user) {
        metrics.log('warn', 'auth_fail', { event: 'start_session', code: 'user_not_found', socketId: socket.id });
        metrics.recordError();
        socket.emit('session_error', { message: 'Пользователь не найден.', code: 'auth_required' });
        return;
      }
      const block = getAccessBlockReason(user.status);
      if (block) {
        metrics.log('warn', 'auth_fail', { event: 'start_session', code: block.code, userId: dbUserId });
        metrics.recordError();
        socket.emit('session_error', { message: block.message, code: block.code });
        return;
      }

      // Validate that the requested car exists
      if (!CARS.some((c) => c.id === carId)) {
        socket.emit('session_error', { message: 'Неверный идентификатор машины.' });
        return;
      }

      // Check if car is in maintenance
      const maintRow = db.prepare('SELECT enabled FROM car_maintenance WHERE car_id = ? AND enabled = 1').get(carId);
      if (maintRow) {
        socket.emit('session_error', { message: 'Машина находится на техническом обслуживании.', code: 'car_maintenance' });
        return;
      }

      // Check if this user already has an active session on any car
      const existingUserSession = [...activeSessions.values()].find((s) => s.dbUserId === dbUserId);
      if (existingUserSession) {
        metrics.log('warn', 'session_blocked', {
          reason: 'session_already_active',
          dbUserId,
          existingCarId: existingUserSession.carId,
        });
        socket.emit('session_error', {
          message: 'У вас уже есть активная сессия. Завершите текущую перед запуском другой машины.',
          code: 'session_already_active',
        });
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
      const sessionRef = crypto.randomUUID();
      db.transaction(() => {
        db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(HOLD_AMOUNT, dbUserId);
        const afterHold = db.prepare('SELECT balance FROM users WHERE id = ?').get(dbUserId);
        db.prepare(
          `INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id)
           VALUES (?, 'hold', ?, ?, ?, ?)`
        ).run(dbUserId, -HOLD_AMOUNT, afterHold ? afterHold.balance : 0, 'Блокировка: ' + carName, sessionRef);
      })();

      activeSessions.set(socket.id, {
        carId,
        userId: user.username,
        dbUserId,
        startTime: new Date(),
        holdAmount: HOLD_AMOUNT,
        sessionRef,
      });
      socket.emit('session_started', {
        carId,
        sessionId: socket.id,
        sessionRef,
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

      // Validate control_command payload fields
      const { direction, speed, steering_angle } = data || {};
      if (direction !== undefined && !['forward', 'backward', 'stop'].includes(direction)) {
        socket.emit('control_error', { message: 'Недопустимое направление.', code: 'invalid_direction' });
        return;
      }
      if (speed !== undefined && (!Number.isFinite(speed) || speed < -100 || speed > 100)) {
        socket.emit('control_error', { message: 'Скорость должна быть числом от -100 до 100.', code: 'invalid_speed' });
        return;
      }
      if (steering_angle !== undefined && (!Number.isFinite(steering_angle) || steering_angle < -90 || steering_angle > 90)) {
        socket.emit('control_error', { message: 'Угол поворота должен быть числом от -90 до 90.', code: 'invalid_steering_angle' });
        return;
      }

      metrics.log('info', 'control_command', {
        socketId: socket.id,
        direction: direction || null,
        speed: speed || 0,
        steering_angle: steering_angle || 0,
      });
      setInactivityTimeout(socket);
      const t0 = performance.now();
      const session = activeSessions.get(socket.id);
      if (session) {
        io.to(`car:${session.carId}`).emit('control_command', data);
      }
      metrics.recordCommand();
      metrics.recordLatency(socket.id, performance.now() - t0);
    });

    socket.on('end_session', (data) => {
      clearInactivityTimeout(socket.id);
      clearSessionDurationTimeout(socket.id);
      const session = activeSessions.get(socket.id);
      if (!session) {
        socket.emit('session_error', { message: 'Активная сессия не найдена.', code: 'no_active_session' });
        return;
      }
      const endTime = new Date();
      const durationMs = endTime - session.startTime;
      const durationSeconds = Math.floor(durationMs / 1000);
      const durationMinutes = durationMs / 60000;
      const cost = durationMinutes * RATE_PER_MINUTE;
      activeSessions.delete(socket.id);
      controlCommandCounters.delete(socket.id);
      saveRentalSession(session.dbUserId, session.carId, durationSeconds, cost, session.sessionRef, 'user_end');
      processHoldDeduct(session.dbUserId, session.holdAmount, cost, session.carId, durationSeconds, session.sessionRef);
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
        saveRentalSession(session.dbUserId, session.carId, durationSeconds, cost, session.sessionRef, 'disconnect');
        processHoldDeduct(session.dbUserId, session.holdAmount, cost, session.carId, durationSeconds, session.sessionRef);
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
      // Resolve any in-progress duel for this socket (after regular race cleanup)
      duelManager.handleDisconnect(socket.id);
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
      const { raceId, carId, carName } = data || {};

      // Validate carId if provided — must be a positive integer
      if (carId !== undefined && carId !== null && (!Number.isInteger(carId) || carId < 1)) {
        socket.emit('race_error', { message: 'Неверный идентификатор машины.', code: 'invalid_car_id' });
        return;
      }

      // Validate carName length if provided
      if (carName !== undefined && carName !== null) {
        if (typeof carName !== 'string' || carName.length > 100) {
          socket.emit('race_error', { message: 'Название машины слишком длинное (максимум 100 символов).', code: 'invalid_car_name' });
          return;
        }
      }

      // Read dbUserId from server-side session (not client payload) to prevent spoofing
      const raceSessionData = socket.request.session;
      const dbUserId = raceSessionData && raceSessionData.userId;

      // Require authenticated user
      if (!dbUserId) {
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
      const raceBlock = getAccessBlockReason(user.status);
      if (raceBlock) {
        metrics.log('warn', 'auth_fail', { event: 'join_race', code: raceBlock.code, userId: dbUserId });
        metrics.recordError();
        socket.emit('race_error', { message: raceBlock.message, code: raceBlock.code });
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
      // If the player is in a duel, treat leave as a duel loss (intentional forfeit)
      if (duelManager.getDuelBySocketId(socket.id)) {
        duelManager.handlePlayerLeave(socket.id);
        socket.emit('race_left');
        return;
      }
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

    // --- Duel events ---

    /**
     * duel:search
     * Player requests to be placed in the ranked matchmaking queue.
     * Eligibility: must be authenticated, active, have an active rental session,
     * not already in a race/duel/queue, and have sufficient remaining session time.
     */
    socket.on('duel:search', () => {
      const sess = socket.request.session;
      const dbUserId = sess && sess.userId;

      if (!dbUserId) {
        socket.emit('duel:error', { code: 'auth_required', message: 'Требуется авторизация.' });
        return;
      }

      // Rate limit: max DUEL_SEARCH_MAX searches per DUEL_SEARCH_WINDOW_MS per user
      if (process.env.NODE_ENV !== 'test') {
        const now = Date.now();
        let dsrl = duelSearchRateLimits.get(dbUserId) || { count: 0, windowStart: now };
        if (now - dsrl.windowStart >= DUEL_SEARCH_WINDOW_MS) {
          dsrl = { count: 0, windowStart: now };
        }
        dsrl.count += 1;
        duelSearchRateLimits.set(dbUserId, dsrl);
        if (dsrl.count > DUEL_SEARCH_MAX) {
          socket.emit('duel:error', { code: 'rate_limited', message: 'Слишком много запросов поиска дуэли. Попробуйте через минуту.' });
          return;
        }
      }

      const user = db.prepare(
        'SELECT username, status, rank, stars, is_legend, legend_position FROM users WHERE id = ?',
      ).get(dbUserId);

      if (!user) {
        socket.emit('duel:error', { code: 'user_not_found', message: 'Пользователь не найден.' });
        return;
      }

      const block = getAccessBlockReason(user.status);
      if (block) {
        socket.emit('duel:error', { code: block.code, message: block.message });
        return;
      }

      // Must have an active rental session
      const activeSession = [...activeSessions.values()].find(
        (s) => s.dbUserId === dbUserId,
      );
      if (!activeSession) {
        socket.emit('duel:error', {
          code: 'no_active_session',
          message: 'Для участия в дуэли необходима активная аренда машины.',
        });
        return;
      }

      // Enough remaining session time for a full duel
      const elapsed = Date.now() - activeSession.startTime.getTime();
      const remaining = SESSION_MAX_DURATION_MS - elapsed;
      if (remaining < DUEL_TIMEOUT_MS) {
        socket.emit('duel:error', {
          code: 'insufficient_session_time',
          message: 'Недостаточно времени аренды для проведения дуэли.',
        });
        return;
      }

      // Must not already be in a regular race
      if (findRaceBySocketId(socket.id)) {
        socket.emit('duel:error', {
          code: 'in_race',
          message: 'Нельзя искать дуэль во время гонки.',
        });
        return;
      }

      // Must not already be in a duel or queue
      if (duelManager.getDuelBySocketId(socket.id) || duelManager.isInQueue(dbUserId)) {
        socket.emit('duel:error', {
          code: 'already_in_duel',
          message: 'Вы уже находитесь в дуэли или очереди поиска.',
        });
        return;
      }

      const result = duelManager.addToQueue({
        userId: dbUserId,
        socketId: socket.id,
        username: user.username,
        rank: user.rank,
        stars: user.stars,
        isLegend: Boolean(user.is_legend),
        legendPosition: user.legend_position || null,
        carId: activeSession.carId || null,
      });

      if (result.error) {
        socket.emit('duel:error', { code: result.error, message: 'Ошибка при добавлении в очередь.' });
        return;
      }

      if (result.queued) {
        socket.emit('duel:searching', { message: 'Поиск соперника...' });
        metrics.log('info', 'duel_search_start', { userId: dbUserId });
      }
      // If result.matched, duelManager already emitted duel:matched to both sockets
    });

    /**
     * duel:cancel_search
     * Player cancels an active matchmaking search.
     */
    socket.on('duel:cancel_search', () => {
      const sess = socket.request.session;
      const dbUserId = sess && sess.userId;
      if (!dbUserId) return;

      const { removed } = duelManager.removeFromQueue(dbUserId);
      if (removed) {
        socket.emit('duel:search_cancelled', { message: 'Поиск отменён.' });
      }
    });

    /**
     * duel:cancel_ready
     * Player cancels while in ready_pending state (before countdown starts).
     * Both matched players receive duel:cancelled.
     */
    socket.on('duel:cancel_ready', () => {
      const result = duelManager.cancelReady(socket.id);
      if (result.cancelled) {
        result.affectedSocketIds.forEach((sid) => {
          io.to(sid).emit('duel:cancelled', { reason: 'player_cancelled' });
        });
      }
    });

    /**
     * duel:ready
     * Player confirms they are ready to start the duel (ready-state gate).
     * Both players must emit this before the duel transitions to in_progress.
     */
    socket.on('duel:ready', () => {
      const result = duelManager.handleReady(socket.id);
      if (!result.ok) {
        socket.emit('duel:error', { code: result.error, message: 'Не удалось подтвердить готовность.' });
      }
    });

    /**
     * duel:start_lap
     * Player signals the start of their ranked lap in a matched duel.
     */
    socket.on('duel:start_lap', () => {
      const result = duelManager.handleStartLap(socket.id);
      if (!result.ok) {
        socket.emit('duel:error', { code: result.error, message: 'Не удалось начать круг.' });
        return;
      }
      socket.emit('duel:lap_started', { startTime: Date.now() });
    });

    /**
     * duel:checkpoint
     * Player reports hitting a checkpoint.
     * Payload: { index: number }  (0-based)
     */
    socket.on('duel:checkpoint', (data) => {
      const index = data && Number.isInteger(data.index) ? data.index : -1;
      if (index < 0) {
        socket.emit('duel:error', { code: 'invalid_checkpoint', message: 'Неверный индекс чекпоинта.' });
        return;
      }
      const result = duelManager.handleCheckpoint(socket.id, index);
      if (!result.ok) {
        socket.emit('duel:error', { code: result.error, message: 'Чекпоинт не принят.' });
        return;
      }
      socket.emit('duel:checkpoint_ok', { index, nextCheckpoint: result.nextCheckpoint });
    });

    /**
     * duel:finish_lap
     * Player claims to have completed a valid lap.
     * The first accepted finish wins the duel immediately.
     */
    socket.on('duel:finish_lap', () => {
      const result = duelManager.handleFinishLap(socket.id);
      if (!result.ok) {
        // When cancelled is true the duel:cancelled event was already emitted to both players
        if (!result.cancelled) {
          socket.emit('duel:error', { code: result.error, message: 'Финиш не принят.' });
        }
        return;
      }
      // duelManager already emitted duel:result to both players
    });
  });

  /**
   * Force-end the active session for a given carId.
   * Used by the admin force-end route.
   *
   * @param {number} carId
   * @param {{ adminId: number, adminUsername: string }} adminContext
   * @returns {{ ended: boolean, session?: object, message?: string }}
   */
  function forceEndSession(carId, adminContext) {
    // Find the socketId that owns a session on this carId
    let targetSocketId = null;
    let targetSession = null;
    for (const [sid, session] of activeSessions) {
      if (session.carId === carId) {
        targetSocketId = sid;
        targetSession = session;
        break;
      }
    }

    if (!targetSocketId || !targetSession) {
      return { ended: false, message: 'Нет активной сессии' };
    }

    // Clear timers
    clearInactivityTimeout(targetSocketId);
    clearSessionDurationTimeout(targetSocketId);

    // Calculate duration and cost (same as normal end flow)
    const endTime = new Date();
    const durationMs = endTime - targetSession.startTime;
    const durationSeconds = Math.floor(durationMs / 1000);
    const durationMinutes = durationMs / 60000;
    const cost = durationMinutes * RATE_PER_MINUTE;

    // Remove from active sessions map (must happen before save to prevent duplicate ends)
    activeSessions.delete(targetSocketId);

    // Persist rental session and process balance
    saveRentalSession(targetSession.dbUserId, targetSession.carId, durationSeconds, cost, targetSession.sessionRef, 'admin_force_end');
    processHoldDeduct(targetSession.dbUserId, targetSession.holdAmount, cost, targetSession.carId, durationSeconds, targetSession.sessionRef);

    // Notify the client socket
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit('session_ended', {
        carId: targetSession.carId,
        durationSeconds,
        cost,
        reason: 'admin_force_end',
      });
    }

    // Broadcast updated car availability
    broadcastCarsUpdate();

    metrics.log('info', 'session_force_end', {
      adminId: adminContext ? adminContext.adminId : null,
      adminUsername: adminContext ? adminContext.adminUsername : null,
      userId: targetSession.userId,
      dbUserId: targetSession.dbUserId,
      carId: targetSession.carId,
      durationSeconds,
      cost: parseFloat(cost.toFixed(4)),
    });

    const carName = CARS.find((c) => c.id === targetSession.carId)?.name || ('Машина #' + targetSession.carId);

    return {
      ended: true,
      session: {
        carId: targetSession.carId,
        carName,
        userId: targetSession.dbUserId || null,
        username: targetSession.userId || null,
        durationSeconds,
        cost: Math.round(cost * 100) / 100,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Stale device detection: every HEARTBEAT_CHECK_INTERVAL_MS, disconnect
  // devices that have not sent a heartbeat for > HEARTBEAT_STALE_MS.
  // ---------------------------------------------------------------------------
  const heartbeatCheckInterval = setInterval(() => {
    const cutoff = new Date(Date.now() - HEARTBEAT_STALE_MS).toISOString();
    let staleDevices;
    try {
      staleDevices = db.prepare(
        "SELECT id, car_id FROM devices WHERE status = 'active' AND last_seen_at IS NOT NULL AND last_seen_at < ?"
      ).all(cutoff);
    } catch (e) {
      metrics.log('error', 'heartbeat_check_error', { error: e.message });
      return;
    }
    for (const dev of staleDevices) {
      const sock = deviceSockets.get(Number(dev.car_id));
      if (sock) {
        metrics.log('warn', 'device_heartbeat_timeout', { deviceId: dev.id, carId: dev.car_id });
        sock.emit('device:kicked', { reason: 'heartbeat_timeout' });
        sock.disconnect(true);
        deviceSockets.delete(Number(dev.car_id));
      }
    }
  }, HEARTBEAT_CHECK_INTERVAL_MS);

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
    forceEndSession,
    duelManager,
    deviceSockets,
    heartbeatCheckInterval,
  };
}

module.exports = { setupSocketIo };
