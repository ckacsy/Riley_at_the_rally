'use strict';

const { socketRateLimit } = require('./validators');

const PRESENCE_GRACE_MS = (() => {
  const v = parseInt(process.env.PRESENCE_GRACE_MS || '', 10);
  return (!isNaN(v) && v >= 0) ? v : 10_000;
})();
const PRESENCE_STALE_MS = 60_000;
const ALLOWED_PRESENCE_PAGES = new Set(['control', 'broadcast', 'garage', 'profile', 'index']);

/**
 * Returns a broadcastPresenceUpdate function bound to io and state.
 *
 * @param {import('socket.io').Server} io
 * @param {object} state - shared state store
 * @returns {Function}
 */
function createBroadcastPresenceUpdate(io, state) {
  return function broadcastPresenceUpdate() {
    const drivers = [...state.presenceMap.values()].map((e) => ({
      userId: e.userId,
      username: e.username,
      status: e.status,
      connectedAt: e.connectedAt,
      lastSeen: e.lastSeen,
      carId: e.carId || null,
    }));
    io.emit('presence:update', { drivers });
  };
}

/**
 * Schedule grace-period removal of a user from the presence map.
 *
 * @param {number} userId
 * @param {object} state
 * @param {Function} broadcastPresenceUpdate
 * @param {object} metrics
 */
function schedulePresenceRemoval(userId, state, broadcastPresenceUpdate, metrics) {
  if (state.presenceGraceTimers.has(userId)) {
    clearTimeout(state.presenceGraceTimers.get(userId));
  }
  const timer = setTimeout(() => {
    state.presenceMap.delete(userId);
    state.presenceGraceTimers.delete(userId);
    broadcastPresenceUpdate();
    metrics.log('debug', 'presence_removed', { userId });
  }, PRESENCE_GRACE_MS);
  state.presenceGraceTimers.set(userId, timer);
}

/**
 * Start the periodic stale-entry cleanup interval.
 *
 * @param {object} state
 * @param {Function} broadcastPresenceUpdate
 * @param {object} metrics
 */
function startStaleCleanup(state, broadcastPresenceUpdate, metrics) {
  setInterval(() => {
    const cutoff = Date.now() - PRESENCE_STALE_MS;
    let changed = false;
    for (const [userId, entry] of state.presenceMap.entries()) {
      if (entry.lastSeen < cutoff) {
        state.presenceMap.delete(userId);
        if (state.presenceGraceTimers.has(userId)) {
          clearTimeout(state.presenceGraceTimers.get(userId));
          state.presenceGraceTimers.delete(userId);
        }
        changed = true;
        metrics.log('debug', 'presence_stale_removed', { userId });
      }
    }
    if (changed) broadcastPresenceUpdate();
  }, PRESENCE_STALE_MS);
}

/**
 * Register presence event handlers on the given socket.
 *
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {object} state
 * @param {object} deps
 * @param {Function} broadcastPresenceUpdate
 */
function setup(io, socket, state, deps, broadcastPresenceUpdate) {
  const { db, metrics } = deps;

  socket.on('presence:hello', (data) => {
    const { page } = data || {};

    if (!socketRateLimit(state.presenceHelloRateLimits, socket.id, 5, 60_000)) {
      return;
    }

    if (page !== undefined && (typeof page !== 'string' || !ALLOWED_PRESENCE_PAGES.has(page))) {
      return;
    }

    if (page !== 'control') {
      socket.emit('presence:update', {
        drivers: [...state.presenceMap.values()].map((e) => ({
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

    const sess = socket.request.session;
    const userId = sess && sess.userId;
    if (!userId) return;

    const user = db.prepare('SELECT username, status FROM users WHERE id = ?').get(userId);
    if (!user || user.status !== 'active') return;
    const username = user.username;

    if (state.presenceGraceTimers.has(userId)) {
      clearTimeout(state.presenceGraceTimers.get(userId));
      state.presenceGraceTimers.delete(userId);
    }

    const now = Date.now();
    const existing = state.presenceMap.get(userId);
    state.presenceMap.set(userId, {
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
    if (!socketRateLimit(state.presenceHeartbeatRateLimits, socket.id, 5, 30_000)) {
      return;
    }
    for (const entry of state.presenceMap.values()) {
      if (entry.socketId === socket.id) {
        entry.lastSeen = Date.now();
        break;
      }
    }
  });
}

/**
 * Handle socket disconnect for presence cleanup.
 *
 * @param {import('socket.io').Socket} socket
 * @param {object} state
 * @param {Function} broadcastPresenceUpdate
 * @param {object} metrics
 */
function handleDisconnect(socket, state, broadcastPresenceUpdate, metrics) {
  for (const [userId, entry] of state.presenceMap.entries()) {
    if (entry.socketId === socket.id) {
      schedulePresenceRemoval(userId, state, broadcastPresenceUpdate, metrics);
      break;
    }
  }
}

module.exports = {
  setup,
  createBroadcastPresenceUpdate,
  handleDisconnect,
  startStaleCleanup,
};
