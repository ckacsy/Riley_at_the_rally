'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const {
  validateUsername,
  validateEmail,
  validatePassword,
  normalizeEmail,
  normalizeUsername,
  normalizeText,
} = require('../validators');

module.exports = function setup(app, db, helpers, deps) {
  const { csrfMiddleware, generateCsrfToken, apiReadLimiter } = deps;
  const {
    registerLimiter,
    verifyResendLimiter,
    requireAuth,
    createVerificationToken,
    sendVerificationEmail,
  } = helpers;

  app.post('/api/auth/register', registerLimiter, csrfMiddleware, async (req, res) => {
    const body = req.body || {};
    const rawUsername = typeof body.username === 'string' ? body.username : '';
    const rawEmail = typeof body.email === 'string' ? body.email : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const confirmPassword = typeof body.confirm_password === 'string' ? body.confirm_password : undefined;
    const errors = {};
    const usernameErr = validateUsername(rawUsername);
    if (usernameErr) errors.username = usernameErr;
    const emailErr = validateEmail(rawEmail);
    if (emailErr) errors.email = emailErr;
    const passwordErr = validatePassword(password, confirmPassword);
    if (passwordErr) errors.password = passwordErr;
    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ errors, error: Object.values(errors)[0] });
    }
    const username = normalizeText(rawUsername);
    const emailNorm = normalizeEmail(rawEmail);
    const usernameNorm = normalizeUsername(rawUsername);
    try {
      const hash = await bcrypt.hash(password, 12);
      const insertUser = db.prepare(
        `INSERT INTO users (username, username_normalized, email, email_normalized, password_hash, status) VALUES (?, ?, ?, ?, ?, 'pending')`
      );
      let userId;
      db.transaction(() => {
        const result = insertUser.run(username, usernameNorm, rawEmail.trim(), emailNorm, hash);
        userId = result.lastInsertRowid;
      })();
      const verifyToken = createVerificationToken(userId);
      sendVerificationEmail(emailNorm, verifyToken, req);
      req.session.regenerate((err) => {
        if (err) return res.status(500).json({ error: 'Ошибка сервера' });
        req.session.userId = userId;
        req.session.csrfToken = generateCsrfToken();
        res.json({
          success: true,
          user: { id: userId, username, status: 'pending' },
          csrfToken: req.session.csrfToken,
        });
      });
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE')) {
        if (e.message.includes('username') || e.message.includes('username_norm')) {
          return res.status(400).json({ errors: { username: 'Это имя пользователя уже занято' }, error: 'Это имя пользователя уже занято' });
        }
        return res.status(400).json({ errors: { email: 'Этот email уже зарегистрирован' }, error: 'Этот email уже зарегистрирован' });
      }
      console.error('Register error:', e.message);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });

  app.get('/api/auth/verify-email', apiReadLimiter, (req, res) => {
    const rawToken = req.query.token;
    if (!rawToken || typeof rawToken !== 'string') {
      return res.status(400).json({ error: 'Токен отсутствует или недействителен' });
    }
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const record = db
      .prepare('SELECT * FROM email_verification_tokens WHERE token_hash = ?')
      .get(tokenHash);
    if (!record) return res.status(400).json({ error: 'Ссылка подтверждения недействительна или уже использована' });
    if (new Date(record.expires_at) < new Date()) {
      db.prepare('DELETE FROM email_verification_tokens WHERE id = ?').run(record.id);
      return res.status(400).json({ error: 'Ссылка подтверждения истекла. Запросите новую.' });
    }
    db.transaction(() => {
      db.prepare("UPDATE users SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(record.user_id);
      db.prepare('DELETE FROM email_verification_tokens WHERE id = ?').run(record.id);
    })();
    res.json({ success: true, message: 'Email подтверждён! Теперь вы можете арендовать машины и участвовать в гонках.' });
  });

  app.post('/api/auth/resend-verification', requireAuth, verifyResendLimiter, csrfMiddleware, (req, res) => {
    const user = db
      .prepare('SELECT id, email, email_normalized, status FROM users WHERE id = ?')
      .get(req.session.userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (user.status !== 'pending') return res.status(400).json({ error: 'Ваш email уже подтверждён' });
    const token = createVerificationToken(user.id);
    sendVerificationEmail(user.email_normalized || user.email, token, req);
    res.json({ success: true, message: 'Письмо с подтверждением отправлено.' });
  });
};
