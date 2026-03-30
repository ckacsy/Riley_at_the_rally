'use strict';

const rateLimit = require('express-rate-limit');

/**
 * Known transaction types — used for validation whitelist.
 */
const KNOWN_TYPES = ['hold', 'release', 'deduct', 'topup', 'admin_adjust'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ORPHAN_GRACE_MINUTES = 10;

/**
 * Mount admin transactions routes.
 *
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   requireRole: (...roles: string[]) => Function,
 *   getActiveSessions?: () => Map,
 * }} deps
 */
module.exports = function mountAdminTransactionRoutes(app, db, deps) {
  const { requireRole, getActiveSessions } = deps;

  const adminReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много запросов. Попробуйте позже.' },
    keyGenerator: (req) => req.ip,
    skip: () => process.env.NODE_ENV === 'test',
  });

  // ---------------------------------------------------------------------------
  // Shared pagination + filter parsing helpers
  // ---------------------------------------------------------------------------

  /**
   * Parse pagination params from req.query.
   * Returns { page, limit } or a 400 error message string.
   */
  function parsePagination(query) {
    let page = 1;
    let limit = 50;

    if (query.page !== undefined) {
      const p = parseInt(query.page, 10);
      if (!Number.isInteger(p) || p < 1) {
        return { error: 'Invalid page parameter' };
      }
      page = p;
    }

    if (query.limit !== undefined) {
      const l = parseInt(query.limit, 10);
      if (!Number.isInteger(l) || l < 1 || l > 100) {
        return { error: 'Invalid limit parameter (1–100)' };
      }
      limit = l;
    }

    return { page, limit };
  }

  /**
   * Build a WHERE clause + params array from common transaction filters.
   * `baseConditions` and `baseParams` allow callers to inject fixed conditions (e.g. user_id = ?).
   * Returns { conditions, params, error } — `error` is a non-null string on validation failure.
   */
  function buildTransactionFilters(query, baseConditions, baseParams) {
    const conditions = [...(baseConditions || [])];
    const params = [...(baseParams || [])];

    if (query.type !== undefined) {
      const type = query.type.trim();
      if (type !== '' && !KNOWN_TYPES.includes(type)) {
        return { conditions, params, error: 'Invalid type parameter' };
      }
      if (type !== '') {
        conditions.push('t.type = ?');
        params.push(type);
      }
    }

    if (query.date_from !== undefined) {
      if (!DATE_RE.test(query.date_from)) {
        return { conditions, params, error: 'Invalid date_from format (use YYYY-MM-DD)' };
      }
      conditions.push('t.created_at >= ?');
      params.push(query.date_from + ' 00:00:00');
    }

    if (query.date_to !== undefined) {
      if (!DATE_RE.test(query.date_to)) {
        return { conditions, params, error: 'Invalid date_to format (use YYYY-MM-DD)' };
      }
      const nextDay = new Date(query.date_to);
      nextDay.setDate(nextDay.getDate() + 1);
      const nextDayStr = nextDay.toISOString().slice(0, 10);
      conditions.push('t.created_at < ?');
      params.push(nextDayStr + ' 00:00:00');
    }

    return { conditions, params, error: null };
  }

  // -------------------------------------------------------------------------
  // GET /api/admin/transactions
  // Paginated transactions list with filters, joined usernames, and summary.
  // Admin only.
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/transactions',
    adminReadLimiter,
    requireRole('admin'),
    (req, res) => {
      // --- Pagination ---
      const pag = parsePagination(req.query);
      if (pag.error) return res.status(400).json({ error: pag.error });
      const { page, limit } = pag;

      // --- Filters ---
      let conditions = [];
      let params = [];

      if (req.query.user_id !== undefined) {
        const uid = parseInt(req.query.user_id, 10);
        if (!Number.isInteger(uid) || uid < 1) {
          return res.status(400).json({ error: 'Invalid user_id parameter' });
        }
        conditions.push('t.user_id = ?');
        params.push(uid);
      }

      const filterResult = buildTransactionFilters(req.query, conditions, params);
      if (filterResult.error) {
        return res.status(400).json({ error: filterResult.error, validTypes: KNOWN_TYPES });
      }
      conditions = filterResult.conditions;
      params = filterResult.params;

      if (req.query.reference_id !== undefined) {
        const ref = req.query.reference_id.trim();
        if (ref !== '') {
          conditions.push('t.reference_id = ?');
          params.push(ref);
        }
      }

      if (req.query.min_amount !== undefined) {
        const v = parseFloat(req.query.min_amount);
        if (!Number.isFinite(v)) {
          return res.status(400).json({ error: 'Invalid min_amount parameter' });
        }
        conditions.push('t.amount >= ?');
        params.push(v);
      }

      if (req.query.max_amount !== undefined) {
        const v = parseFloat(req.query.max_amount);
        if (!Number.isFinite(v)) {
          return res.status(400).json({ error: 'Invalid max_amount parameter' });
        }
        conditions.push('t.amount <= ?');
        params.push(v);
      }

      const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

      // --- Summary (across all matching rows, not just current page) ---
      const summaryRow = db.prepare(
        `SELECT
           COUNT(*) AS totalCount,
           COALESCE(SUM(t.amount), 0) AS totalAmount
         FROM transactions t
         ${whereClause}`
      ).get(...params);

      const byTypeRows = db.prepare(
        `SELECT t.type, COUNT(*) AS count, COALESCE(SUM(t.amount), 0) AS total
         FROM transactions t
         ${whereClause}
         GROUP BY t.type`
      ).all(...params);

      // --- Count for pagination ---
      const countRow = db.prepare(
        `SELECT COUNT(*) AS total FROM transactions t ${whereClause}`
      ).get(...params);
      const total = countRow ? countRow.total : 0;
      const pages = Math.ceil(total / limit) || 1;

      // --- Paginated data ---
      const offset = (page - 1) * limit;
      const dataParams = [...params, limit, offset];

      const items = db.prepare(
        `SELECT
           t.id,
           t.user_id,
           u.username,
           t.type,
           t.amount,
           t.balance_after,
           t.description,
           t.reference_id,
           t.admin_id,
           admin_u.username AS admin_username,
           t.created_at
         FROM transactions t
         LEFT JOIN users u ON u.id = t.user_id
         LEFT JOIN users admin_u ON admin_u.id = t.admin_id
         ${whereClause}
         ORDER BY t.created_at DESC, t.id DESC
         LIMIT ? OFFSET ?`
      ).all(...dataParams);

      res.json({
        items,
        pagination: { page, limit, total, pages },
        summary: {
          totalCount: summaryRow ? summaryRow.totalCount : 0,
          totalAmount: summaryRow ? Math.round(summaryRow.totalAmount * 100) / 100 : 0,
          byType: byTypeRows.map((r) => ({
            type: r.type,
            count: r.count,
            total: Math.round(r.total * 100) / 100,
          })),
        },
      });
    }
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/users/:id/ledger
  // Per-user financial ledger view.
  // Admin only.
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/users/:id/ledger',
    adminReadLimiter,
    requireRole('admin'),
    (req, res) => {
      const userId = parseInt(req.params.id, 10);
      if (!Number.isInteger(userId) || userId < 1) {
        return res.status(400).json({ error: 'Invalid user id' });
      }

      const user = db.prepare(
        'SELECT id, username, balance, status, created_at FROM users WHERE id = ?'
      ).get(userId);

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // --- Pagination ---
      const pag = parsePagination(req.query);
      if (pag.error) return res.status(400).json({ error: pag.error });
      const { page, limit } = pag;

      // --- Filters (fixed: user_id = userId) ---
      const filterResult = buildTransactionFilters(req.query, ['t.user_id = ?'], [userId]);
      if (filterResult.error) {
        return res.status(400).json({ error: filterResult.error, validTypes: KNOWN_TYPES });
      }
      const { conditions, params } = filterResult;
      const whereClause = 'WHERE ' + conditions.join(' AND ');

      // --- Per-user all-time financial summary (unfiltered by date/type) ---
      const summaryRow = db.prepare(
        `SELECT
           COUNT(*) AS transactionCount,
           COALESCE(SUM(CASE WHEN t.type = 'topup' THEN t.amount ELSE 0 END), 0) AS totalTopups,
           COALESCE(SUM(CASE WHEN t.type = 'hold' THEN t.amount ELSE 0 END), 0) AS totalHolds,
           COALESCE(SUM(CASE WHEN t.type = 'release' THEN t.amount ELSE 0 END), 0) AS totalReleases,
           COALESCE(SUM(CASE WHEN t.type = 'deduct' THEN t.amount ELSE 0 END), 0) AS totalDeductions,
           COALESCE(SUM(CASE WHEN t.type = 'admin_adjust' THEN t.amount ELSE 0 END), 0) AS totalAdminAdjusts
         FROM transactions t
         WHERE t.user_id = ?`
      ).get(userId);

      // --- Count (with filters applied) ---
      const countRow = db.prepare(
        `SELECT COUNT(*) AS total FROM transactions t ${whereClause}`
      ).get(...params);
      const total = countRow ? countRow.total : 0;
      const pages = Math.ceil(total / limit) || 1;

      // --- Paginated data (filtered) ---
      const offset = (page - 1) * limit;
      const dataParams = [...params, limit, offset];

      const transactions = db.prepare(
        `SELECT
           t.id,
           t.user_id,
           t.type,
           t.amount,
           t.balance_after,
           t.description,
           t.reference_id,
           t.admin_id,
           admin_u.username AS admin_username,
           t.created_at
         FROM transactions t
         LEFT JOIN users admin_u ON admin_u.id = t.admin_id
         ${whereClause}
         ORDER BY t.created_at DESC, t.id DESC
         LIMIT ? OFFSET ?`
      ).all(...dataParams);

      res.json({
        user: {
          id: user.id,
          username: user.username,
          balance: user.balance,
          status: user.status,
          created_at: user.created_at,
        },
        transactions,
        summary: {
          transactionCount: summaryRow ? summaryRow.transactionCount : 0,
          totalTopups: summaryRow ? Math.round(summaryRow.totalTopups * 100) / 100 : 0,
          totalHolds: summaryRow ? Math.round(summaryRow.totalHolds * 100) / 100 : 0,
          totalReleases: summaryRow ? Math.round(summaryRow.totalReleases * 100) / 100 : 0,
          totalDeductions: summaryRow ? Math.round(summaryRow.totalDeductions * 100) / 100 : 0,
          totalAdminAdjusts: summaryRow ? Math.round(summaryRow.totalAdminAdjusts * 100) / 100 : 0,
        },
        pagination: { page, limit, total, pages },
      });
    }
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/transactions/orphaned-holds
  // Read-only: find hold transactions with no corresponding deduct transaction
  // (sharing the same reference_id), older than the grace period.
  // Excludes holds with NULL reference_id (legacy data).
  // Excludes holds whose reference_id belongs to a currently active session.
  // Admin only.
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/transactions/orphaned-holds',
    adminReadLimiter,
    requireRole('admin'),
    (req, res) => {
      const rows = db.prepare(
        `SELECT t.id, t.user_id, u.username, t.amount, t.balance_after,
                t.description, t.reference_id, t.created_at
         FROM transactions t
         LEFT JOIN users u ON u.id = t.user_id
         WHERE t.type = 'hold'
           AND t.reference_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM transactions t2
             WHERE t2.reference_id = t.reference_id AND t2.type IN ('deduct', 'release')
           )
           AND t.created_at < datetime('now', '-${ORPHAN_GRACE_MINUTES} minutes')
         ORDER BY t.created_at DESC
         LIMIT 100`
      ).all();

      // Collect active session refs to exclude
      let activeSessionRefs = new Set();
      try {
        const activeSessions = typeof getActiveSessions === 'function' ? getActiveSessions() : null;
        if (activeSessions) {
          for (const session of activeSessions.values()) {
            if (session.sessionRef) activeSessionRefs.add(session.sessionRef);
          }
        }
      } catch (_) {
        // Skip exclusion gracefully if unavailable
      }

      const items = rows
        .filter((r) => !activeSessionRefs.has(r.reference_id))
        .map((r) => ({ ...r, status: 'orphaned' }));

      res.json({
        items,
        total: items.length,
        activeSessionRefs: activeSessionRefs.size,
      });
    }
  );
};
