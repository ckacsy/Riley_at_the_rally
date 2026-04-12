'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { createRateLimiter } = require('../middleware/rateLimiter');
const mailer = require('../mailer');
const metrics = require('../metrics');
const { upload, uploadsDir, validateMagicBytes } = require('../middleware/upload');
const { hasRequiredRole, getAccessBlockReason } = require('../middleware/roles');
const {
  validateUsername,
  validateEmail,
  validatePassword,
  normalizeEmail,
  normalizeUsername,
  normalizeText,
} = require('../validators');

/**
 * Mount all authentication and profile routes onto `app`.
 *
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {{ csrfMiddleware: Function, generateCsrfToken: Function, apiReadLimiter: Function, PORT: number|string }} deps
 * @returns {{
 *   requireAuth: Function,
 *   requireActiveUser: Function,
 *   loadCurrentUser: Function,
 *   requireRole: (...roles: string[]) => Function,
 *   invalidateUserSessions: Function,
 *   _devVerificationLinks: Map|null,
 *   _devMagicLinks: Map|null,
 *   _devResetLinks: Map|null
 * }}
 */
module.exports = function mountAuthRoutes(app, db, deps) {
  const { csrfMiddleware, generateCsrfToken, apiReadLimiter, PORT } = deps;

  // --- Rate limiters ---
  const registerLimiter = createRateLimiter({ max: 5, message: 'Слишком много регистраций с этого IP. Попробуйте через минуту.' });

  const loginLimiter = createRateLimiter({ max: 10, message: 'Слишком много попыток входа. Попробуйте позже.' });

  const magicLinkLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5, message: 'Слишком много запросов. Попробуйте через 15 минут.' });

  const magicVerifyLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20, message: 'Слишком много попыток. Попробуйте через 15 минут.' });

  const verifyResendLimiter = createRateLimiter({ max: 3, message: 'Слишком много запросов. Попробуйте через минуту.' });

  const forgotPasswordLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5, message: 'Слишком много запросов. Попробуйте через 15 минут.' });

  const resetPasswordLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, message: 'Слишком много запросов. Попробуйте через 15 минут.' });

  const avatarUploadLimiter = createRateLimiter({ max: 10, message: 'Слишком много загрузок. Попробуйте через минуту.' });

  const usernameChangeLimiter = createRateLimiter({ max: 5, message: 'Слишком много попыток. Попробуйте через минуту.' });

  // --- Auth middleware ---

  // Prepared statement reused across all auth middleware invocations
  const stmtGetUserForAuth = db.prepare('SELECT id, username, email, status, role FROM users WHERE id = ?');

  /**
   * Loads the current user from the database (if not already loaded) and
   * stores it on `req.user`.  Does NOT reject unauthenticated requests —
   * use `requireAuth` / `requireActiveUser` / `requireRole` for that.
   */
  function loadCurrentUser(req, res, next) {
    if (req.user) return next(); // already loaded upstream
    if (!req.session.userId) return next();
    const user = stmtGetUserForAuth.get(req.session.userId);
    if (user) req.user = user;
    next();
  }

  function requireAuth(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: 'Не авторизован' });
    next();
  }

  /**
   * Invalidate all sessions for a given user ID.
   * Opens the sessions.sqlite database and deletes matching rows.
   */
  function invalidateUserSessions(userId) {
    try {
      const sessionsDbPath = path.join(__dirname, '..', 'sessions.sqlite');
      if (!fs.existsSync(sessionsDbPath)) return;
      const Database = require('better-sqlite3');
      const sessDb = new Database(sessionsDbPath, { timeout: 5000 });
      // connect-sqlite3 stores session data as JSON string in `sess` column
      // Use SQLite's json_extract to filter at the database level for efficiency
      sessDb.prepare(
        "DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?"
      ).run(userId);
      sessDb.close();
    } catch (e) {
      console.error('[Session] Failed to invalidate sessions for user', userId, ':', e.message);
    }
  }

  function requireActiveUser(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: 'Не авторизован' });
    // Reuse req.user if already loaded to avoid a redundant DB query
    const user = req.user || stmtGetUserForAuth.get(req.session.userId);
    if (!user) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Не авторизован' });
    }
    // Attach to req so downstream middleware can reuse without re-querying
    if (!req.user) req.user = user;
    if (user.status === 'deleted') {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Не авторизован' });
    }
    const block = getAccessBlockReason(user.status);
    if (block) {
      return res.status(403).json({ error: block.code, message: block.message });
    }
    next();
  }

  /**
   * Returns a middleware that requires the current user to be authenticated,
   * active, and to hold at least one of the given roles.
   *
   * @param {...string} roles - One or more acceptable role strings (e.g. 'admin', 'moderator').
   * @returns {import('express').RequestHandler}
   */
  function requireRole(...roles) {
    return function checkRole(req, res, next) {
      if (!req.session.userId) return res.status(401).json({ error: 'Не авторизован' });
      const user = req.user || stmtGetUserForAuth.get(req.session.userId);
      if (!user) {
        req.session.destroy(() => {});
        return res.status(401).json({ error: 'Не авторизован' });
      }
      if (!req.user) req.user = user;
      if (user.status === 'deleted') {
        req.session.destroy(() => {});
        return res.status(401).json({ error: 'Не авторизован' });
      }
      const block = getAccessBlockReason(user.status);
      if (block) {
        return res.status(403).json({ error: block.code, message: block.message });
      }
      if (!hasRequiredRole(user.role, roles)) {
        return res.status(403).json({ error: 'forbidden', message: 'Недостаточно прав' });
      }
      next();
    };
  }


  // --- Login failure lockout (in-memory per IP) ---
  // NOTE: Resets on server restart. Sufficient for single-process Pi deployment.
  // For multi-instance production, persist to DB or Redis.
  const loginFailures = new Map(); // ip -> { count, lockUntil }
  const MAX_LOGIN_FAILS = 10;
  const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

  function getLoginLockout(ip) {
    const entry = loginFailures.get(ip);
    if (!entry || !entry.lockUntil) return null;
    if (Date.now() >= entry.lockUntil) {
      loginFailures.delete(ip);
      return null;
    }
    const remaining = Math.ceil((entry.lockUntil - Date.now()) / 60000);
    return `Слишком много попыток входа. Аккаунт временно заблокирован. Попробуйте через ${remaining} мин.`;
  }

  function recordLoginFailure(ip) {
    const entry = loginFailures.get(ip) || { count: 0, lockUntil: null };
    entry.count += 1;
    if (entry.count >= MAX_LOGIN_FAILS) {
      entry.lockUntil = Date.now() + LOCKOUT_DURATION_MS;
      entry.count = 0;
    }
    loginFailures.set(ip, entry);
  }

  function clearLoginFailures(ip) {
    loginFailures.delete(ip);
  }

  // --- Dev maps ---
  // In non-production environments, keep the last verification URL per normalised email
  // so the /api/dev/verification-link endpoint can return it when SMTP is unavailable.
  const _devVerificationLinks = process.env.NODE_ENV !== 'production' ? new Map() : null;

  // In non-production environments, keep the last magic link URL per normalised email
  // so the /api/dev/magic-link endpoint can return it when SMTP is unavailable.
  const _devMagicLinks = process.env.NODE_ENV !== 'production' ? new Map() : null;

  // In non-production environments, keep the last password reset URL per normalised email
  // so the /api/dev/reset-link endpoint can return it when SMTP is unavailable.
  const _devResetLinks = process.env.NODE_ENV !== 'production' ? new Map() : null;

  // --- Token helpers ---
  function createVerificationToken(userId) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(userId);
    db.prepare(
      'INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
    ).run(userId, tokenHash, expiresAt);
    return rawToken;
  }

  function createPasswordResetToken(userId) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(userId);
    db.prepare(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
    ).run(userId, tokenHash, expiresAt);
    return rawToken;
  }

  function createMagicLinkToken(email) {
    const emailNorm = normalizeEmail(email);
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes
    db.prepare('DELETE FROM magic_links WHERE email = ? AND used_at IS NULL').run(emailNorm);
    db.prepare(
      'INSERT INTO magic_links (email, token_hash, expires_at) VALUES (?, ?, ?)'
    ).run(emailNorm, tokenHash, expiresAt);
    return rawToken;
  }

  // --- Mailer helpers ---
  function sendVerificationEmail(email, token, req) {
    const baseUrl = process.env.APP_BASE_URL ||
      (req ? `${req.protocol}://${req.get('host')}` : `http://localhost:${PORT}`);
    const verifyUrl = `${baseUrl}/verify-email?token=${token}`;
    const subject = 'Подтвердите email — Riley at the Rally';
    const text = `Здравствуйте!\n\nДля подтверждения вашего email перейдите по ссылке:\n${verifyUrl}\n\nСсылка действительна 24 часа.\n\nЕсли вы не регистрировались на нашем сайте, просто проигнорируйте это письмо.`;
    const html = `<p>Здравствуйте!</p><p>Для подтверждения вашего email перейдите по ссылке:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>Ссылка действительна 24 часа.</p><p>Если вы не регистрировались на нашем сайте, просто проигнорируйте это письмо.</p>`;
    if (_devVerificationLinks) {
      _devVerificationLinks.set(normalizeEmail(email), verifyUrl);
    }
    mailer.sendMail({ to: email, subject, text, html }).catch((err) => {
      console.error('[Mailer] Failed to send verification email:', err.message);
      if (_devVerificationLinks) {
        console.error('[Mailer] Tip: set DISABLE_EMAIL=true to print links to console, or fix SMTP env vars (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS) in .env');
        console.error(`[Mailer] Verification link (dev only): ${verifyUrl}`);
      }
    });
  }

  function sendPasswordResetEmail(email, token, req) {
    const baseUrl = process.env.APP_BASE_URL ||
      (req ? `${req.protocol}://${req.get('host')}` : `http://localhost:${PORT}`);
    const resetUrl = `${baseUrl}/reset-password?token=${token}`;
    const subject = 'Сброс пароля — Riley at the Rally';
    const text = `Здравствуйте!\n\nДля сброса пароля перейдите по ссылке:\n${resetUrl}\n\nСсылка действительна 1 час.\n\nЕсли вы не запрашивали сброс пароля, просто проигнорируйте это письмо.`;
    const html = `<p>Здравствуйте!</p><p>Для сброса пароля перейдите по ссылке:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>Ссылка действительна 1 час.</p><p>Если вы не запрашивали сброс пароля, просто проигнорируйте это письмо.</p>`;
    if (_devResetLinks) {
      _devResetLinks.set(normalizeEmail(email), resetUrl);
    }
    mailer.sendMail({ to: email, subject, text, html }).catch((err) => {
      console.error('[Mailer] Failed to send password reset email:', err.message);
      if (_devResetLinks) {
        console.error('[Mailer] Tip: set DISABLE_EMAIL=true to print links to console, or fix SMTP env vars.');
        console.error(`[Mailer] Password reset link (dev only): ${resetUrl}`);
      }
    });
  }

  function sendMagicLinkEmail(email, token, req) {
    const baseUrl = process.env.APP_BASE_URL ||
      (req ? `${req.protocol}://${req.get('host')}` : `http://localhost:${PORT}`);
    const magicUrl = `${baseUrl}/auth/magic?token=${token}`;
    const subject = 'Вход в Riley at the Rally';
    const text = `Здравствуйте!\n\nДля входа на сайт перейдите по ссылке:\n${magicUrl}\n\nСсылка действительна 15 минут и может быть использована только один раз.\n\nЕсли вы не запрашивали эту ссылку, просто проигнорируйте это письмо.`;
    const html = `<p>Здравствуйте!</p><p>Для входа на сайт перейдите по ссылке:</p><p><a href="${magicUrl}">${magicUrl}</a></p><p>Ссылка действительна <strong>15 минут</strong> и может быть использована только один раз.</p><p>Если вы не запрашивали эту ссылку, просто проигнорируйте это письмо.</p>`;
    if (_devMagicLinks) {
      _devMagicLinks.set(normalizeEmail(email), magicUrl);
    }
    mailer.sendMail({ to: email, subject, text, html }).catch((err) => {
      console.error('[Mailer] Failed to send magic link email:', err.message);
      if (_devMagicLinks) {
        console.error('[Mailer] Tip: set DISABLE_EMAIL=true to print links to console, or fix SMTP env vars.');
        console.error(`[Mailer] Magic link (dev only): ${magicUrl}`);
      }
    });
  }

  // --- Routes ---

  app.get('/api/csrf-token', (req, res) => {
    if (!req.session.csrfToken) {
      req.session.csrfToken = generateCsrfToken();
    }
    res.json({ csrfToken: req.session.csrfToken });
  });

  // --- Auth routes ---
  app.post('/api/auth/register', registerLimiter, csrfMiddleware, (req, res) => {
    const body = req.body || {};
    const rawUsername = typeof body.username === 'string' ? body.username : '';
    const rawEmail = typeof body.email === 'string' ? body.email : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const confirmPassword = typeof body.confirm_password === 'string' ? body.confirm_password : undefined;

    // Field-specific validation
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
      const hash = bcrypt.hashSync(password, 12);

      const insertUser = db.prepare(
        `INSERT INTO users
           (username, username_normalized, email, email_normalized, password_hash, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`
      );

      let userId;
      db.transaction(() => {
        const result = insertUser.run(username, usernameNorm, rawEmail.trim(), emailNorm, hash);
        userId = result.lastInsertRowid;
      })();

      // Generate email verification token
      const verifyToken = createVerificationToken(userId);
      sendVerificationEmail(emailNorm, verifyToken, req);

      // Regenerate session to prevent session fixation
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

  app.post('/api/auth/login', loginLimiter, csrfMiddleware, (req, res) => {
    const body = req.body || {};
    // Accept either 'identifier' (username or email) or legacy 'email' field
    const rawIdentifier = typeof body.identifier === 'string' ? body.identifier
      : typeof body.email === 'string' ? body.email : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!rawIdentifier || !password) {
      return res.status(400).json({ error: 'Имя пользователя/email и пароль обязательны' });
    }

    const clientIp = req.ip;
    const lockoutMsg = getLoginLockout(clientIp);
    if (lockoutMsg) return res.status(429).json({ error: lockoutMsg });

    // Try to find user by email_normalized first, then by username_normalized
    const identifierNorm = rawIdentifier.trim().toLowerCase();
    let user = db.prepare('SELECT * FROM users WHERE email_normalized = ?').get(identifierNorm);
    if (!user) {
      user = db.prepare('SELECT * FROM users WHERE username_normalized = ?').get(identifierNorm);
    }

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
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
  });

  app.post('/api/auth/logout', csrfMiddleware, (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
  });

  // --- Magic Link authentication ---
  app.post('/api/auth/magic-link', magicLinkLimiter, csrfMiddleware, (req, res) => {
    const body = req.body || {};
    const rawEmail = typeof body.email === 'string' ? body.email : '';

    const emailErr = validateEmail(rawEmail);
    if (emailErr) {
      return res.status(400).json({ error: emailErr });
    }

    const emailNorm = normalizeEmail(rawEmail);
    try {
      const rawToken = createMagicLinkToken(emailNorm);
      sendMagicLinkEmail(emailNorm, rawToken, req);
    } catch (e) {
      console.error('[magic-link] Error creating/sending magic link:', e.message);
    }

    // Always return success — do not leak whether email exists
    res.json({ success: true, message: 'Если этот email зарегистрирован или является новым, вы получите письмо со ссылкой для входа.' });
  });

  // Magic link verification route — server-side redirect on success/failure
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

    // Mark token as used
    db.prepare('UPDATE magic_links SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(record.id);

    const emailNorm = record.email;

    // Find or create user
    let user = db.prepare('SELECT * FROM users WHERE email_normalized = ?').get(emailNorm);

    if (!user) {
      // Auto-register: generate username from email local part
      let baseUsername = (emailNorm.split('@')[0].replace(/[^a-z0-9_]/gi, '') || 'user').slice(0, 28);
      let username = baseUsername;
      // Ensure uniqueness — prepare statement once outside the loop
      const checkUsername = db.prepare('SELECT id FROM users WHERE username_normalized = ?');
      while (checkUsername.get(username.toLowerCase())) {
        username = baseUsername + Math.floor(1000 + Math.random() * 9000);
      }
      try {
        const result = db.prepare(
          `INSERT INTO users (username, username_normalized, email, email_normalized, password_hash, status)
           VALUES (?, ?, ?, ?, '', 'active')`
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
      // Validate redirect: must be a relative path (starts with / but not //)
      const rawRedirect = typeof req.query.redirect === 'string' ? req.query.redirect : '';
      const redirect = (rawRedirect.startsWith('/') && !rawRedirect.startsWith('//'))
        ? rawRedirect
        : '/garage';
      res.redirect(redirect);
    });
  });

  app.get('/api/auth/me', apiReadLimiter, (req, res) => {
    if (!req.session.userId) return res.json({ user: null });
    const user = db
      .prepare('SELECT id, username, email, avatar_path, status, role, created_at FROM users WHERE id = ?')
      .get(req.session.userId);
    // Intentionally checks specific statuses rather than getAccessBlockReason():
    // 'pending' users must keep their session to show the verify-email UI and
    // resend verification emails.  Only permanently blocked/removed statuses
    // should have their session destroyed and treated as logged-out.
    if (!user || user.status === 'deleted' || user.status === 'banned' || user.status === 'disabled') {
      req.session.destroy(() => {});
      return res.json({ user: null });
    }
    res.json({ user });
  });

  // --- Email verification ---
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

  // --- Password reset ---
  app.post('/api/auth/forgot-password', forgotPasswordLimiter, csrfMiddleware, (req, res) => {
    const body = req.body || {};
    const rawEmail = typeof body.email === 'string' ? body.email : '';

    // Always respond with success to prevent email enumeration
    const successResponse = () =>
      res.json({ success: true, message: 'Если этот email зарегистрирован, вы получите письмо со ссылкой для сброса пароля.' });

    if (!rawEmail) return successResponse();

    const emailNorm = rawEmail.trim().toLowerCase();
    const user = db
      .prepare('SELECT id, email, email_normalized FROM users WHERE email_normalized = ?')
      .get(emailNorm);

    if (user) {
      const token = createPasswordResetToken(user.id);
      sendPasswordResetEmail(user.email_normalized || user.email, token, req);
    }

    successResponse();
  });

  app.post('/api/auth/reset-password', resetPasswordLimiter, csrfMiddleware, (req, res) => {
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

    const newHash = bcrypt.hashSync(password, 12);
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newHash, record.user_id);
      db.prepare('DELETE FROM password_reset_tokens WHERE id = ?').run(record.id);
    })();

    // Invalidate all existing sessions for this user
    invalidateUserSessions(record.user_id);

    res.json({ success: true, message: 'Пароль успешно изменён. Теперь вы можете войти с новым паролем.' });
  });

  // --- Profile routes ---
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

  app.post('/api/profile/avatar', requireAuth, avatarUploadLimiter, csrfMiddleware, upload.single('avatar'), validateMagicBytes, (req, res) => {
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

  const USERNAME_CHANGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  app.patch('/api/profile/username', requireAuth, usernameChangeLimiter, csrfMiddleware, (req, res) => {
    const body = req.body || {};
    const rawUsername = typeof body.username === 'string' ? body.username : '';

    const usernameErr = validateUsername(rawUsername);
    if (usernameErr) return res.status(400).json({ error: usernameErr });

    const newUsername = normalizeText(rawUsername);
    const newUsernameNorm = normalizeUsername(rawUsername);

    const userId = req.session.userId;

    // Check uniqueness (excluding current user)
    const existing = db.prepare('SELECT id FROM users WHERE username_normalized = ? AND id != ?').get(newUsernameNorm, userId);
    if (existing) return res.status(400).json({ error: 'Это имя пользователя уже занято' });

    // Check cooldown (7 days)
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

  return { requireAuth, requireActiveUser, loadCurrentUser, requireRole, invalidateUserSessions, _devVerificationLinks, _devMagicLinks, _devResetLinks };
};
