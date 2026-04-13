'use strict';

const { getAccessBlockReason } = require('../middleware/roles');
const { socketRateLimit } = require('./validators');

const MAX_LEADERBOARD = 20;

function createRaceId(state) {
  state.raceCounter += 1;
  return 'race-' + Date.now() + '-' + state.raceCounter + '-' + Math.random().toString(36).slice(2, 7);
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

function findRaceBySocketId(socketId, state) {
  for (const race of state.raceRooms.values()) {
    if (race.players.some((p) => p.socketId === socketId)) return race;
  }
  return null;
}

function broadcastRacesUpdate(io, state) {
  const races = [...state.raceRooms.values()].map((r) => ({
    id: r.id,
    name: r.name,
    playerCount: r.players.length,
    status: r.status,
    createdAt: r.createdAt,
  }));
  io.emit('races_updated', { races });
}

function removeFromRace(socket, io, state) {
  const race = findRaceBySocketId(socket.id, state);
  if (!race) return;
  race.players = race.players.filter((p) => p.socketId !== socket.id);
  socket.leave(race.id);
  if (race.players.length === 0) {
    state.raceRooms.delete(race.id);
  } else {
    io.to(race.id).emit('race_updated', {
      raceId: race.id,
      raceName: race.name,
      players: race.players.map(serializePlayer),
    });
  }
}

/**
 * Register racing and duel event handlers on the given socket.
 *
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {object} state
 * @param {object} deps
 * @param {object} duelManager
 */
function setup(io, socket, state, deps) {
  const { db, metrics, DUEL_TIMEOUT_MS, SESSION_MAX_DURATION_MS } = deps;
  const duelManager = deps.duelManager;

  socket.on('join_race', (data) => {
    const { raceId, carId, carName } = data || {};

    if (carId !== undefined && carId !== null && (!Number.isInteger(carId) || carId < 1)) {
      socket.emit('race_error', { message: 'Неверный идентификатор машины.', code: 'invalid_car_id' });
      return;
    }
    if (carName !== undefined && carName !== null) {
      if (typeof carName !== 'string' || carName.length > 100) {
        socket.emit('race_error', { message: 'Название машины слишком длинное (максимум 100 символов).', code: 'invalid_car_name' });
        return;
      }
    }

    const raceSessionData = socket.request.session;
    const dbUserId = raceSessionData && raceSessionData.userId;

    if (!dbUserId) {
      metrics.log('warn', 'auth_fail', { event: 'join_race', code: 'auth_required', socketId: socket.id });
      metrics.recordError();
      socket.emit('race_error', { message: 'Требуется авторизация.', code: 'auth_required' });
      return;
    }

    if (!socketRateLimit(state.joinRaceRateLimits, dbUserId, 10, 60_000)) {
      socket.emit('race_error', { message: 'Слишком много запросов. Попробуйте позже.', code: 'rate_limited' });
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

    removeFromRace(socket, io, state);

    let race;
    if (raceId && state.raceRooms.has(raceId)) {
      race = state.raceRooms.get(raceId);
    } else {
      const newId = createRaceId(state);
      race = {
        id: newId,
        name: 'Гонка #' + (state.raceRooms.size + 1),
        players: [],
        status: 'racing',
        createdAt: new Date().toISOString(),
      };
      state.raceRooms.set(newId, race);
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
      leaderboard: state.leaderboard.slice(0, 10),
    });

    io.to(race.id).emit('race_updated', {
      raceId: race.id,
      raceName: race.name,
      players: race.players.map(serializePlayer),
    });

    broadcastRacesUpdate(io, state);
    metrics.log('info', 'race_join', { userId: user.username, dbUserId, raceId: race.id, socketId: socket.id });
  });

  socket.on('leave_race', () => {
    const sess = socket.request.session;
    if (!sess || !sess.userId) return;
    const statusUser = db.prepare('SELECT status FROM users WHERE id = ?').get(sess.userId);
    if (!statusUser || statusUser.status !== 'active') return;
    if (duelManager.getDuelBySocketId(socket.id)) {
      duelManager.handlePlayerLeave(socket.id);
      socket.emit('race_left');
      return;
    }
    const race = findRaceBySocketId(socket.id, state);
    const raceId = race ? race.id : null;
    removeFromRace(socket, io, state);
    socket.emit('race_left');
    broadcastRacesUpdate(io, state);
    if (raceId) metrics.log('info', 'race_leave', { socketId: socket.id, raceId });
  });

  socket.on('start_lap', () => {
    const sess = socket.request.session;
    if (!sess || !sess.userId) return;
    const statusUser = db.prepare('SELECT status FROM users WHERE id = ?').get(sess.userId);
    if (!statusUser || statusUser.status !== 'active') return;
    const race = findRaceBySocketId(socket.id, state);
    if (!race) return;
    const player = race.players.find((p) => p.socketId === socket.id);
    if (!player) return;
    player.currentLapStart = Date.now();
    socket.emit('lap_started', { startTime: player.currentLapStart });
  });

  socket.on('end_lap', () => {
    const sess = socket.request.session;
    if (!sess || !sess.userId) return;
    const statusUser = db.prepare('SELECT status FROM users WHERE id = ?').get(sess.userId);
    if (!statusUser || statusUser.status !== 'active') return;
    if (!socketRateLimit(state.endLapRateLimits, sess.userId, 60, 60_000)) {
      return;
    }
    const race = findRaceBySocketId(socket.id, state);
    if (!race) return;
    const player = race.players.find((p) => p.socketId === socket.id);
    if (!player || !player.currentLapStart) return;

    const lapTimeMs = Date.now() - player.currentLapStart;
    player.currentLapStart = null;
    player.lapCount++;

    const isPersonalBest = !player.bestLapTime || lapTimeMs < player.bestLapTime;
    if (isPersonalBest) player.bestLapTime = lapTimeMs;

    state.leaderboard.push({
      userId: player.userId,
      carName: player.carName,
      lapTimeMs,
      date: new Date().toISOString(),
    });
    state.leaderboard.sort((a, b) => a.lapTimeMs - b.lapTimeMs);
    if (state.leaderboard.length > MAX_LEADERBOARD) state.leaderboard.length = MAX_LEADERBOARD;

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

    const isGlobalRecord = state.leaderboard[0].lapTimeMs === lapTimeMs && state.leaderboard[0].userId === player.userId;

    io.to(race.id).emit('lap_recorded', {
      userId: player.userId,
      carName: player.carName,
      lapTimeMs,
      isPersonalBest,
      isGlobalRecord,
      leaderboard: state.leaderboard.slice(0, 10),
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

  socket.on('duel:search', () => {
    const sess = socket.request.session;
    const dbUserId = sess && sess.userId;

    if (!dbUserId) {
      socket.emit('duel:error', { code: 'auth_required', message: 'Требуется авторизация.' });
      return;
    }

    if (process.env.NODE_ENV !== 'test') {
      const now = Date.now();
      let dsrl = state.duelSearchRateLimits.get(dbUserId) || { count: 0, windowStart: now };
      if (now - dsrl.windowStart >= 60_000) dsrl = { count: 0, windowStart: now };
      dsrl.count += 1;
      state.duelSearchRateLimits.set(dbUserId, dsrl);
      if (dsrl.count > 3) {
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

    const activeSession = [...state.activeSessions.values()].find((s) => s.dbUserId === dbUserId);
    if (!activeSession) {
      socket.emit('duel:error', { code: 'no_active_session', message: 'Для участия в дуэли необходима активная аренда машины.' });
      return;
    }

    const elapsed = Date.now() - activeSession.startTime.getTime();
    const remaining = SESSION_MAX_DURATION_MS - elapsed;
    if (remaining < DUEL_TIMEOUT_MS) {
      socket.emit('duel:error', { code: 'insufficient_session_time', message: 'Недостаточно времени аренды для проведения дуэли.' });
      return;
    }

    if (findRaceBySocketId(socket.id, state)) {
      socket.emit('duel:error', { code: 'in_race', message: 'Нельзя искать дуэль во время гонки.' });
      return;
    }

    if (duelManager.getDuelBySocketId(socket.id) || duelManager.isInQueue(dbUserId)) {
      socket.emit('duel:error', { code: 'already_in_duel', message: 'Вы уже находитесь в дуэли или очереди поиска.' });
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
  });

  socket.on('duel:cancel_search', () => {
    const sess = socket.request.session;
    const dbUserId = sess && sess.userId;
    if (!dbUserId) return;
    const statusUser = db.prepare('SELECT status FROM users WHERE id = ?').get(dbUserId);
    if (!statusUser || statusUser.status !== 'active') return;
    if (!socketRateLimit(state.duelEventRateLimits, socket.id, 10, 1_000)) {
      socket.emit('duel:error', { code: 'rate_limited', message: 'Слишком много запросов.' });
      return;
    }
    const { removed } = duelManager.removeFromQueue(dbUserId);
    if (removed) socket.emit('duel:search_cancelled', { message: 'Поиск отменён.' });
  });

  socket.on('duel:cancel_ready', () => {
    const sess = socket.request.session;
    if (!sess || !sess.userId) return;
    const statusUser = db.prepare('SELECT status FROM users WHERE id = ?').get(sess.userId);
    if (!statusUser || statusUser.status !== 'active') return;
    if (!socketRateLimit(state.duelEventRateLimits, socket.id, 10, 1_000)) {
      socket.emit('duel:error', { code: 'rate_limited', message: 'Слишком много запросов.' });
      return;
    }
    const result = duelManager.cancelReady(socket.id);
    if (result.cancelled) {
      result.affectedSocketIds.forEach((sid) => {
        io.to(sid).emit('duel:cancelled', { reason: 'player_cancelled' });
      });
    }
  });

  socket.on('duel:ready', () => {
    const sess = socket.request.session;
    if (!sess || !sess.userId) return;
    const statusUser = db.prepare('SELECT status FROM users WHERE id = ?').get(sess.userId);
    if (!statusUser || statusUser.status !== 'active') return;
    if (!socketRateLimit(state.duelEventRateLimits, socket.id, 10, 1_000)) {
      socket.emit('duel:error', { code: 'rate_limited', message: 'Слишком много запросов.' });
      return;
    }
    const result = duelManager.handleReady(socket.id);
    if (!result.ok) socket.emit('duel:error', { code: result.error, message: 'Не удалось подтвердить готовность.' });
  });

  socket.on('duel:start_lap', () => {
    const sess = socket.request.session;
    if (!sess || !sess.userId) return;
    if (!socketRateLimit(state.duelEventRateLimits, socket.id, 10, 1_000)) {
      socket.emit('duel:error', { code: 'rate_limited', message: 'Слишком много запросов.' });
      return;
    }
    const result = duelManager.handleStartLap(socket.id);
    if (!result.ok) {
      socket.emit('duel:error', { code: result.error, message: 'Не удалось начать круг.' });
      return;
    }
    socket.emit('duel:lap_started', { startTime: Date.now() });
  });

  socket.on('duel:checkpoint', (data) => {
    const sess = socket.request.session;
    if (!sess || !sess.userId) return;
    if (!socketRateLimit(state.duelEventRateLimits, socket.id, 10, 1_000)) {
      socket.emit('duel:error', { code: 'rate_limited', message: 'Слишком много запросов.' });
      return;
    }
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

  socket.on('duel:finish_lap', () => {
    const sess = socket.request.session;
    if (!sess || !sess.userId) return;
    if (!socketRateLimit(state.duelEventRateLimits, socket.id, 10, 1_000)) {
      socket.emit('duel:error', { code: 'rate_limited', message: 'Слишком много запросов.' });
      return;
    }
    const result = duelManager.handleFinishLap(socket.id);
    if (!result.ok) {
      if (!result.cancelled) socket.emit('duel:error', { code: result.error, message: 'Финиш не принят.' });
      return;
    }
  });
}

/**
 * Handle socket disconnect for racing/duel cleanup.
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 * @param {object} state
 * @param {object} duelManager
 */
function handleDisconnect(socket, io, state, duelManager) {
  removeFromRace(socket, io, state);
  duelManager.handleDisconnect(socket.id);
  broadcastRacesUpdate(io, state);
}

module.exports = { setup, handleDisconnect };
