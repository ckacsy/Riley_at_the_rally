'use strict';

const path = require('path');
const fs = require('fs');
const { upload, uploadsDir, validateMagicBytes } = require('../middleware/upload');
const { validateUsername, normalizeText, normalizeUsername } = require('../validators');

module.exports = function setup(app, db, helpers, deps) {
  const { csrfMiddleware, apiReadLimiter } = deps;
  const {
    requireAuth,
    requireActiveUser,
    avatarUploadLimiter,
    usernameChangeLimiter,
  } = helpers;

  const USERNAME_CHANGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

  app.get('/api/profile', requireActiveUser, apiReadLimiter, (req, res) => {
    const userId = req.session.userId;
    const user = db
      .prepare('SELECT id, username, email, avatar_path, status, created_at FROM users WHERE id = ?')
      .get(userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const totalLaps = db.prepare('SELECT COUNT(*) as cnt FROM lap_times WHERE user_id = ?').get(userId).cnt;
    const totalRaces = db
      .prepare('SELECT COUNT(DISTINCT race_id) as cnt FROM lap_times WHERE user_id = ? AND race_id IS NOT NULL')
      .get(userId).cnt;
    const totalSessions = db
      .prepare('SELECT COUNT(*) as cnt FROM rental_sessions WHERE user_id = ?')
      .get(userId).cnt;
    const totalTimeSec = db
      .prepare('SELECT COALESCE(SUM(duration_seconds),0) as total FROM rental_sessions WHERE user_id = ?')
      .get(userId).total;
    const bestLap = db
      .prepare('SELECT * FROM lap_times WHERE user_id = ? ORDER BY lap_time_ms ASC LIMIT 1')
      .get(userId);
    const recentLaps = db
      .prepare('SELECT * FROM lap_times WHERE user_id = ? ORDER BY created_at DESC LIMIT 10')
      .all(userId);
    res.json({
      user,
      stats: { totalLaps, totalRaces, totalSessions, totalTimeSec, bestLap: bestLap || null, recentLaps },
    });
  });

  app.post('/api/profile/avatar', requireAuth, avatarUploadLimiter, csrfMiddleware, (req, res, next) => {
    upload.single('avatar')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'Файл слишком большой. Максимальный размер: 2 МБ.' });
        }
        if (err.message === 'Invalid file type') {
          return res.status(400).json({ error: 'Недопустимый тип файла. Разрешены: JPG, PNG, WebP.' });
        }
        return res.status(400).json({ error: 'Ошибка загрузки файла.' });
      }
      next();
    });
  }, validateMagicBytes, (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен или неверный формат' });
    const avatarPath = '/uploads/' + req.file.filename;
    const existing = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(req.session.userId);
    if (existing && existing.avatar_path) {
      const oldPath = path.join(uploadsDir, path.basename(existing.avatar_path));
      if (fs.existsSync(oldPath)) {
        try { fs.unlinkSync(oldPath); } catch (_) {}
      }
    }
    db.prepare('UPDATE users SET avatar_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(avatarPath, req.session.userId);
    res.json({ success: true, avatarPath });
  });

  app.patch('/api/profile/username', requireAuth, usernameChangeLimiter, csrfMiddleware, (req, res) => {
    const body = req.body || {};
    const rawUsername = typeof body.username === 'string' ? body.username : '';
    const usernameErr = validateUsername(rawUsername);
    if (usernameErr) return res.status(400).json({ error: usernameErr });
    const newUsername = normalizeText(rawUsername);
    const newUsernameNorm = normalizeUsername(rawUsername);
    const userId = req.session.userId;
    const existing = db.prepare('SELECT id FROM users WHERE username_normalized = ? AND id != ?').get(newUsernameNorm, userId);
    if (existing) return res.status(400).json({ error: 'Это имя пользователя уже занято' });
    const user = db.prepare('SELECT username_changed_at FROM users WHERE id = ?').get(userId);
    if (user && user.username_changed_at) {
      const lastChanged = new Date(user.username_changed_at);
      const nextAvailable = new Date(lastChanged.getTime() + USERNAME_CHANGE_COOLDOWN_MS);
      if (Date.now() < nextAvailable.getTime()) {
        const dateStr = nextAvailable.toLocaleDateString('ru-RU', { year: 'numeric', month: 'long', day: 'numeric' });
        return res.status(400).json({ error: `Имя можно менять раз в 7 дней. Следующая смена доступна: ${dateStr}` });
      }
    }
    db.prepare(
      'UPDATE users SET username = ?, username_normalized = ?, username_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(newUsername, newUsernameNorm, userId);
    res.json({ success: true, username: newUsername });
  });
};
