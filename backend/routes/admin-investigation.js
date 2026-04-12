'use strict';

const { createRateLimiter } = require('../middleware/rateLimiter');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Mount admin investigation routes.
 *
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   requireRole: (...roles: string[]) => Function,
 * }} deps
 */
module.exports = function mountAdminInvestigationRoutes(app, db, deps) {
  const { requireRole } = deps;

  const adminReadLimiter = createRateLimiter({ max: 60 });

  // ---------------------------------------------------------------------------
  // GET /api/admin/investigation/timeline
  // Unified chronological event timeline across transactions, sessions, audit,
  // and car maintenance. Admin only.
  // ---------------------------------------------------------------------------
  app.get(
    '/api/admin/investigation/timeline',
    adminReadLimiter,
    requireRole('admin'),
    (req, res) => {
      // --- Pagination ---
      let page = 1;
      let limit = 50;

      if (req.query.page !== undefined) {
        const p = parseInt(req.query.page, 10);
        if (!Number.isInteger(p) || p < 1) return res.status(400).json({ error: 'Invalid page parameter' });
        page = p;
      }
      if (req.query.limit !== undefined) {
        const l = parseInt(req.query.limit, 10);
        if (!Number.isInteger(l) || l < 1 || l > 100) return res.status(400).json({ error: 'Invalid limit parameter (1–100)' });
        limit = l;
      }

      // --- Filter params ---
      let userId = null;
      let carId = null;
      let referenceId = null;
      let dateFrom = null;
      let dateTo = null;

      if (req.query.user_id !== undefined) {
        const uid = parseInt(req.query.user_id, 10);
        if (!Number.isInteger(uid) || uid < 1) return res.status(400).json({ error: 'Invalid user_id parameter' });
        userId = uid;
      }
      if (req.query.car_id !== undefined) {
        const cid = parseInt(req.query.car_id, 10);
        if (!Number.isInteger(cid) || cid < 1) return res.status(400).json({ error: 'Invalid car_id parameter' });
        carId = cid;
      }
      if (req.query.reference_id !== undefined) {
        const ref = req.query.reference_id.trim();
        if (ref !== '') referenceId = ref;
      }
      if (req.query.date_from !== undefined) {
        if (!DATE_RE.test(req.query.date_from)) return res.status(400).json({ error: 'Invalid date_from format (use YYYY-MM-DD)' });
        dateFrom = req.query.date_from + ' 00:00:00';
      }
      if (req.query.date_to !== undefined) {
        if (!DATE_RE.test(req.query.date_to)) return res.status(400).json({ error: 'Invalid date_to format (use YYYY-MM-DD)' });
        const nextDay = new Date(req.query.date_to);
        nextDay.setDate(nextDay.getDate() + 1);
        dateTo = nextDay.toISOString().slice(0, 10) + ' 00:00:00';
      }

      // If no filter is provided, require at least one to avoid huge queries
      if (userId === null && carId === null && referenceId === null && dateFrom === null) {
        return res.status(400).json({ error: 'Укажите хотя бы один фильтр: user_id, car_id, reference_id или date_from' });
      }

      const events = [];

      // -----------------------------------------------------------------------
      // 1. Transactions
      // -----------------------------------------------------------------------
      {
        const conds = [];
        const params = [];
        if (userId !== null) { conds.push('t.user_id = ?'); params.push(userId); }
        if (referenceId !== null) { conds.push('t.reference_id = ?'); params.push(referenceId); }
        if (dateFrom !== null) { conds.push('t.created_at >= ?'); params.push(dateFrom); }
        if (dateTo !== null) { conds.push('t.created_at < ?'); params.push(dateTo); }
        const where = conds.length > 0 ? 'WHERE ' + conds.join(' AND ') : '';
        const rows = db.prepare(
          `SELECT t.id, t.user_id, u.username, t.type, t.amount, t.balance_after,
                  t.description, t.reference_id, t.admin_id,
                  admin_u.username AS admin_username, t.created_at
           FROM transactions t
           LEFT JOIN users u ON u.id = t.user_id
           LEFT JOIN users admin_u ON admin_u.id = t.admin_id
           ${where}
           ORDER BY t.created_at DESC, t.id DESC
           LIMIT 500`
        ).all(...params);

        for (const r of rows) {
          const typeLabel = {
            hold: 'Блокировка',
            release: 'Разблокировка',
            deduct: 'Списание',
            topup: 'Пополнение',
            admin_adjust: 'Корректировка',
            admin_compensation: 'Компенсация',
          }[r.type] || r.type;
          const sign = r.amount >= 0 ? '+' : '';
          events.push({
            source: 'transaction',
            id: r.id,
            created_at: r.created_at,
            summary: `${typeLabel}: ${sign}${Number(r.amount).toFixed(2)} RC` + (r.username ? ` — ${r.username}` : ''),
            details: {
              id: r.id,
              user_id: r.user_id,
              username: r.username,
              type: r.type,
              amount: r.amount,
              balance_after: r.balance_after,
              description: r.description,
              reference_id: r.reference_id,
              admin_id: r.admin_id,
              admin_username: r.admin_username,
              created_at: r.created_at,
            },
          });
        }
      }

      // -----------------------------------------------------------------------
      // 2. Rental sessions
      // -----------------------------------------------------------------------
      {
        const conds = [];
        const params = [];
        if (userId !== null) { conds.push('rs.user_id = ?'); params.push(userId); }
        if (carId !== null) { conds.push('rs.car_id = ?'); params.push(carId); }
        if (referenceId !== null) { conds.push('rs.session_ref = ?'); params.push(referenceId); }
        if (dateFrom !== null) { conds.push('rs.created_at >= ?'); params.push(dateFrom); }
        if (dateTo !== null) { conds.push('rs.created_at < ?'); params.push(dateTo); }
        // If only car_id filter, still query; if no relevant filter skip to avoid huge result
        if (conds.length === 0) {
          // no useful filter — skip
        } else {
          const where = 'WHERE ' + conds.join(' AND ');
          const rows = db.prepare(
            `SELECT rs.id, rs.user_id, u.username, rs.car_id, rs.car_name,
                    rs.duration_seconds, rs.cost, rs.session_ref, rs.created_at
             FROM rental_sessions rs
             LEFT JOIN users u ON u.id = rs.user_id
             ${where}
             ORDER BY rs.created_at DESC, rs.id DESC
             LIMIT 500`
          ).all(...params);

          for (const r of rows) {
            const mins = Math.floor((r.duration_seconds || 0) / 60);
            const secs = (r.duration_seconds || 0) % 60;
            events.push({
              source: 'session',
              id: r.id,
              created_at: r.created_at,
              summary: `Сессия аренды: ${r.car_name || ('Машина #' + r.car_id)} — ${mins}м ${secs}с, ${Number(r.cost || 0).toFixed(2)} RC` + (r.username ? ` — ${r.username}` : ''),
              details: {
                id: r.id,
                user_id: r.user_id,
                username: r.username,
                car_id: r.car_id,
                car_name: r.car_name,
                duration_seconds: r.duration_seconds,
                cost: r.cost,
                session_ref: r.session_ref,
                created_at: r.created_at,
              },
            });
          }
        }
      }

      // -----------------------------------------------------------------------
      // 3. Admin audit log
      // -----------------------------------------------------------------------
      {
        const conds = [];
        const params = [];

        // Build entity filter: match user target OR car target (or both)
        const entityParts = [];
        if (userId !== null) {
          entityParts.push("(a.target_id = ? AND a.target_type = 'user')");
          params.push(userId);
        }
        if (carId !== null) {
          entityParts.push("(a.target_id = ? AND a.target_type = 'car')");
          params.push(carId);
        }
        if (entityParts.length > 0) {
          conds.push('(' + entityParts.join(' OR ') + ')');
        }

        if (dateFrom !== null) { conds.push('a.created_at >= ?'); params.push(dateFrom); }
        if (dateTo !== null) { conds.push('a.created_at < ?'); params.push(dateTo); }

        if (conds.length > 0) {
          const where = 'WHERE ' + conds.join(' AND ');
          const rows = db.prepare(
            `SELECT a.id, a.admin_id, admin_u.username AS admin_username,
                    a.action, a.target_type, a.target_id, a.details_json, a.created_at
             FROM admin_audit_log a
             LEFT JOIN users admin_u ON admin_u.id = a.admin_id
             ${where}
             ORDER BY a.created_at DESC, a.id DESC
             LIMIT 500`
          ).all(...params);

          for (const r of rows) {
            let details_parsed = null;
            try { details_parsed = r.details_json ? JSON.parse(r.details_json) : null; } catch (_) {}
            events.push({
              source: 'audit',
              id: r.id,
              created_at: r.created_at,
              summary: `Аудит: ${r.action} [${r.target_type}#${r.target_id}]` + (r.admin_username ? ` — адм. ${r.admin_username}` : ''),
              details: {
                id: r.id,
                admin_id: r.admin_id,
                admin_username: r.admin_username,
                action: r.action,
                target_type: r.target_type,
                target_id: r.target_id,
                details: details_parsed,
                created_at: r.created_at,
              },
            });
          }
        }
      }

      // -----------------------------------------------------------------------
      // 4. Car maintenance
      // -----------------------------------------------------------------------
      if (carId !== null) {
        const conds = ['cm.car_id = ?'];
        const params = [carId];
        if (dateFrom !== null) { conds.push('cm.created_at >= ?'); params.push(dateFrom); }
        if (dateTo !== null) { conds.push('cm.created_at < ?'); params.push(dateTo); }
        const where = 'WHERE ' + conds.join(' AND ');
        const rows = db.prepare(
          `SELECT cm.car_id, cm.enabled, cm.reason, cm.admin_id,
                  admin_u.username AS admin_username, cm.created_at
           FROM car_maintenance cm
           LEFT JOIN users admin_u ON admin_u.id = cm.admin_id
           ${where}
           ORDER BY cm.created_at DESC
           LIMIT 100`
        ).all(...params);

        for (const r of rows) {
          const state = r.enabled ? 'включён' : 'выключен';
          events.push({
            source: 'maintenance',
            id: r.car_id,
            created_at: r.created_at,
            summary: `Обслуживание машины #${r.car_id}: режим ТО ${state}` + (r.reason ? ` — ${r.reason}` : '') + (r.admin_username ? ` — адм. ${r.admin_username}` : ''),
            details: {
              car_id: r.car_id,
              enabled: r.enabled,
              reason: r.reason,
              admin_id: r.admin_id,
              admin_username: r.admin_username,
              created_at: r.created_at,
            },
          });
        }
      }

      // -----------------------------------------------------------------------
      // Sort + paginate
      // -----------------------------------------------------------------------
      events.sort((a, b) => {
        if (a.created_at > b.created_at) return -1;
        if (a.created_at < b.created_at) return 1;
        return 0;
      });

      const total = events.length;
      const pages = Math.ceil(total / limit) || 1;
      const offset = (page - 1) * limit;
      const items = events.slice(offset, offset + limit);

      res.json({ items, pagination: { page, limit, total, pages } });
    }
  );

  // ---------------------------------------------------------------------------
  // GET /api/admin/investigation/entity/:type/:id
  // Quick summary card for a given entity (user, session, car).
  // Moderator+ access.
  // ---------------------------------------------------------------------------
  app.get(
    '/api/admin/investigation/entity/:type/:id',
    adminReadLimiter,
    requireRole('moderator', 'admin'),
    (req, res) => {
      const { type } = req.params;
      const idParam = parseInt(req.params.id, 10);
      if (!Number.isInteger(idParam) || idParam < 1) {
        return res.status(400).json({ error: 'Invalid id parameter' });
      }

      if (type === 'user') {
        const user = db.prepare(
          `SELECT id, username, email, status, role, balance, created_at FROM users WHERE id = ?`
        ).get(idParam);
        if (!user) return res.status(404).json({ error: 'User not found' });
        return res.json({ type: 'user', entity: user });
      }

      if (type === 'session') {
        const session = db.prepare(
          `SELECT rs.id, rs.user_id, u.username, rs.car_id, rs.car_name,
                  rs.duration_seconds, rs.cost, rs.session_ref, rs.created_at
           FROM rental_sessions rs
           LEFT JOIN users u ON u.id = rs.user_id
           WHERE rs.id = ?`
        ).get(idParam);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        // Related transactions via session_ref, or time-window fallback
        let transactions = [];
        if (session.session_ref) {
          transactions = db.prepare(
            `SELECT t.id, t.type, t.amount, t.balance_after, t.description, t.reference_id, t.created_at
             FROM transactions t
             WHERE t.reference_id = ?
             ORDER BY t.created_at ASC`
          ).all(session.session_ref);
        } else {
          // Time-window heuristic: transactions for same user within ±5 min of session
          transactions = db.prepare(
            `SELECT t.id, t.type, t.amount, t.balance_after, t.description, t.reference_id, t.created_at
             FROM transactions t
             WHERE t.user_id = ?
               AND t.created_at >= datetime(?, '-5 minutes')
               AND t.created_at <= datetime(?, '+5 minutes')
             ORDER BY t.created_at ASC`
          ).all(session.user_id, session.created_at, session.created_at);
        }

        return res.json({ type: 'session', entity: session, transactions });
      }

      if (type === 'car') {
        const maintenance = db.prepare(
          `SELECT cm.car_id, cm.enabled, cm.reason, cm.admin_id,
                  admin_u.username AS admin_username, cm.created_at
           FROM car_maintenance cm
           LEFT JOIN users admin_u ON admin_u.id = cm.admin_id
           WHERE cm.car_id = ?`
        ).get(idParam);

        const recentSessionsCount = db.prepare(
          `SELECT COUNT(*) AS cnt FROM rental_sessions WHERE car_id = ?`
        ).get(idParam);

        return res.json({
          type: 'car',
          entity: {
            car_id: idParam,
            maintenance: maintenance || null,
            recent_sessions_count: recentSessionsCount ? recentSessionsCount.cnt : 0,
          },
        });
      }

      return res.status(400).json({ error: 'Unknown entity type. Supported: user, session, car' });
    }
  );
};
