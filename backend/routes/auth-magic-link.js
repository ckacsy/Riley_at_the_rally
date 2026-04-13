'use strict';

const crypto = require('crypto');
const { validateEmail, normalizeEmail } = require('../validators');

module.exports = function setup(app, db, helpers, deps) {
  const { csrfMiddleware, generateCsrfToken } = deps;
  const {
    magicLinkLimiter,
    magicVerifyLimiter,
    magicLinkEmailCooldowns,
    MAGIC_LINK_EMAIL_COOLDOWN_MS,
    isEmailInCooldown,
    createMagicLinkToken,
    sendMagicLinkEmail,
  } = helpers;

  app.post('/api/auth/magic-link', magicLinkLimiter, csrfMiddleware, (req, res) => {
    const body = req.body || {};
    const rawEmail = typeof body.email === 'string' ? body.email : '';
    const emailErr = validateEmail(rawEmail);
    if (emailErr) {
      return res.status(400).json({ error: emailErr });
    }
    const emailNorm = normalizeEmail(rawEmail);
    if (isEmailInCooldown(magicLinkEmailCooldowns, emailNorm, MAGIC_LINK_EMAIL_COOLDOWN_MS)) {
      return res.json({ success: true, message: 'Если этот email зарегистрирован или является новым, вы получите письмо со ссылкой для входа.' });
    }
    try {
      const rawToken = createMagicLinkToken(emailNorm);
      magicLinkEmailCooldowns.set(emailNorm, Date.now());
      sendMagicLinkEmail(emailNorm, rawToken, req);
    } catch (e) {
      console.error('[magic-link] Error creating/sending magic link:', e.message);
    }
    res.json({ success: true, message: 'Если этот email зарегистрирован или является новым, вы получите письмо со ссылкой для входа.' });
  });

  app.get('/auth/magic', magicVerifyLimiter, (req, res) => {
    const rawToken = typeof req.query.token === 'string' ? req.query.token.trim() : '';
    if (!rawToken) {
      return res.redirect('/magic-link?error=invalid');
    }
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const record = db.prepare('SELECT * FROM magic_links WHERE token_hash = ?').get(tokenHash);
    if (!record || record.used_at || new Date(record.expires_at) < new Date()) {
      return res.redirect('/magic-link?error=invalid');
    }
    db.prepare('UPDATE magic_links SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(record.id);
    const emailNorm = record.email;
    let user = db.prepare('SELECT * FROM users WHERE email_normalized = ?').get(emailNorm);
    if (!user) {
      const baseUsername = (emailNorm.split('@')[0].replace(/[^a-z0-9_]/gi, '') || 'user').slice(0, 28);
      let username = baseUsername;
      const checkUsername = db.prepare('SELECT id FROM users WHERE username_normalized = ?');
      while (checkUsername.get(username.toLowerCase())) {
        username = baseUsername + Math.floor(1000 + Math.random() * 9000);
      }
      try {
        const result = db.prepare(
          `INSERT INTO users (username, username_normalized, email, email_normalized, password_hash, status) VALUES (?, ?, ?, ?, '', 'active')`
        ).run(username, username.toLowerCase(), emailNorm, emailNorm);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
      } catch (e) {
        console.error('[magic-link] Failed to create user:', e.message);
        return res.redirect('/magic-link?error=invalid');
      }
    } else {
      db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    }
    req.session.regenerate((err) => {
      if (err) {
        console.error('[magic-link] Session regeneration error:', err.message);
        return res.redirect('/magic-link?error=invalid');
      }
      req.session.userId = user.id;
      req.session.csrfToken = generateCsrfToken();
      const rawRedirect = typeof req.query.redirect === 'string' ? req.query.redirect : '';
      const redirect = (rawRedirect.startsWith('/') && !rawRedirect.startsWith('//'))
        ? rawRedirect
        : '/garage';
      res.redirect(redirect);
    });
  });
};
