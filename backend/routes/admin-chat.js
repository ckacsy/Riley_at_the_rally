'use strict';

const { createRateLimiter } = require('../middleware/rateLimiter');

/**
 * Mount admin chat-moderation routes.
 *
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   requireRole: (...roles: string[]) => Function,
 *   csrfMiddleware: Function,
 *   logAdminAudit: Function,
 * }} deps
 * @param {{ io: import('socket.io').Server }} extra
 */
module.exports = function mountAdminChatRoutes(app, db, deps, extra) {
  const { requireRole, csrfMiddleware, logAdminAudit } = deps;
  const { io } = extra;

  const adminReadLimiter = createRateLimiter({ max: 120 });

  const adminMutationLimiter = createRateLimiter({ max: 60 });

  // GET /api/admin/chat/messages
  // Returns recent chat messages (including deleted) for admin moderation.
  app.get(
    '/api/admin/chat/messages',
    adminReadLimiter,
    requireRole('admin', 'moderator'),
    (req, res) => {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const offset = (page - 1) * limit;

      const total = db.prepare('SELECT COUNT(*) AS cnt FROM chat_messages').get().cnt;
      const rows = db.prepare(
        `SELECT id, user_id AS userId, username, text AS message,
                created_at AS createdAt, deleted, deleted_by AS deletedBy, deleted_at AS deletedAt
         FROM chat_messages ORDER BY id DESC LIMIT ? OFFSET ?`
      ).all(limit, offset);

      res.json({ messages: rows, total, page, limit });
    }
  );

  // DELETE /api/admin/chat/:id
  // Soft-deletes a chat message and broadcasts the deletion to all sockets.
  app.delete(
    '/api/admin/chat/:id',
    adminMutationLimiter,
    requireRole('admin', 'moderator'),
    csrfMiddleware,
    (req, res) => {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Некорректный ID сообщения' });
      }

      const msg = db.prepare('SELECT id, username, deleted FROM chat_messages WHERE id = ?').get(id);
      if (!msg) {
        return res.status(404).json({ error: 'Сообщение не найдено' });
      }
      if (msg.deleted) {
        return res.status(409).json({ error: 'Сообщение уже удалено' });
      }

      const now = new Date().toISOString();
      const actor = req.user;
      db.prepare(
        'UPDATE chat_messages SET deleted = 1, deleted_by = ?, deleted_at = ? WHERE id = ?'
      ).run(actor.username, now, id);

      // Broadcast deletion to all connected clients (same as socket chat:delete)
      if (io) {
        io.emit('chat:deleted', { id });
      }

      logAdminAudit({
        adminId: actor.id,
        action: 'delete_message',
        targetType: 'chat_message',
        targetId: id,
        details: { msgUsername: msg.username },
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
      });

      res.json({ success: true });
    }
  );
};
