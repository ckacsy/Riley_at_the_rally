'use strict';

const bcrypt = require('bcrypt');
const metrics = require('../metrics');

module.exports = function setup(app, db, helpers, deps) {
  const { csrfMiddleware, generateCsrfToken, apiReadLimiter } = deps;
  const {
    loginLimiter,
    DUMMY_HASH,
    getLoginLockout,
    recordLoginFailure,
    clearLoginFailures,
  } = helpers;

  app.get('/api/csrf-token', (req, res) => {
    if (!req.session.csrfToken) {
      req.session.csrfToken = generateCsrfToken();
    }
    res.json({ csrfToken: req.session.csrfToken });
  });

  app.post('/api/auth/login', loginLimiter, csrfMiddleware, async (req, res) => {
    try {
      const body = req.body || {};
      const rawIdentifier = typeof body.identifier === 'string' ? body.identifier
        : typeof body.email === 'string' ? body.email : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!rawIdentifier || !password) {
        return res.status(400).json({ error: 'Имя пользователя/email и пароль обязательны' });
      }
      const clientIp = req.ip;
      const lockoutMsg = getLoginLockout(clientIp);
      if (lockoutMsg) return res.status(429).json({ error: lockoutMsg });
      const identifierNorm = rawIdentifier.trim().toLowerCase();
      let user = db.prepare('SELECT * FROM users WHERE email_normalized = ?').get(identifierNorm);
      if (!user) {
        user = db.prepare('SELECT * FROM users WHERE username_normalized = ?').get(identifierNorm);
      }
      const hashToCompare = user ? user.password_hash : DUMMY_HASH;
      const passwordMatch = await bcrypt.compare(password, hashToCompare);
      if (!user || !passwordMatch) {
        recordLoginFailure(clientIp);
        metrics.log('warn', 'auth_fail', { event: 'login', reason: 'invalid_credentials', ip: clientIp });
        metrics.recordError();
        return res.status(401).json({ error: 'Неверный логин или пароль' });
      }
      if (user.status === 'banned') {
        metrics.log('warn', 'auth_fail', { event: 'login', reason: 'account_banned', ip: clientIp, userId: user.id });
        metrics.recordError();
        return res.status(403).json({ error: 'Аккаунт заблокирован. Обратитесь в поддержку.' });
      }
      clearLoginFailures(clientIp);
      req.session.regenerate((err) => {
        if (err) return res.status(500).json({ error: 'Ошибка сервера' });
        req.session.userId = user.id;
        req.session.csrfToken = generateCsrfToken();
        db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
        res.json({
          success: true,
          user: { id: user.id, username: user.username, status: user.status },
          csrfToken: req.session.csrfToken,
        });
      });
    } catch (e) {
      console.error('Login error:', e.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Ошибка сервера' });
      }
    }
  });

  app.post('/api/auth/logout', csrfMiddleware, (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
  });

  app.get('/api/auth/me', apiReadLimiter, (req, res) => {
    if (!req.session.userId) return res.json({ user: null });
    const user = db
      .prepare('SELECT id, username, email, avatar_path, status, role, created_at FROM users WHERE id = ?')
      .get(req.session.userId);
    if (!user || user.status === 'deleted' || user.status === 'banned' || user.status === 'disabled') {
      req.session.destroy(() => {});
      return res.json({ user: null });
    }
    res.json({ user });
  });
};
