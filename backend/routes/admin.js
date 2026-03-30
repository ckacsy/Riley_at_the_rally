'use strict';

const rateLimit = require('express-rate-limit');
const { canActOn } = require('../middleware/roles');

const MAX_COMPENSATION_AMOUNT = 10000;

const REASON_LABELS = {
  service_issue: 'Проблема с сервисом',
  billing_error: 'Ошибка биллинга',
  goodwill_credit: 'Жест доброй воли',
  session_interruption: 'Прерывание сессии',
};

const COMPENSATION_REASONS = Object.keys(REASON_LABELS);

/**
 * Mount admin user-management routes.
 *
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   requireAuth: Function,
 *   requireActiveUser: Function,
 *   loadCurrentUser: Function,
 *   requireRole: (...roles: string[]) => Function,
 *   csrfMiddleware: Function,
 *   logAdminAudit: (data: object) => void,
 * }} deps
 */
module.exports = function mountAdminRoutes(app, db, deps) {
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

  const adminWriteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много запросов. Попробуйте позже.' },
    keyGenerator: (req) => req.ip,
    skip: () => process.env.NODE_ENV === 'test',
  });

  // Prepared statements
  const stmtGetUserById = db.prepare(
    'SELECT id, username, email, status, role, balance, created_at, deleted_at FROM users WHERE id = ?'
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/users
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/users',
    adminReadLimiter,
    requireRole('moderator', 'admin'),
    (req, res) => {
      const users = db
        .prepare(
          `SELECT id, username, email, status, role, balance, created_at, deleted_at
             FROM users
            ORDER BY id DESC
            LIMIT 100`
        )
        .all();
      res.json({ users });
    }
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/users/:id/ban
  // -------------------------------------------------------------------------
  app.post(
    '/api/admin/users/:id/ban',
    adminWriteLimiter,
    requireRole('moderator', 'admin'),
    csrfMiddleware,
    (req, res) => {
      const actor = req.user;
      const targetId = parseInt(req.params.id, 10);
      if (!Number.isInteger(targetId)) {
        return res.status(400).json({ error: 'Invalid user id' });
      }

      const target = stmtGetUserById.get(targetId);
      if (!target) return res.status(404).json({ error: 'User not found' });

      if (actor.id === targetId) {
        return res.status(403).json({ error: 'Cannot ban yourself' });
      }

      if (!canActOn(actor, target)) {
        return res.status(403).json({ error: 'forbidden', message: 'Недостаточно прав' });
      }

      const reason = (req.body && typeof req.body.reason === 'string') ? req.body.reason.trim() : null;
      const oldStatus = target.status;

      db.prepare(
        "UPDATE users SET status = 'banned', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(targetId);

      logAdminAudit({
        adminId: actor.id,
        action: 'ban_user',
        targetType: 'user',
        targetId,
        details: { old_status: oldStatus, new_status: 'banned', reason: reason || null },
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
      });

      const updated = stmtGetUserById.get(targetId);
      res.json({ success: true, user: updated });
    }
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/users/:id/unban
  // -------------------------------------------------------------------------
  app.post(
    '/api/admin/users/:id/unban',
    adminWriteLimiter,
    requireRole('moderator', 'admin'),
    csrfMiddleware,
    (req, res) => {
      const actor = req.user;
      const targetId = parseInt(req.params.id, 10);
      if (!Number.isInteger(targetId)) {
        return res.status(400).json({ error: 'Invalid user id' });
      }

      const target = stmtGetUserById.get(targetId);
      if (!target) return res.status(404).json({ error: 'User not found' });

      if (actor.id === targetId) {
        return res.status(403).json({ error: 'Cannot act on yourself' });
      }

      if (!canActOn(actor, target)) {
        return res.status(403).json({ error: 'forbidden', message: 'Недостаточно прав' });
      }

      const oldStatus = target.status;

      if (target.status === 'banned') {
        db.prepare(
          "UPDATE users SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).run(targetId);
      }

      const updated = stmtGetUserById.get(targetId);

      logAdminAudit({
        adminId: actor.id,
        action: 'unban_user',
        targetType: 'user',
        targetId,
        details: { old_status: oldStatus, new_status: updated.status },
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
      });
      res.json({ success: true, user: updated });
    }
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/users/:id/delete  (soft delete, admin only)
  // -------------------------------------------------------------------------
  app.post(
    '/api/admin/users/:id/delete',
    adminWriteLimiter,
    requireRole('admin'),
    csrfMiddleware,
    (req, res) => {
      const actor = req.user;
      const targetId = parseInt(req.params.id, 10);
      if (!Number.isInteger(targetId)) {
        return res.status(400).json({ error: 'Invalid user id' });
      }

      const target = stmtGetUserById.get(targetId);
      if (!target) return res.status(404).json({ error: 'User not found' });

      if (actor.id === targetId) {
        return res.status(403).json({ error: 'Cannot delete yourself' });
      }

      if (!canActOn(actor, target)) {
        return res.status(403).json({ error: 'forbidden', message: 'Недостаточно прав' });
      }

      const ts = Date.now();
      const newUsername = `deleted_user_${targetId}_${ts}`;
      const newEmail = `deleted_user_${targetId}_${ts}@deleted.local`;
      const oldUsername = target.username;
      const oldEmail = target.email;
      const oldStatus = target.status;

      db.prepare(
        `UPDATE users
            SET status = 'deleted',
                deleted_at = CURRENT_TIMESTAMP,
                deleted_by = ?,
                username = ?,
                username_normalized = ?,
                email = ?,
                email_normalized = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(
        actor.id,
        newUsername,
        newUsername.toLowerCase(),
        newEmail,
        newEmail.toLowerCase(),
        targetId
      );

      logAdminAudit({
        adminId: actor.id,
        action: 'delete_user',
        targetType: 'user',
        targetId,
        details: {
          old_status: oldStatus,
          new_status: 'deleted',
          old_username: oldUsername,
          new_username: newUsername,
          old_email: oldEmail,
          new_email: newEmail,
        },
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
      });

      const updated = stmtGetUserById.get(targetId);
      res.json({ success: true, user: updated });
    }
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/audit-log  (admin only)
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/audit-log',
    adminReadLimiter,
    requireRole('admin'),
    (req, res) => {
      // --- Pagination params ---
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

      // --- Filter params ---
      const conditions = [];
      const params = [];

      if (req.query.admin_id !== undefined) {
        const aid = parseInt(req.query.admin_id, 10);
        if (!Number.isInteger(aid) || aid < 1) {
          return res.status(400).json({ error: 'Invalid admin_id parameter' });
        }
        conditions.push('a.admin_id = ?');
        params.push(aid);
      }

      if (req.query.action !== undefined) {
        if (typeof req.query.action !== 'string' || !req.query.action.trim()) {
          return res.status(400).json({ error: 'Invalid action parameter' });
        }
        conditions.push('a.action = ?');
        params.push(req.query.action.trim());
      }

      if (req.query.target_type !== undefined) {
        if (typeof req.query.target_type !== 'string' || !req.query.target_type.trim()) {
          return res.status(400).json({ error: 'Invalid target_type parameter' });
        }
        conditions.push('a.target_type = ?');
        params.push(req.query.target_type.trim());
      }

      if (req.query.target_id !== undefined) {
        const tid = parseInt(req.query.target_id, 10);
        if (!Number.isInteger(tid) || tid < 1) {
          return res.status(400).json({ error: 'Invalid target_id parameter' });
        }
        conditions.push('a.target_id = ?');
        params.push(tid);
      }

      const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

      if (req.query.date_from !== undefined) {
        if (!DATE_RE.test(req.query.date_from)) {
          return res.status(400).json({ error: 'Invalid date_from format (use YYYY-MM-DD)' });
        }
        conditions.push("a.created_at >= ?");
        params.push(req.query.date_from + ' 00:00:00');
      }

      if (req.query.date_to !== undefined) {
        if (!DATE_RE.test(req.query.date_to)) {
          return res.status(400).json({ error: 'Invalid date_to format (use YYYY-MM-DD)' });
        }
        // Exclusive upper boundary: next day start
        const nextDay = new Date(req.query.date_to);
        nextDay.setDate(nextDay.getDate() + 1);
        const nextDayStr = nextDay.toISOString().slice(0, 10);
        conditions.push("a.created_at < ?");
        params.push(nextDayStr + ' 00:00:00');
      }

      const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

      // --- COUNT query ---
      const countRow = db.prepare(
        `SELECT COUNT(*) AS total FROM admin_audit_log a ${whereClause}`
      ).get(...params);
      const total = countRow ? countRow.total : 0;
      const pages = Math.ceil(total / limit) || 1;

      // --- Data query ---
      const offset = (page - 1) * limit;
      const dataParams = [...params, limit, offset];

      const items = db.prepare(
        `SELECT
           a.id,
           a.admin_id,
           u.username AS admin_username,
           a.action,
           a.target_type,
           a.target_id,
           t.username AS target_username,
           a.details_json,
           a.ip_address,
           a.user_agent,
           a.created_at
         FROM admin_audit_log a
         LEFT JOIN users u ON u.id = a.admin_id
         LEFT JOIN users t ON t.id = a.target_id AND a.target_type = 'user'
         ${whereClause}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT ? OFFSET ?`
      ).all(...dataParams);

      res.json({
        items,
        pagination: { page, limit, total, pages },
      });
    }
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/users/:id/balance-adjust
  // -------------------------------------------------------------------------
  app.post(
    '/api/admin/users/:id/balance-adjust',
    adminWriteLimiter,
    requireRole('moderator', 'admin'),
    csrfMiddleware,
    (req, res) => {
      const actor = req.user;
      const targetId = parseInt(req.params.id, 10);
      if (!Number.isInteger(targetId)) {
        return res.status(400).json({ error: 'Invalid user id' });
      }

      const target = stmtGetUserById.get(targetId);
      if (!target) return res.status(404).json({ error: 'User not found' });

      if (!canActOn(actor, target)) {
        return res.status(403).json({ error: 'forbidden', message: 'Недостаточно прав' });
      }

      const { amount, comment, idempotency_key } = req.body || {};

      // Validate amount
      const numAmount = Number(amount);
      if (!Number.isFinite(numAmount) || numAmount === 0) {
        return res.status(400).json({ error: 'amount must be a finite non-zero number' });
      }
      if (Math.abs(numAmount) > 1_000_000) {
        return res.status(400).json({ error: 'amount exceeds allowed limit' });
      }

      // Validate comment
      if (!comment || typeof comment !== 'string' || !comment.trim()) {
        return res.status(400).json({ error: 'comment is required' });
      }

      // Validate idempotency_key
      if (!idempotency_key || typeof idempotency_key !== 'string' || !idempotency_key.trim()) {
        return res.status(400).json({ error: 'idempotency_key is required' });
      }

      const result = db.transaction(() => {
        // Check for existing transaction with same idempotency key
        const existing = db
          .prepare(
            `SELECT id, user_id, type, amount, balance_after, description, created_at, admin_id, idempotency_key
               FROM transactions
              WHERE idempotency_key = ?`
          )
          .get(idempotency_key);

        if (existing) {
          if (
            existing.type !== 'admin_adjust' ||
            existing.user_id !== targetId ||
            existing.admin_id !== actor.id
          ) {
            return { conflict: true };
          }
          const currentUser = stmtGetUserById.get(existing.user_id);
          return { idempotent: true, transaction: existing, user: currentUser };
        }

        // Compute new balance
        const currentUser = stmtGetUserById.get(targetId);
        const newBalance = (currentUser.balance || 0) + numAmount;
        if (newBalance < 0) {
          return { error: 'insufficient_balance', message: 'Balance would go below zero' };
        }

        // Update balance
        db.prepare(
          'UPDATE users SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(newBalance, targetId);

        // Insert transaction
        const txResult = db.prepare(
          `INSERT INTO transactions
             (user_id, type, amount, balance_after, description, admin_id, idempotency_key)
           VALUES (?, 'admin_adjust', ?, ?, ?, ?, ?)`
        ).run(targetId, numAmount, newBalance, comment.trim(), actor.id, idempotency_key);

        const txRow = db
          .prepare('SELECT * FROM transactions WHERE id = ?')
          .get(txResult.lastInsertRowid);

        const updatedUser = stmtGetUserById.get(targetId);
        return { idempotent: false, transaction: txRow, user: updatedUser };
      })();

      if (result.error) {
        return res.status(400).json({ error: result.error, message: result.message });
      }
      if (result.conflict) {
        return res.status(409).json({ error: 'idempotency_key_conflict' });
      }

      if (!result.idempotent) {
        logAdminAudit({
          adminId: actor.id,
          action: 'balance_adjust',
          targetType: 'user',
          targetId,
          details: {
            amount: numAmount,
            balance_after: result.transaction.balance_after,
            comment: comment.trim(),
            idempotency_key,
          },
          ipAddress: req.ip || null,
          userAgent: req.headers['user-agent'] || null,
        });
      }

      res.json({
        success: true,
        idempotent: result.idempotent,
        balance: result.user.balance,
        transaction: {
          id: result.transaction.id,
          amount: result.transaction.amount,
          balance_after: result.transaction.balance_after,
          description: result.transaction.description,
          created_at: result.transaction.created_at,
        },
      });
    }
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/users/:id/compensations
  // -------------------------------------------------------------------------
  app.post(
    '/api/admin/users/:id/compensations',
    adminWriteLimiter,
    requireRole('admin'),
    csrfMiddleware,
    (req, res) => {
      const actor = req.user;
      const targetId = parseInt(req.params.id, 10);
      if (!Number.isInteger(targetId)) {
        return res.status(400).json({ error: 'Invalid user id' });
      }

      if (actor.id === targetId) {
        return res.status(403).json({ error: 'Cannot compensate yourself' });
      }

      const target = stmtGetUserById.get(targetId);
      if (!target) return res.status(404).json({ error: 'User not found' });

      if (target.status === 'deleted') {
        return res.status(400).json({ error: 'Cannot compensate a deleted user' });
      }

      if (!canActOn(actor, target)) {
        return res.status(403).json({ error: 'forbidden', message: 'Недостаточно прав' });
      }

      const { amount, reason_code, note, idempotency_key } = req.body || {};

      // Validate amount
      const numAmount = Number(amount);
      if (amount === undefined || amount === null || !Number.isFinite(numAmount)) {
        return res.status(400).json({ error: 'amount must be a finite number' });
      }
      if (numAmount <= 0) {
        return res.status(400).json({ error: 'amount must be positive' });
      }
      if (numAmount > MAX_COMPENSATION_AMOUNT) {
        return res.status(400).json({ error: `amount exceeds maximum of ${MAX_COMPENSATION_AMOUNT}` });
      }

      // Validate reason_code
      if (!reason_code || !COMPENSATION_REASONS.includes(reason_code)) {
        return res.status(400).json({ error: 'reason_code must be one of: ' + COMPENSATION_REASONS.join(', ') });
      }

      // Validate note (optional)
      let trimmedNote = null;
      if (note !== undefined && note !== null) {
        if (typeof note !== 'string') {
          return res.status(400).json({ error: 'note must be a string' });
        }
        trimmedNote = note.trim();
        if (trimmedNote.length > 500) {
          return res.status(400).json({ error: 'note must not exceed 500 characters' });
        }
        if (trimmedNote.length === 0) trimmedNote = null;
      }

      // Validate idempotency_key
      if (!idempotency_key || typeof idempotency_key !== 'string' || !idempotency_key.trim()) {
        return res.status(400).json({ error: 'idempotency_key is required' });
      }

      const reasonLabel = REASON_LABELS[reason_code];
      const description = trimmedNote
        ? `Компенсация: ${reasonLabel} — ${trimmedNote}`
        : `Компенсация: ${reasonLabel}`;

      const result = db.transaction(() => {
        // Check for existing transaction with same idempotency key
        const existing = db
          .prepare(
            `SELECT id, user_id, type, amount, balance_after, description, created_at, admin_id, idempotency_key
               FROM transactions
              WHERE idempotency_key = ?`
          )
          .get(idempotency_key);

        if (existing) {
          if (
            existing.type !== 'admin_compensation' ||
            existing.user_id !== targetId ||
            existing.admin_id !== actor.id
          ) {
            return { conflict: true };
          }
          const currentUser = stmtGetUserById.get(existing.user_id);
          return { idempotent: true, transaction: existing, user: currentUser };
        }

        // Compute new balance
        const currentUser = stmtGetUserById.get(targetId);
        const currentBalance = currentUser.balance || 0;
        const newBalance = currentBalance + numAmount;

        // Update balance
        db.prepare(
          'UPDATE users SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(newBalance, targetId);

        // Read back new balance
        const updatedUser = stmtGetUserById.get(targetId);

        // Insert transaction
        const txResult = db.prepare(
          `INSERT INTO transactions
             (user_id, type, amount, balance_after, description, admin_id, idempotency_key)
           VALUES (?, 'admin_compensation', ?, ?, ?, ?, ?)`
        ).run(targetId, numAmount, newBalance, description, actor.id, idempotency_key);

        const txRow = db
          .prepare('SELECT * FROM transactions WHERE id = ?')
          .get(txResult.lastInsertRowid);

        return {
          idempotent: false,
          transaction: txRow,
          user: updatedUser,
          currentBalance,
          newBalance,
        };
      })();

      if (result.conflict) {
        return res.status(409).json({ error: 'idempotency_key_conflict' });
      }

      if (!result.idempotent) {
        logAdminAudit({
          adminId: actor.id,
          action: 'admin_compensation_create',
          targetType: 'user',
          targetId,
          details: {
            amount: numAmount,
            reason_code,
            note: trimmedNote || null,
            balance_before: result.currentBalance,
            balance_after: result.newBalance,
            idempotency_key,
          },
          ipAddress: req.ip || null,
          userAgent: req.headers['user-agent'] || null,
        });
      }

      res.json({
        success: true,
        idempotent: result.idempotent,
        compensation: {
          id: result.transaction.id,
          type: result.transaction.type,
          amount: result.transaction.amount,
          balance_after: result.transaction.balance_after,
          description: result.transaction.description,
          reason_code,
          created_at: result.transaction.created_at,
        },
        balance: result.user.balance,
        user: result.user,
      });
    }
  );
};
