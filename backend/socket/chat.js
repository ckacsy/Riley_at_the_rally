'use strict';

const { hasRequiredRole } = require('../middleware/roles');
const { socketRateLimit } = require('./validators');

const CHAT_HISTORY_LIMIT = parseInt(process.env.CHAT_HISTORY_LIMIT, 10) || 500;
const CHAT_PRUNE_INTERVAL_MS = 60_000;
const CHAT_COOLDOWN_MS = 700;
const CHAT_BURST_MAX = 5;
const CHAT_MSG_MAX_LEN = 300;

/**
 * Fetch chat history from the database.
 * @param {import('better-sqlite3').Database} db
 * @param {number} [limit]
 * @param {number} [offset]
 */
function getChatHistory(db, limit, offset) {
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

/**
 * Register chat event handlers on the given socket.
 *
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {object} state - shared state store
 * @param {object} deps
 */
function setup(io, socket, state, deps) {
  const { db, metrics } = deps;

  socket.on('chat:send', (data) => {
    const { message } = data || {};

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

    const now = Date.now();
    let rateState = state.chatRateLimits.get(authUserId) || { lastSent: 0, burst: 0 };
    const elapsed = now - rateState.lastSent;
    if (elapsed >= CHAT_COOLDOWN_MS) {
      rateState.burst = Math.max(0, rateState.burst - Math.floor(elapsed / CHAT_COOLDOWN_MS));
    }
    rateState.burst += 1;
    if (rateState.burst > CHAT_BURST_MAX) {
      socket.emit('chat:error', { code: 'rate_limited', message: 'Слишком быстро, подождите немного' });
      return;
    }
    rateState.lastSent = now;
    state.chatRateLimits.set(authUserId, rateState);

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

    const msg = {
      id: result.lastInsertRowid,
      userId: authUserId,
      username: authUsername,
      message: trimmed,
      createdAt: new Date().toISOString(),
      deleted: false,
    };

    io.emit('chat:message', msg);
    metrics.log('debug', 'chat_message', { userId: authUserId, username: authUsername, requestId: socket.data.requestId });
  });

  socket.on('chat:delete', (data) => {
    const { id } = data || {};
    if (!Number.isInteger(id) || id < 1) return;

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
    if (!hasRequiredRole(adminUser.role, ['admin', 'moderator'])) {
      socket.emit('chat:error', { code: 'forbidden', message: 'Недостаточно прав' });
      return;
    }

    if (!socketRateLimit(state.chatDeleteRateLimits, sess.userId, 10, 10_000)) {
      socket.emit('chat:error', { code: 'rate_limited', message: 'Слишком много удалений, подождите немного' });
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
}

/**
 * Start the periodic chat message pruning interval.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} metrics
 * @returns {NodeJS.Timeout}
 */
function startPruneInterval(db, metrics) {
  return setInterval(() => {
    try {
      db.prepare(
        'DELETE FROM chat_messages WHERE id NOT IN (SELECT id FROM chat_messages ORDER BY id DESC LIMIT ?)'
      ).run(CHAT_HISTORY_LIMIT);
    } catch (e) {
      metrics.log('error', 'chat_prune_error', { error: e.message });
    }
  }, CHAT_PRUNE_INTERVAL_MS);
}

module.exports = { setup, getChatHistory, startPruneInterval };
