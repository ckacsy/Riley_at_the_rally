'use strict';

const rateLimit = require('express-rate-limit');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_PRESETS = ['7d', '30d', '90d', 'all'];

/**
 * Mount admin analytics routes.
 *
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   requireRole: (...roles: string[]) => Function,
 * }} deps
 */
module.exports = function mountAdminAnalyticsRoutes(app, db, deps) {
  const { requireRole } = deps;

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
  // Period parsing helper
  // Returns { from, to, error } where from/to are 'YYYY-MM-DD' strings.
  // ---------------------------------------------------------------------------
  function parsePeriod(query) {
    const { period, date_from, date_to } = query;

    // Custom date range takes precedence
    if (date_from !== undefined || date_to !== undefined) {
      if (!date_from || !DATE_RE.test(date_from)) {
        return { error: 'Invalid date_from format (use YYYY-MM-DD)' };
      }
      if (!date_to || !DATE_RE.test(date_to)) {
        return { error: 'Invalid date_to format (use YYYY-MM-DD)' };
      }
      return { from: date_from, to: date_to, error: null };
    }

    // Preset
    const preset = period || '30d';
    if (!VALID_PRESETS.includes(preset)) {
      return { error: `Invalid period. Use one of: ${VALID_PRESETS.join(', ')} or custom date_from/date_to` };
    }

    const now = new Date();
    const toStr = now.toISOString().slice(0, 10);

    if (preset === 'all') {
      return { from: '2000-01-01', to: toStr, error: null };
    }

    const days = parseInt(preset, 10); // 7, 30, or 90
    const fromDate = new Date(now);
    fromDate.setDate(fromDate.getDate() - days);
    const fromStr = fromDate.toISOString().slice(0, 10);

    return { from: fromStr, to: toStr, error: null };
  }

  // ---------------------------------------------------------------------------
  // Build SQL date conditions for a given period.
  // from = inclusive start of day, to = exclusive next day boundary.
  // ---------------------------------------------------------------------------
  function periodToSqlConditions(from, to, tableAlias) {
    const col = tableAlias ? `${tableAlias}.created_at` : 'created_at';
    const toNextDay = new Date(to);
    toNextDay.setDate(toNextDay.getDate() + 1);
    const toNextDayStr = toNextDay.toISOString().slice(0, 10);
    return {
      conditions: [`${col} >= ?`, `${col} < ?`],
      params: [`${from} 00:00:00`, `${toNextDayStr} 00:00:00`],
    };
  }

  // ---------------------------------------------------------------------------
  // GET /api/admin/analytics/overview
  // Core KPI cards and breakdowns.
  // Admin only.
  // ---------------------------------------------------------------------------
  app.get(
    '/api/admin/analytics/overview',
    adminReadLimiter,
    requireRole('admin'),
    (req, res) => {
      const periodResult = parsePeriod(req.query);
      if (periodResult.error) {
        return res.status(400).json({ error: periodResult.error });
      }
      const { from, to } = periodResult;

      const { conditions, params } = periodToSqlConditions(from, to, 's');

      const whereClause = 'WHERE ' + conditions.join(' AND ');

      // --- KPI: total users (all-time, not period-filtered) ---
      const usersRow = db.prepare('SELECT COUNT(*) AS totalUsers FROM users').get();
      const totalUsers = usersRow ? usersRow.totalUsers : 0;

      // --- KPI: sessions in period ---
      const sessionKpiRow = db.prepare(
        `SELECT
           COUNT(*) AS totalSessions,
           COALESCE(SUM(COALESCE(s.cost, 0)), 0) AS totalRevenue,
           COALESCE(AVG(COALESCE(s.duration_seconds, 0)), 0) AS avgSessionDuration,
           COALESCE(AVG(COALESCE(s.cost, 0)), 0) AS avgSessionCost
         FROM rental_sessions s
         ${whereClause}`
      ).get(...params);

      // --- Breakdown: transactions by type (in period, using t.created_at) ---
      const { conditions: tConds, params: tParams } = periodToSqlConditions(from, to, 't');
      const tWhereClause = 'WHERE ' + tConds.join(' AND ');

      const byTypeRows = db.prepare(
        `SELECT t.type, COUNT(*) AS count, COALESCE(SUM(t.amount), 0) AS total
         FROM transactions t
         ${tWhereClause}
         GROUP BY t.type
         ORDER BY count DESC`
      ).all(...tParams);

      // --- Breakdown: sessions by car (in period) ---
      const byCarRows = db.prepare(
        `SELECT
           s.car_id,
           COUNT(*) AS sessionCount,
           COALESCE(SUM(COALESCE(s.cost, 0)), 0) AS totalRevenue
         FROM rental_sessions s
         ${whereClause}
         GROUP BY s.car_id
         ORDER BY sessionCount DESC`
      ).all(...params);

      // Enrich with car names from app.locals
      const cars = app.locals.getCars ? app.locals.getCars() : [];
      const byCarId = byCarRows.map((row) => {
        const car = cars.find((c) => c.id === row.car_id);
        return {
          car_id: row.car_id,
          car_name: car ? car.name : `Unknown car`,
          sessionCount: row.sessionCount,
          totalRevenue: Math.round(row.totalRevenue * 100) / 100,
        };
      });

      // --- Breakdown: top users by spend (in period), capped to 10 ---
      const { conditions: uConds, params: uParams } = periodToSqlConditions(from, to, 's');
      const uWhereClause = 'WHERE ' + uConds.join(' AND ');

      const topUsersRows = db.prepare(
        `SELECT
           s.user_id,
           u.username,
           COALESCE(SUM(COALESCE(s.cost, 0)), 0) AS totalSpend,
           COUNT(*) AS sessionCount
         FROM rental_sessions s
         LEFT JOIN users u ON u.id = s.user_id
         ${uWhereClause}
         GROUP BY s.user_id
         ORDER BY totalSpend DESC
         LIMIT 10`
      ).all(...uParams);

      const topUsersBySpend = topUsersRows.map((row) => ({
        user_id: row.user_id,
        username: row.username || `user_${row.user_id}`,
        totalSpend: Math.round(row.totalSpend * 100) / 100,
        sessionCount: row.sessionCount,
      }));

      res.json({
        period: { from, to },
        kpi: {
          totalUsers,
          totalSessions: sessionKpiRow ? sessionKpiRow.totalSessions : 0,
          totalRevenue: sessionKpiRow ? Math.round(sessionKpiRow.totalRevenue * 100) / 100 : 0,
          avgSessionDuration: sessionKpiRow ? Math.round(sessionKpiRow.avgSessionDuration) : 0,
          avgSessionCost: sessionKpiRow ? Math.round(sessionKpiRow.avgSessionCost * 100) / 100 : 0,
        },
        byTransactionType: byTypeRows.map((r) => ({
          type: r.type,
          count: r.count,
          total: Math.round(r.total * 100) / 100,
        })),
        byCarId,
        topUsersBySpend,
      });
    }
  );

  // ---------------------------------------------------------------------------
  // GET /api/admin/analytics/timeseries
  // Daily grouped data for sessions, revenue, and topups.
  // Admin only.
  // ---------------------------------------------------------------------------
  app.get(
    '/api/admin/analytics/timeseries',
    adminReadLimiter,
    requireRole('admin'),
    (req, res) => {
      const periodResult = parsePeriod(req.query);
      if (periodResult.error) {
        return res.status(400).json({ error: periodResult.error });
      }
      const { from, to } = periodResult;

      const { conditions: sConds, params: sParams } = periodToSqlConditions(from, to, 's');
      const sWhereClause = 'WHERE ' + sConds.join(' AND ');

      // Daily sessions + revenue
      const sessionDays = db.prepare(
        `SELECT
           DATE(s.created_at) AS date,
           COUNT(*) AS sessions,
           COALESCE(SUM(COALESCE(s.cost, 0)), 0) AS revenue
         FROM rental_sessions s
         ${sWhereClause}
         GROUP BY DATE(s.created_at)
         ORDER BY date ASC`
      ).all(...sParams);

      // Daily topups
      const { conditions: tConds, params: tParams } = periodToSqlConditions(from, to, 't');
      const tWhereClause = `WHERE ${tConds.join(' AND ')} AND t.type = 'topup'`;
      const topupDays = db.prepare(
        `SELECT
           DATE(t.created_at) AS date,
           COALESCE(SUM(t.amount), 0) AS topups
         FROM transactions t
         ${tWhereClause}
         GROUP BY DATE(t.created_at)
         ORDER BY date ASC`
      ).all(...tParams);

      // Merge into a single map keyed by date
      const dayMap = new Map();

      for (const row of sessionDays) {
        dayMap.set(row.date, {
          date: row.date,
          sessions: row.sessions,
          revenue: Math.round(row.revenue * 100) / 100,
          topups: 0,
        });
      }

      for (const row of topupDays) {
        if (dayMap.has(row.date)) {
          dayMap.get(row.date).topups = Math.round(row.topups * 100) / 100;
        } else {
          dayMap.set(row.date, {
            date: row.date,
            sessions: 0,
            revenue: 0,
            topups: Math.round(row.topups * 100) / 100,
          });
        }
      }

      // Sort by date ascending
      const days = Array.from(dayMap.values()).sort((a, b) =>
        a.date < b.date ? -1 : a.date > b.date ? 1 : 0
      );

      res.json({
        period: { from, to },
        days,
      });
    }
  );
};
