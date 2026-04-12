'use strict';

/**
 * Socket security helpers for backend/socket/index.js
 *
 * Provides reusable auth, status, and rate-limiting primitives so every
 * socket event handler can enforce consistent security checks.
 */

/**
 * Returns the numeric userId from the server-side HTTP session, or null if
 * the socket has no authenticated session.
 *
 * @param {import('socket.io').Socket} socket
 * @returns {number|null}
 */
function requireAuth(socket) {
  const sess = socket.request && socket.request.session;
  return (sess && sess.userId) ? sess.userId : null;
}

/**
 * Looks up the user record in the database and verifies status === 'active'.
 * Returns the user row (id, username, status, role) or null if not found /
 * not active / not authenticated.
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('better-sqlite3').Database} db
 * @returns {{ id: number, username: string, status: string, role: string }|null}
 */
function requireActiveUser(socket, db) {
  const userId = requireAuth(socket);
  if (!userId) return null;
  const user = db.prepare('SELECT id, username, status, role FROM users WHERE id = ?').get(userId);
  if (!user || user.status !== 'active') return null;
  return user;
}

/**
 * Verifies that the socket currently owns the active rental session AND that
 * the session's `dbUserId` matches the authenticated session userId (prevents
 * session hijacking via guessed/leaked socket.id).
 *
 * Returns the session object on success, or null on failure.
 *
 * @param {import('socket.io').Socket} socket
 * @param {Map<string, object>} activeSessions
 * @returns {object|null}
 */
function requireSessionOwner(socket, activeSessions) {
  const userId = requireAuth(socket);
  if (!userId) return null;
  const session = activeSessions.get(socket.id);
  if (!session) return null;
  if (session.dbUserId !== userId) return null;
  return session;
}

/**
 * Generic sliding-window per-key rate limiter backed by an external Map.
 * Returns true when the call is within the allowed rate, false when throttled.
 *
 * The caller owns the `limitMap` and is responsible for cleaning it up on
 * socket disconnect (for socket-keyed maps) or periodically (for user-keyed maps).
 *
 * @param {Map<string|number, {count: number, windowStart: number}>} limitMap
 * @param {string|number} key    - typically socket.id or userId
 * @param {number}        max    - maximum calls allowed within windowMs
 * @param {number}        windowMs - sliding window duration in milliseconds
 * @returns {boolean}
 */
function socketRateLimit(limitMap, key, max, windowMs) {
  const now = Date.now();
  let entry = limitMap.get(key) || { count: 0, windowStart: now };
  if (now - entry.windowStart >= windowMs) {
    entry = { count: 0, windowStart: now };
  }
  entry.count += 1;
  limitMap.set(key, entry);
  return entry.count <= max;
}

/**
 * Validate an event payload object against a simple schema.
 *
 * Schema shape:
 * ```
 * {
 *   fieldName: {
 *     type: 'string' | 'number' | 'boolean',
 *     required?: boolean,
 *     enum?: any[],
 *     min?: number,       // for type 'number'
 *     max?: number,       // for type 'number'
 *     integer?: boolean,  // for type 'number'
 *     minLen?: number,    // for type 'string'
 *     maxLen?: number,    // for type 'string'
 *   }
 * }
 * ```
 * Returns null if valid, or a human-readable error string on the first failure.
 *
 * @param {object|null|undefined} data
 * @param {object} schema
 * @returns {string|null}
 */
function validatePayload(data, schema) {
  const obj = (data !== null && data !== undefined && typeof data === 'object') ? data : {};
  for (const [field, rules] of Object.entries(schema)) {
    const val = obj[field];
    if (val === undefined || val === null) {
      if (rules.required) return `Поле ${field} обязательно`;
      continue;
    }
    if (rules.type && typeof val !== rules.type) {
      return `Поле ${field} должно быть типа ${rules.type}`;
    }
    if (rules.enum && !rules.enum.includes(val)) {
      return `Недопустимое значение поля ${field}`;
    }
    if (rules.type === 'number') {
      if (!Number.isFinite(val)) return `Поле ${field} должно быть конечным числом`;
      if (rules.integer && !Number.isInteger(val)) return `Поле ${field} должно быть целым числом`;
      if (rules.min !== undefined && val < rules.min) return `Поле ${field}: минимум ${rules.min}`;
      if (rules.max !== undefined && val > rules.max) return `Поле ${field}: максимум ${rules.max}`;
    }
    if (rules.type === 'string') {
      if (rules.minLen !== undefined && val.length < rules.minLen) return `Поле ${field}: минимум ${rules.minLen} символов`;
      if (rules.maxLen !== undefined && val.length > rules.maxLen) return `Поле ${field}: максимум ${rules.maxLen} символов`;
    }
  }
  return null;
}

module.exports = {
  requireAuth,
  requireActiveUser,
  requireSessionOwner,
  socketRateLimit,
  validatePayload,
};
