'use strict';

const rateLimit = require('express-rate-limit');
const { canActOn } = require('../middleware/roles');

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
};
