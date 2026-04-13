'use strict';

const { performance } = require('perf_hooks');
const crypto = require('crypto');
const { getAccessBlockReason } = require('../middleware/roles');
const { requireSessionOwner } = require('./validators');

const MIN_BALANCE_FOR_SESSION = 100;
const ALLOWED_CONTROL_FIELDS = new Set(['direction', 'speed', 'steering_angle']);

/**
 * Create the processHoldDeduct function bound to db and CARS.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array} CARS
 * @returns {Function}
 */
function createProcessHoldDeduct(db, CARS, metrics) {
  return function processHoldDeduct(dbUserId, holdAmount, actualCost, carId, durationSeconds, sessionRef) {
    if (!dbUserId || holdAmount == null) return;
    const carName = CARS.find((c) => c.id === carId)?.name || ('Машина #' + carId);
    const ref = sessionRef || null;
    try {
      const t0 = Date.now();
      db.transaction(() => {
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
      if (metrics) metrics.recordDbLatency(Date.now() - t0);
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || (e.message && e.message.includes('UNIQUE constraint'))) {
        console.warn('[Balance] processHoldDeduct: duplicate transaction blocked by constraint for ref:', ref);
      } else {
        console.error('[Balance] processHoldDeduct error:', e);
      }
    }
  };
}

/**
 * Create the broadcastCarsUpdate function.
 *
 * @param {import('socket.io').Server} io
 * @param {object} state
 * @param {object} deps
 * @returns {Function}
 */
function createBroadcastCarsUpdate(io, state, deps) {
  const { db, CARS } = deps;
  return function broadcastCarsUpdate() {
    const activeCars = new Set([...state.activeSessions.values()].map((s) => s.carId));
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
  };
}

/**
 * Create clearInactivityTimeout bound to state.
 */
function createClearInactivityTimeout(state) {
  return function clearInactivityTimeout(socketId) {
    if (state.inactivityTimeouts.has(socketId)) {
      clearTimeout(state.inactivityTimeouts.get(socketId));
      state.inactivityTimeouts.delete(socketId);
    }
  };
}

/**
 * Create clearSessionDurationTimeout bound to state.
 */
function createClearSessionDurationTimeout(state) {
  return function clearSessionDurationTimeout(socketId) {
    if (state.sessionDurationTimeouts.has(socketId)) {
      clearTimeout(state.sessionDurationTimeouts.get(socketId));
      state.sessionDurationTimeouts.delete(socketId);
    }
  };
}

/**
 * Build the setInactivityTimeout and setSessionDurationTimeout functions.
 * They are bound to state, deps, and the helper functions.
 */
function createTimerHelpers(state, deps, helpers) {
  const { clearInactivityTimeout, clearSessionDurationTimeout, processHoldDeduct, broadcastCarsUpdate } = helpers;
  const { metrics, RATE_PER_MINUTE, INACTIVITY_TIMEOUT_MS, SESSION_MAX_DURATION_MS, saveRentalSession } = deps;

  function setInactivityTimeout(socket) {
    clearInactivityTimeout(socket.id);
    const timeout = setTimeout(() => {
      const session = state.activeSessions.get(socket.id);
      if (!session) return;
      const endTime = new Date();
      const durationMs = endTime - session.startTime;
      const durationSeconds = Math.floor(durationMs / 1000);
      const durationMinutes = durationMs / 60000;
      const cost = durationMinutes * RATE_PER_MINUTE;
      state.activeSessions.delete(socket.id);
      state.inactivityTimeouts.delete(socket.id);
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
    state.inactivityTimeouts.set(socket.id, timeout);
  }

  function setSessionDurationTimeout(socket) {
    clearSessionDurationTimeout(socket.id);
    const timeout = setTimeout(() => {
      const session = state.activeSessions.get(socket.id);
      if (!session) return;
      const endTime = new Date();
      const durationMs = endTime - session.startTime;
      const durationSeconds = Math.floor(durationMs / 1000);
      const durationMinutes = durationMs / 60000;
      const cost = durationMinutes * RATE_PER_MINUTE;
      state.activeSessions.delete(socket.id);
      state.sessionDurationTimeouts.delete(socket.id);
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
    state.sessionDurationTimeouts.set(socket.id, timeout);
  }

  return { setInactivityTimeout, setSessionDurationTimeout };
}

/**
 * Create the forceEndSession admin function.
 *
 * @param {import('socket.io').Server} io
 * @param {object} state
 * @param {object} deps
 * @param {object} helpers
 * @returns {Function}
 */
function createForceEndSession(io, state, deps, helpers) {
  const { clearInactivityTimeout, clearSessionDurationTimeout, processHoldDeduct, broadcastCarsUpdate } = helpers;
  const { metrics, RATE_PER_MINUTE, saveRentalSession, CARS } = deps;

  return function forceEndSession(carId, adminContext) {
    let targetSocketId = null;
    let targetSession = null;
    for (const [sid, session] of state.activeSessions) {
      if (session.carId === carId) {
        targetSocketId = sid;
        targetSession = session;
        break;
      }
    }

    if (!targetSocketId || !targetSession) {
      return { ended: false, message: 'Нет активной сессии' };
    }

    clearInactivityTimeout(targetSocketId);
    clearSessionDurationTimeout(targetSocketId);

    const endTime = new Date();
    const durationMs = endTime - targetSession.startTime;
    const durationSeconds = Math.floor(durationMs / 1000);
    const durationMinutes = durationMs / 60000;
    const cost = durationMinutes * RATE_PER_MINUTE;

    state.activeSessions.delete(targetSocketId);

    saveRentalSession(targetSession.dbUserId, targetSession.carId, durationSeconds, cost, targetSession.sessionRef, 'admin_force_end');
    processHoldDeduct(targetSession.dbUserId, targetSession.holdAmount, cost, targetSession.carId, durationSeconds, targetSession.sessionRef);

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit('session_ended', {
        carId: targetSession.carId,
        durationSeconds,
        cost,
        reason: 'admin_force_end',
      });
    }

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
  };
}

/**
 * Handle session reconnect adoption on new socket connection.
 *
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {object} state
 * @param {object} deps
 * @param {object} helpers - { clearInactivityTimeout, clearSessionDurationTimeout, setInactivityTimeout, setSessionDurationTimeout }
 */
function handleReconnect(io, socket, state, deps, helpers) {
  const { clearInactivityTimeout, clearSessionDurationTimeout, setInactivityTimeout, setSessionDurationTimeout } = helpers;
  const { metrics, CARS, SESSION_MAX_DURATION_MS, INACTIVITY_TIMEOUT_MS } = deps;

  const reconnectSess = socket.request.session;
  const reconnectUserId = reconnectSess && reconnectSess.userId;
  if (!reconnectUserId) return;

  let existingSocketId = null;
  let existingSession = null;
  for (const [sid, session] of state.activeSessions) {
    if (session.dbUserId === reconnectUserId && sid !== socket.id) {
      existingSocketId = sid;
      existingSession = session;
      break;
    }
  }

  if (existingSocketId && existingSession) {
    state.activeSessions.delete(existingSocketId);
    state.activeSessions.set(socket.id, existingSession);

    clearInactivityTimeout(existingSocketId);
    clearSessionDurationTimeout(existingSocketId);
    state.controlCommandCounters.delete(existingSocketId);

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

/**
 * Handle socket disconnect for session cleanup.
 * Returns whether there was an active session.
 *
 * @param {import('socket.io').Socket} socket
 * @param {object} state
 * @param {object} deps
 * @param {object} helpers - { clearInactivityTimeout, clearSessionDurationTimeout, processHoldDeduct, broadcastCarsUpdate }
 * @returns {boolean} hadSession
 */
function handleDisconnect(socket, state, deps, helpers) {
  const { clearInactivityTimeout, clearSessionDurationTimeout, processHoldDeduct, broadcastCarsUpdate } = helpers;
  const { metrics, RATE_PER_MINUTE, saveRentalSession } = deps;

  clearInactivityTimeout(socket.id);
  clearSessionDurationTimeout(socket.id);
  state.controlCommandCounters.delete(socket.id);

  const session = state.activeSessions.get(socket.id);
  const hadSession = !!session;

  if (hadSession) {
    const endTime = new Date();
    const durationMs = endTime - session.startTime;
    const durationSeconds = Math.floor(durationMs / 1000);
    const durationMinutes = durationMs / 60000;
    const cost = durationMinutes * RATE_PER_MINUTE;
    state.activeSessions.delete(socket.id);
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
    state.activeSessions.delete(socket.id);
  }

  return hadSession;
}

/**
 * Register session event handlers on the given socket.
 *
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {object} state
 * @param {object} deps
 * @param {object} helpers - { clearInactivityTimeout, clearSessionDurationTimeout, processHoldDeduct, broadcastCarsUpdate }
 */
function setup(io, socket, state, deps, helpers) {
  const { processHoldDeduct, broadcastCarsUpdate } = helpers;
  const {
    db, metrics, CARS, RATE_PER_MINUTE, SESSION_MAX_DURATION_MS, INACTIVITY_TIMEOUT_MS,
    CONTROL_RATE_LIMIT_MAX, CONTROL_RATE_LIMIT_WINDOW_MS, saveRentalSession, HOLD_AMOUNT,
  } = deps;

  const { setInactivityTimeout, setSessionDurationTimeout } = createTimerHelpers(state, deps, helpers);

  function checkControlRateLimit(socketId) {
    const now = Date.now();
    const entry = state.controlCommandCounters.get(socketId) || { count: 0, windowStart: now };
    if (now - entry.windowStart >= CONTROL_RATE_LIMIT_WINDOW_MS) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count += 1;
    state.controlCommandCounters.set(socketId, entry);
    return entry.count <= CONTROL_RATE_LIMIT_MAX;
  }

  socket.on('start_session', (data) => {
    const { carId } = data;
    const sess = socket.request.session;
    const dbUserId = sess && sess.userId;

    if (!dbUserId) {
      metrics.log('warn', 'auth_fail', { event: 'start_session', code: 'auth_required', socketId: socket.id });
      metrics.recordError();
      socket.emit('session_error', { message: 'Требуется авторизация.', code: 'auth_required' });
      return;
    }

    if (process.env.NODE_ENV !== 'test') {
      const now = Date.now();
      let ssrl = state.sessionStartRateLimits.get(dbUserId) || { count: 0, windowStart: now };
      if (now - ssrl.windowStart >= 60_000) ssrl = { count: 0, windowStart: now };
      ssrl.count += 1;
      state.sessionStartRateLimits.set(dbUserId, ssrl);
      if (ssrl.count > 5) {
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

    if (!Number.isInteger(carId) || carId < 1) {
      socket.emit('session_error', { message: 'Неверный идентификатор машины.', code: 'invalid_car_id' });
      return;
    }
    if (!CARS.some((c) => c.id === carId)) {
      socket.emit('session_error', { message: 'Неверный идентификатор машины.' });
      return;
    }

    const maintRow = db.prepare('SELECT enabled FROM car_maintenance WHERE car_id = ? AND enabled = 1').get(carId);
    if (maintRow) {
      socket.emit('session_error', { message: 'Машина находится на техническом обслуживании.', code: 'car_maintenance' });
      return;
    }

    const existingUserSession = [...state.activeSessions.values()].find((s) => s.dbUserId === dbUserId);
    if (existingUserSession) {
      metrics.log('warn', 'session_blocked', { reason: 'session_already_active', dbUserId, existingCarId: existingUserSession.carId });
      socket.emit('session_error', {
        message: 'У вас уже есть активная сессия. Завершите текущую перед запуском другой машины.',
        code: 'session_already_active',
      });
      return;
    }

    if ([...state.activeSessions.values()].some((s) => s.carId === carId)) {
      socket.emit('session_error', { message: 'Эта машина уже занята. Выберите другую.' });
      return;
    }

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
    const holdT0 = Date.now();
    db.transaction(() => {
      db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(HOLD_AMOUNT, dbUserId);
      const afterHold = db.prepare('SELECT balance FROM users WHERE id = ?').get(dbUserId);
      db.prepare(
        `INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id)
         VALUES (?, 'hold', ?, ?, ?, ?)`
      ).run(dbUserId, -HOLD_AMOUNT, afterHold ? afterHold.balance : 0, 'Блокировка: ' + carName, sessionRef);
    })();
    metrics.recordDbLatency?.(Date.now() - holdT0);

    state.activeSessions.set(socket.id, {
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
    const ownedSession = requireSessionOwner(socket, state.activeSessions);
    if (!ownedSession) return;
    if (!checkControlRateLimit(socket.id)) {
      metrics.recordError();
      socket.emit('control_error', { message: 'Слишком много команд. Подождите немного.', code: 'rate_limited' });
      return;
    }

    if (data !== null && data !== undefined && typeof data === 'object') {
      for (const key of Object.keys(data)) {
        if (!ALLOWED_CONTROL_FIELDS.has(key)) {
          socket.emit('control_error', { message: 'Неизвестное поле в команде управления.', code: 'invalid_payload' });
          return;
        }
      }
    }

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
      requestId: socket.data.requestId,
      direction: direction || null,
      speed: speed || 0,
      steering_angle: steering_angle || 0,
    });
    setInactivityTimeout(socket);
    const t0 = performance.now();
    io.to(`car:${ownedSession.carId}`).emit('control_command', data);
    metrics.recordCommand();
    metrics.recordLatency(socket.id, performance.now() - t0);
  });

  socket.on('end_session', () => {
    const { clearInactivityTimeout: clearInact, clearSessionDurationTimeout: clearDur } = helpers;
    clearInact(socket.id);
    clearDur(socket.id);
    const session = state.activeSessions.get(socket.id);
    if (!session) {
      socket.emit('session_error', { message: 'Активная сессия не найдена.', code: 'no_active_session' });
      return;
    }
    const requestSession = socket.request.session;
    if (!requestSession || requestSession.userId !== session.dbUserId) {
      socket.emit('session_error', { message: 'Недостаточно прав.', code: 'forbidden' });
      return;
    }
    const endTime = new Date();
    const durationMs = endTime - session.startTime;
    const durationSeconds = Math.floor(durationMs / 1000);
    const durationMinutes = durationMs / 60000;
    const cost = durationMinutes * RATE_PER_MINUTE;
    state.activeSessions.delete(socket.id);
    state.controlCommandCounters.delete(socket.id);
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
}

module.exports = {
  createProcessHoldDeduct,
  createBroadcastCarsUpdate,
  createClearInactivityTimeout,
  createClearSessionDurationTimeout,
  createTimerHelpers,
  createForceEndSession,
  handleReconnect,
  handleDisconnect,
  setup,
};
