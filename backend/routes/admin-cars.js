'use strict';

const { createRateLimiter } = require('../middleware/rateLimiter');

/**
 * Mount admin car-maintenance routes.
 *
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   requireRole: (...roles: string[]) => Function,
 *   csrfMiddleware: Function,
 *   logAdminAudit: Function,
 * }} deps
 * @param {{ CARS: Array }} extra
 */
module.exports = function mountAdminCarsRoutes(app, db, deps, extra) {
  const { requireRole, csrfMiddleware, logAdminAudit, getActiveSessions, broadcastCarsUpdate } = deps;
  const { CARS } = extra;

  const adminReadLimiter = createRateLimiter({ max: 60 });

  const adminWriteLimiter = createRateLimiter({ max: 20 });

  // -------------------------------------------------------------------------
  // GET /api/admin/cars
  // List all catalog cars enriched with maintenance state and resolved status.
  // Admin only.
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/cars',
    adminReadLimiter,
    requireRole('admin'),
    (req, res) => {
      const activeSessions = getActiveSessions ? getActiveSessions() : new Map();
      const activeCars = new Set([...activeSessions.values()].map((s) => s.carId));

      const maintMap = {};
      db.prepare('SELECT * FROM car_maintenance').all().forEach((r) => { maintMap[r.car_id] = r; });

      const cars = CARS.map((c) => {
        const maint = maintMap[c.id];
        const inMaintenance = !!(maint && maint.enabled === 1);
        const hasActiveSession = activeCars.has(c.id);

        let status;
        if (inMaintenance) {
          status = 'maintenance';
        } else if (hasActiveSession) {
          status = 'unavailable';
        } else {
          status = 'available';
        }

        return {
          id: c.id,
          name: c.name,
          model: c.model,
          cameraUrl: c.cameraUrl,
          status,
          maintenance: inMaintenance ? {
            enabled: true,
            reason: maint.reason || null,
            admin_id: maint.admin_id || null,
            created_at: maint.created_at,
          } : null,
          hasActiveSession,
        };
      });

      res.json({ cars });
    }
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/cars/:carId/maintenance
  // Enable or disable maintenance mode for a specific car.
  // Admin only.
  // -------------------------------------------------------------------------
  app.post(
    '/api/admin/cars/:carId/maintenance',
    adminWriteLimiter,
    requireRole('admin'),
    csrfMiddleware,
    (req, res) => {
      const actor = req.user;
      const carId = parseInt(req.params.carId, 10);

      if (!Number.isInteger(carId) || carId < 1) {
        return res.status(400).json({ error: 'Invalid carId' });
      }

      const car = CARS.find((c) => c.id === carId);
      if (!car) {
        return res.status(404).json({ error: 'Car not found' });
      }

      const { enabled, reason } = req.body || {};

      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: '`enabled` is required and must be a boolean' });
      }

      if (enabled) {
        const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
        if (!trimmedReason) {
          return res.status(400).json({ error: '`reason` is required when enabling maintenance' });
        }
        if (trimmedReason.length > 500) {
          return res.status(400).json({ error: '`reason` must be at most 500 characters' });
        }

        // Reject if car has an active session
        const activeSessions = getActiveSessions ? getActiveSessions() : new Map();
        const hasActiveSession = [...activeSessions.values()].some((s) => s.carId === carId);
        if (hasActiveSession) {
          return res.status(409).json({
            error: 'conflict',
            message: 'Нельзя поставить на обслуживание машину с активной сессией. Сначала завершите сессию.',
          });
        }

        db.prepare(`
          INSERT INTO car_maintenance (car_id, enabled, reason, admin_id, created_at)
          VALUES (?, 1, ?, ?, datetime('now'))
          ON CONFLICT(car_id) DO UPDATE SET
            enabled = 1,
            reason = excluded.reason,
            admin_id = excluded.admin_id,
            created_at = excluded.created_at
        `).run(carId, trimmedReason, actor.id);
        // created_at is updated to reflect when maintenance was most recently enabled;
        // full history is preserved in the admin audit log.

        logAdminAudit({
          adminId: actor.id,
          action: 'maintenance_enabled',
          targetType: 'car',
          targetId: carId,
          details: { car_id: carId, car_name: car.name, reason: trimmedReason },
          ipAddress: req.ip || null,
          userAgent: req.headers['user-agent'] || null,
        });

        if (broadcastCarsUpdate) broadcastCarsUpdate();

        const updatedRow = db.prepare('SELECT * FROM car_maintenance WHERE car_id = ?').get(carId);
        return res.json({
          success: true,
          car: {
            id: car.id,
            name: car.name,
            status: 'maintenance',
            maintenance: {
              enabled: true,
              reason: trimmedReason,
              admin_id: actor.id,
              created_at: updatedRow ? updatedRow.created_at : null,
            },
          },
        });
      } else {
        // Disable maintenance
        db.prepare(`
          INSERT INTO car_maintenance (car_id, enabled, reason, admin_id, created_at)
          VALUES (?, 0, NULL, ?, datetime('now'))
          ON CONFLICT(car_id) DO UPDATE SET
            enabled = 0,
            reason = NULL,
            admin_id = excluded.admin_id,
            created_at = excluded.created_at
        `).run(carId, actor.id);
        // reason is cleared when disabling (reflects current state: no active maintenance);
        // the enabling reason is preserved in the admin audit log under maintenance_enabled.

        logAdminAudit({
          adminId: actor.id,
          action: 'maintenance_disabled',
          targetType: 'car',
          targetId: carId,
          details: { car_id: carId, car_name: car.name },
          ipAddress: req.ip || null,
          userAgent: req.headers['user-agent'] || null,
        });

        if (broadcastCarsUpdate) broadcastCarsUpdate();

        return res.json({
          success: true,
          car: {
            id: car.id,
            name: car.name,
            status: 'available',
            maintenance: null,
          },
        });
      }
    }
  );
};
