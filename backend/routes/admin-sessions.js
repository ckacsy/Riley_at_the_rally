'use strict';

const rateLimit = require('express-rate-limit');

/**
 * Mount admin rental-sessions routes.
 *
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   requireRole: (...roles: string[]) => Function,
 *   csrfMiddleware: Function,
 *   logAdminAudit: Function,
 * }} deps
 */
module.exports = function mountAdminSessionRoutes(app, db, deps) {
  const { requireRole, csrfMiddleware, logAdminAudit } = deps;

  const adminReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много запросов. Попробуйте позже.' },
    keyGenerator: (req) => req.ip,
    skip: () => process.env.NODE_ENV === 'test',
  });

  const adminMutationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много запросов. Попробуйте позже.' },
    keyGenerator: (req) => req.ip,
    skip: () => process.env.NODE_ENV === 'test',
  });

  const VALID_FORCE_END_REASONS = ['stuck_session', 'car_offline', 'operator_intervention'];

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  // -------------------------------------------------------------------------
  // GET /api/admin/sessions
  // Paginated completed rental sessions joined with user info.
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/sessions',
    adminReadLimiter,
    requireRole('moderator', 'admin'),
    (req, res) => {
      // --- Pagination ---
      let page = 1;
      let limit = 50;

      if (req.query.page !== undefined) {
        const p = parseInt(req.query.page, 10);
        if (!Number.isInteger(p) || p < 1) {
          return res.status(400).json({ error: 'Invalid page parameter' });
        }
        page = p;
      }

      if (req.query.limit !== undefined) {
        const l = parseInt(req.query.limit, 10);
        if (!Number.isInteger(l) || l < 1 || l > 100) {
          return res.status(400).json({ error: 'Invalid limit parameter (1–100)' });
        }
        limit = l;
      }

      // --- Filters ---
      const conditions = [];
      const params = [];

      if (req.query.user_id !== undefined) {
        const uid = parseInt(req.query.user_id, 10);
        if (!Number.isInteger(uid) || uid < 1) {
          return res.status(400).json({ error: 'Invalid user_id parameter' });
        }
        conditions.push('s.user_id = ?');
        params.push(uid);
      }

      if (req.query.car_id !== undefined) {
        const cid = parseInt(req.query.car_id, 10);
        if (!Number.isInteger(cid) || cid < 1) {
          return res.status(400).json({ error: 'Invalid car_id parameter' });
        }
        conditions.push('s.car_id = ?');
        params.push(cid);
      }

      if (req.query.date_from !== undefined) {
        if (!DATE_RE.test(req.query.date_from)) {
          return res.status(400).json({ error: 'Invalid date_from format (use YYYY-MM-DD)' });
        }
        conditions.push("s.created_at >= ?");
        params.push(req.query.date_from + ' 00:00:00');
      }

      if (req.query.date_to !== undefined) {
        if (!DATE_RE.test(req.query.date_to)) {
          return res.status(400).json({ error: 'Invalid date_to format (use YYYY-MM-DD)' });
        }
        const nextDay = new Date(req.query.date_to);
        nextDay.setDate(nextDay.getDate() + 1);
        const nextDayStr = nextDay.toISOString().slice(0, 10);
        conditions.push("s.created_at < ?");
        params.push(nextDayStr + ' 00:00:00');
      }

      if (req.query.min_cost !== undefined) {
        const v = parseFloat(req.query.min_cost);
        if (!Number.isFinite(v)) {
          return res.status(400).json({ error: 'Invalid min_cost parameter' });
        }
        conditions.push('s.cost >= ?');
        params.push(v);
      }

      if (req.query.max_cost !== undefined) {
        const v = parseFloat(req.query.max_cost);
        if (!Number.isFinite(v)) {
          return res.status(400).json({ error: 'Invalid max_cost parameter' });
        }
        conditions.push('s.cost <= ?');
        params.push(v);
      }

      if (req.query.min_duration !== undefined) {
        const v = parseInt(req.query.min_duration, 10);
        if (!Number.isInteger(v) || v < 0) {
          return res.status(400).json({ error: 'Invalid min_duration parameter' });
        }
        conditions.push('s.duration_seconds >= ?');
        params.push(v);
      }

      if (req.query.max_duration !== undefined) {
        const v = parseInt(req.query.max_duration, 10);
        if (!Number.isInteger(v) || v < 0) {
          return res.status(400).json({ error: 'Invalid max_duration parameter' });
        }
        conditions.push('s.duration_seconds <= ?');
        params.push(v);
      }

      const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

      // --- Summary (all matching rows, not paginated) ---
      const summaryRow = db.prepare(
        `SELECT
           COUNT(*) AS totalSessions,
           COALESCE(SUM(s.cost), 0) AS totalRevenue,
           COALESCE(AVG(s.duration_seconds), 0) AS avgDurationSeconds,
           COALESCE(AVG(s.cost), 0) AS avgCost
         FROM rental_sessions s
         ${whereClause}`
      ).get(...params);

      // --- Count ---
      const countRow = db.prepare(
        `SELECT COUNT(*) AS total FROM rental_sessions s ${whereClause}`
      ).get(...params);
      const total = countRow ? countRow.total : 0;
      const pages = Math.ceil(total / limit) || 1;

      // --- Data ---
      const offset = (page - 1) * limit;
      const dataParams = [...params, limit, offset];

      const items = db.prepare(
        `SELECT
           s.id,
           s.user_id,
           u.username,
           s.car_id,
           s.car_name,
           s.duration_seconds,
           s.cost,
           s.created_at
         FROM rental_sessions s
         LEFT JOIN users u ON u.id = s.user_id
         ${whereClause}
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT ? OFFSET ?`
      ).all(...dataParams);

      res.json({
        items,
        pagination: { page, limit, total, pages },
        summary: {
          totalSessions: summaryRow ? summaryRow.totalSessions : 0,
          totalRevenue: summaryRow ? Math.round(summaryRow.totalRevenue * 100) / 100 : 0,
          avgDurationSeconds: summaryRow ? Math.round(summaryRow.avgDurationSeconds) : 0,
          avgCost: summaryRow ? Math.round(summaryRow.avgCost * 100) / 100 : 0,
        },
      });
    }
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/sessions/active
  // Current in-memory active sessions.
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/sessions/active',
    adminReadLimiter,
    requireRole('moderator', 'admin'),
    (req, res) => {
      const activeSessions = app.locals.getActiveSessions?.() || new Map();
      const cars = app.locals.getCars?.() || [];
      const ratePerMinute = app.locals.getRatePerMinute?.() || 0;

      const now = Date.now();
      const items = [];

      for (const [, session] of activeSessions) {
        const startMs = session.startTime instanceof Date
          ? session.startTime.getTime()
          : new Date(session.startTime).getTime();
        const elapsedMs = now - startMs;
        const durationSeconds = Math.floor(elapsedMs / 1000);
        const durationMinutes = elapsedMs / 60000;
        const currentCostEstimate = Math.round(durationMinutes * ratePerMinute * 100) / 100;

        const car = cars.find((c) => c.id === session.carId);
        const carName = car ? car.name : (session.carId ? ('Машина #' + session.carId) : '—');

        items.push({
          carId: session.carId,
          carName,
          userId: session.dbUserId || null,
          username: session.userId || null,
          startTime: session.startTime instanceof Date
            ? session.startTime.toISOString()
            : session.startTime,
          durationSeconds,
          holdAmount: session.holdAmount || 0,
          currentCostEstimate,
        });
      }

      res.json({ items, count: items.length });
    }
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/sessions/:id
  // Details for one completed rental session.
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/sessions/:id',
    adminReadLimiter,
    requireRole('moderator', 'admin'),
    (req, res) => {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: 'Invalid session id' });
      }

      const session = db.prepare(
        `SELECT
           s.id,
           s.user_id,
           u.username,
           s.car_id,
           s.car_name,
           s.duration_seconds,
           s.cost,
           s.created_at
         FROM rental_sessions s
         LEFT JOIN users u ON u.id = s.user_id
         WHERE s.id = ?`
      ).get(id);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Related transactions: heuristic based on session lifecycle
      let transactions = [];
      if (session.user_id) {
        const windowStart = new Date(session.created_at);
        // Subtract (duration_seconds + 30) seconds from created_at to get approximate hold time
        windowStart.setSeconds(windowStart.getSeconds() - ((session.duration_seconds || 0) + 30));

        const windowEnd = new Date(session.created_at);
        windowEnd.setSeconds(windowEnd.getSeconds() + 30);

        transactions = db.prepare(
          `SELECT id, type, amount, balance_after, description, created_at
           FROM transactions
           WHERE user_id = ?
             AND type IN ('hold', 'deduct', 'release')
             AND created_at >= ?
             AND created_at <= ?
           ORDER BY created_at ASC`
        ).all(
          session.user_id,
          windowStart.toISOString().slice(0, 19).replace('T', ' '),
          windowEnd.toISOString().slice(0, 19).replace('T', ' ')
        );
      }

      res.json({ session, transactions });
    }
  );
  // -------------------------------------------------------------------------
  // POST /api/admin/sessions/active/:carId/force-end
  // Admin-only: force-end an active rental session by carId.
  // -------------------------------------------------------------------------
  app.post(
    '/api/admin/sessions/active/:carId/force-end',
    adminMutationLimiter,
    csrfMiddleware,
    requireRole('admin'),
    (req, res) => {
      const carId = parseInt(req.params.carId, 10);
      if (!Number.isInteger(carId) || carId < 1) {
        return res.status(400).json({ error: 'Invalid carId' });
      }

      const { reason, note } = req.body || {};

      if (!reason || typeof reason !== 'string') {
        return res.status(400).json({ error: 'reason is required' });
      }
      if (!VALID_FORCE_END_REASONS.includes(reason)) {
        return res.status(400).json({
          error: 'Invalid reason. Must be one of: ' + VALID_FORCE_END_REASONS.join(', '),
        });
      }

      const trimmedNote = note && typeof note === 'string' ? note.trim() : null;

      const admin = req.user;
      const adminContext = { adminId: admin.id, adminUsername: admin.username };

      const forceEndSession = app.locals.forceEndSession;
      if (typeof forceEndSession !== 'function') {
        return res.status(503).json({ error: 'Service unavailable' });
      }

      const result = forceEndSession(carId, adminContext);

      logAdminAudit({
        adminId: admin.id,
        action: 'force_end_session',
        targetType: 'car',
        targetId: carId,
        details: {
          ended: result.ended,
          reason,
          note: trimmedNote || null,
          carId,
          carName: result.session ? result.session.carName : null,
          affectedUserId: result.session ? result.session.userId : null,
          affectedUsername: result.session ? result.session.username : null,
          durationSeconds: result.session ? result.session.durationSeconds : null,
          cost: result.session ? result.session.cost : null,
        },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] || null,
      });

      if (!result.ended) {
        return res.json({ ended: false, message: 'No active session' });
      }

      return res.json({
        ended: true,
        message: 'Session force-ended',
        session: result.session,
      });
    }
  );
};
