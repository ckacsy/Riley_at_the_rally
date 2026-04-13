'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { validatePassword } = require('../validators');

module.exports = function setup(app, db, helpers, deps) {
  const { csrfMiddleware } = deps;
  const {
    forgotPasswordLimiter,
    resetPasswordLimiter,
    forgotPasswordEmailCooldowns,
    FORGOT_PASSWORD_EMAIL_COOLDOWN_MS,
    isEmailInCooldown,
    createPasswordResetToken,
    sendPasswordResetEmail,
    invalidateUserSessions,
  } = helpers;

  app.post('/api/auth/forgot-password', forgotPasswordLimiter, csrfMiddleware, (req, res) => {
    const body = req.body || {};
    const rawEmail = typeof body.email === 'string' ? body.email : '';
    const successResponse = () =>
      res.json({ success: true, message: 'Если этот email зарегистрирован, вы получите письмо со ссылкой для сброса пароля.' });
    if (!rawEmail) return successResponse();
    const emailNorm = rawEmail.trim().toLowerCase();
    if (isEmailInCooldown(forgotPasswordEmailCooldowns, emailNorm, FORGOT_PASSWORD_EMAIL_COOLDOWN_MS)) {
      return successResponse();
    }
    const user = db
      .prepare('SELECT id, email, email_normalized FROM users WHERE email_normalized = ?')
      .get(emailNorm);
    if (user) {
      const token = createPasswordResetToken(user.id);
      forgotPasswordEmailCooldowns.set(emailNorm, Date.now());
      sendPasswordResetEmail(user.email_normalized || user.email, token, req);
    }
    successResponse();
  });

  app.post('/api/auth/reset-password', resetPasswordLimiter, csrfMiddleware, async (req, res) => {
    try {
      const body = req.body || {};
      const rawToken = typeof body.token === 'string' ? body.token : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const confirmPassword = typeof body.confirm_password === 'string' ? body.confirm_password : undefined;
      if (!rawToken) return res.status(400).json({ error: 'Токен отсутствует или недействителен' });
      const passwordErr = validatePassword(password, confirmPassword);
      if (passwordErr) return res.status(400).json({ error: passwordErr });
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const record = db
        .prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ?')
        .get(tokenHash);
      if (!record) return res.status(400).json({ error: 'Ссылка для сброса пароля недействительна или уже использована' });
      if (new Date(record.expires_at) < new Date()) {
        db.prepare('DELETE FROM password_reset_tokens WHERE id = ?').run(record.id);
        return res.status(400).json({ error: 'Ссылка для сброса пароля истекла. Запросите новую.' });
      }
      const newHash = await bcrypt.hash(password, 12);
      db.transaction(() => {
        db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newHash, record.user_id);
        db.prepare('DELETE FROM password_reset_tokens WHERE id = ?').run(record.id);
      })();
      invalidateUserSessions(record.user_id);
      res.json({ success: true, message: 'Пароль успешно изменён. Теперь вы можете войти с новым паролем.' });
    } catch (e) {
      console.error('Reset-password error:', e.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Ошибка сервера' });
      }
    }
  });
};
