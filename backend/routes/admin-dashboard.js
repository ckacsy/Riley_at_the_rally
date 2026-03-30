'use strict';

const rateLimit = require('express-rate-limit');

/**
 * Grace period (minutes) for orphaned hold detection.
 * Must stay in sync with the value used in admin-transactions.js.
 */
const ORPHAN_GRACE_MINUTES = 10;

/**
 * High-impact audit actions shown on the dashboard.
 * Low-signal actions (e.g. news edits) are excluded.
 */
const HIGH_IMPACT_ACTIONS = [
  'ban_user',
  'delete_user',
  'force_end_session',
  'maintenance_enabled',
  'maintenance_disabled',
  'balance_adjust',
  'orphaned_hold_release',
  'role_change',
];

/**
 * Mount admin dashboard route.
 *
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   requireRole: (...roles: string[]) => Function,
 *   getActiveSessions: () => Map,
 *   CARS: Array<{ id: number, name: string }>,
 * }} deps
 */
module.exports = function mountAdminDashboardRoutes(app, db, deps) {
  const { requireRole, getActiveSessions, CARS } = deps;

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
  // GET /api/admin/dashboard
  // Unified operational dashboard summary.
  // Moderators see only activeSessions.
  // Admins see activeSessions + orphanedHolds + maintenanceCars + bannedUsers + recentAuditActions.
  // ---------------------------------------------------------------------------
  app.get(
    '/api/admin/dashboard',
    adminReadLimiter,
    requireRole('moderator', 'admin'),
    (req, res) => {
      const isAdmin = req.user && req.user.role === 'admin';

      // -----------------------------------------------------------------------
      // A. Active sessions (in-memory)
      // -----------------------------------------------------------------------
      const activeSessions = typeof getActiveSessions === 'function' ? getActiveSessions() : new Map();
      const sessionItems = [];
      for (const [, session] of activeSessions) {
        if (sessionItems.length >= 5) break;
        const carInfo = CARS.find((c) => c.id === session.carId);
        sessionItems.push({
          carId: session.carId,
          carName: carInfo ? carInfo.name : ('Машина #' + session.carId),
          username: session.userId || null,
          startedAt: session.startTime instanceof Date
            ? session.startTime.toISOString()
            : (session.startTime ? new Date(session.startTime).toISOString() : null),
        });
      }

      const payload = {
        activeSessions: {
          count: activeSessions.size,
          items: sessionItems,
        },
      };

      if (!isAdmin) {
        return res.json(payload);
      }

      // -----------------------------------------------------------------------
      // B. Orphaned holds (count only)
      // Reuses the same SQL logic as admin-transactions.js.
      // -----------------------------------------------------------------------
      const orphanRows = db.prepare(
        `SELECT t.id, t.reference_id
           FROM transactions t
          WHERE t.type = 'hold'
            AND t.reference_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM transactions t2
               WHERE t2.reference_id = t.reference_id
                 AND t2.type IN ('deduct', 'release')
            )
            AND t.created_at < datetime('now', '-${ORPHAN_GRACE_MINUTES} minutes')`
      ).all();

      // Exclude currently active session refs
      let activeSessionRefs = new Set();
      for (const [, session] of activeSessions) {
        if (session.sessionRef) activeSessionRefs.add(session.sessionRef);
      }
      const orphanCount = orphanRows.filter((r) => !activeSessionRefs.has(r.reference_id)).length;

      // -----------------------------------------------------------------------
      // C. Maintenance cars (count + up to 5 preview items)
      // -----------------------------------------------------------------------
      const maintRows = db.prepare(
        `SELECT cm.car_id, cm.reason
           FROM car_maintenance cm
          WHERE cm.enabled = 1
          LIMIT 5`
      ).all();

      const maintCount = db.prepare(
        `SELECT COUNT(*) AS cnt FROM car_maintenance WHERE enabled = 1`
      ).get().cnt;

      const maintItems = maintRows.map((r) => {
        const carInfo = CARS.find((c) => c.id === r.car_id);
        return {
          carId: r.car_id,
          carName: carInfo ? carInfo.name : ('Машина #' + r.car_id),
          reason: r.reason || null,
        };
      });

      // -----------------------------------------------------------------------
      // D. Banned users (count only)
      // -----------------------------------------------------------------------
      const bannedCount = db.prepare(
        `SELECT COUNT(*) AS cnt FROM users WHERE status = 'banned'`
      ).get().cnt;

      // -----------------------------------------------------------------------
      // E. Recent high-impact audit actions (latest 5)
      // -----------------------------------------------------------------------
      const placeholders = HIGH_IMPACT_ACTIONS.map(() => '?').join(', ');
      const auditRows = db.prepare(
        `SELECT a.action, ua.username AS admin_username, ut.username AS target_username, a.created_at
           FROM admin_audit_log a
           LEFT JOIN users ua ON ua.id = a.admin_id
           LEFT JOIN users ut ON ut.id = a.target_id AND a.target_type = 'user'
          WHERE a.action IN (${placeholders})
          ORDER BY a.created_at DESC
          LIMIT 5`
      ).all(...HIGH_IMPACT_ACTIONS);

      const recentAuditActions = auditRows.map((r) => ({
        action: r.action,
        admin_username: r.admin_username || null,
        target_username: r.target_username || null,
        created_at: r.created_at,
      }));

      Object.assign(payload, {
        orphanedHolds: { count: orphanCount },
        maintenanceCars: { count: maintCount, items: maintItems },
        bannedUsers: { count: bannedCount },
        recentAuditActions,
      });

      return res.json(payload);
    }
  );
};
