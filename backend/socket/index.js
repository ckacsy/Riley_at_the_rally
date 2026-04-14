'use strict';

const DuelManager = require('../lib/duel-manager');
const { DUEL_TIMEOUT_MS } = require('../lib/rank-config');
const { HOLD_AMOUNT, HEARTBEAT_STALE_MS, HEARTBEAT_CHECK_INTERVAL_MS } = require('../config/constants');
const { createStateStore } = require('./state-store');
const chatModule = require('./chat');
const presenceModule = require('./presence');
const racingModule = require('./racing');
const sessionsModule = require('./sessions');
const devicesModule = require('./devices');

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

  // Extend deps with constants imported at module level
  const fullDeps = {
    db,
    metrics,
    RATE_PER_MINUTE,
    SESSION_MAX_DURATION_MS,
    INACTIVITY_TIMEOUT_MS,
    CONTROL_RATE_LIMIT_MAX,
    CONTROL_RATE_LIMIT_WINDOW_MS,
    CARS,
    saveRentalSession,
    HOLD_AMOUNT,
    HEARTBEAT_STALE_MS,
    HEARTBEAT_CHECK_INTERVAL_MS,
    DUEL_TIMEOUT_MS,
  };

  const state = createStateStore();

  const duelManager = new DuelManager({
    db,
    io,
    metrics,
    getActiveSession: (socketId) => state.activeSessions.get(socketId),
  });

  // Bind duelManager into fullDeps so racing module can access it
  fullDeps.duelManager = duelManager;

  // Create shared helper functions
  const processHoldDeduct = sessionsModule.createProcessHoldDeduct(db, CARS, metrics);
  const broadcastCarsUpdate = sessionsModule.createBroadcastCarsUpdate(io, state, fullDeps);
  const clearInactivityTimeout = sessionsModule.createClearInactivityTimeout(state);
  const clearSessionDurationTimeout = sessionsModule.createClearSessionDurationTimeout(state);
  const broadcastPresenceUpdate = presenceModule.createBroadcastPresenceUpdate(io, state);

  const sessionHelpers = {
    clearInactivityTimeout,
    clearSessionDurationTimeout,
    processHoldDeduct,
    broadcastCarsUpdate,
  };

  const forceEndSession = sessionsModule.createForceEndSession(io, state, fullDeps, sessionHelpers);

  // Start presence stale-cleanup interval
  presenceModule.startStaleCleanup(state, broadcastPresenceUpdate, metrics);

  // Session-to-Socket.IO bridge
  io.use((socket, next) => {
    sessionMiddleware(socket.request, socket.request.res || {}, next);
  });

  io.on('connection', (socket) => {
    const requestId = socket.handshake.headers['x-request-id'] || socket.request.requestId || undefined;
    socket.data.requestId = requestId;
    metrics.log('debug', 'socket_connect', { socketId: socket.id, requestId });

    // Device sockets are handled separately and return early
    if (devicesModule.setup(io, socket, state, fullDeps)) return;

    // Reconnect adoption: migrate session from old socket to new socket
    const timerHelpers = sessionsModule.createTimerHelpers(state, fullDeps, sessionHelpers);
    sessionsModule.handleReconnect(io, socket, state, fullDeps, { ...sessionHelpers, ...timerHelpers });

    // Send chat history to newly connected clients
    socket.emit('chat:history', chatModule.getChatHistory(db));

    // Register module event handlers
    chatModule.setup(io, socket, state, fullDeps);
    presenceModule.setup(io, socket, state, fullDeps, broadcastPresenceUpdate);
    racingModule.setup(io, socket, state, fullDeps);
    sessionsModule.setup(io, socket, state, fullDeps, sessionHelpers);

    // Ping round-trip handler for client-side latency measurement
    socket.on('ping_check', function (callback) {
      if (typeof callback === 'function') callback();
    });

    socket.on('disconnect', () => {
      const hadSession = sessionsModule.handleDisconnect(socket, state, fullDeps, sessionHelpers);
      racingModule.handleDisconnect(socket, io, state, duelManager);
      if (hadSession) broadcastCarsUpdate();
      presenceModule.handleDisconnect(socket, state, broadcastPresenceUpdate, metrics);
      state.duelEventRateLimits.delete(socket.id);
      state.presenceHelloRateLimits.delete(socket.id);
      state.presenceHeartbeatRateLimits.delete(socket.id);
      metrics.clearLatency(socket.id);
      metrics.log('debug', 'socket_disconnect', { socketId: socket.id, requestId: socket.data.requestId, hadSession });
    });
  });

  const heartbeatCheckInterval = devicesModule.startHeartbeatChecker(io, state, fullDeps);
  const chatPruneInterval = chatModule.startPruneInterval(db, metrics);

  return {
    activeSessions: state.activeSessions,
    raceRooms: state.raceRooms,
    presenceMap: state.presenceMap,
    presenceGraceTimers: state.presenceGraceTimers,
    chatRateLimits: state.chatRateLimits,
    deviceSockets: state.deviceSockets,
    duelManager,
    forceEndSession,
    clearInactivityTimeout,
    clearSessionDurationTimeout,
    broadcastCarsUpdate,
    broadcastPresenceUpdate,
    processHoldDeduct,
    heartbeatCheckInterval,
    chatPruneInterval,
  };
}

module.exports = { setupSocketIo };
