'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createRateLimiter } = require('../middleware/rateLimiter');
const mailer = require('../mailer');
const { hasRequiredRole, getAccessBlockReason } = require('../middleware/roles');
const {
  normalizeEmail,
} = require('../validators');

module.exports = function createAuthHelpers(db, deps) {
  const { PORT } = deps;

  // --- Rate limiters ---
  const registerLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 3, message: 'Слишком много регистраций. Попробуйте через час.' });
  const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5, message: 'Слишком много попыток входа. Попробуйте через 15 минут.' });
  const magicLinkLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 3, message: 'Слишком много запросов. Попробуйте через 15 минут.' });
  const magicVerifyLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20, message: 'Слишком много попыток. Попробуйте через 15 минут.' });
  const verifyResendLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 3, message: 'Слишком много запросов. Попробуйте через 15 минут.' });
  const forgotPasswordLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 3, message: 'Слишком много запросов сброса пароля. Попробуйте через 15 минут.' });
  const resetPasswordLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, message: 'Слишком много запросов. Попробуйте через 15 минут.' });
  const avatarUploadLimiter = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 5,
    keyGenerator: (req) => req.session && req.session.userId ? String(req.session.userId) : req.ip,
    message: 'Слишком много загрузок аватара. Попробуйте через час.',
  });
  const usernameChangeLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 3, message: 'Слишком много попыток смены имени. Попробуйте через час.' });

  const DUMMY_HASH = '$2b$12$000000000000000000000uGj5B3tCmkmzgELEj3TBuR2K/RMN2qhS';

  const stmtGetUserForAuth = db.prepare('SELECT id, username, email, status, role FROM users WHERE id = ?');

  function loadCurrentUser(req, res, next) {
    if (req.user) return next();
    if (!req.session.userId) return next();
    const user = stmtGetUserForAuth.get(req.session.userId);
    if (user) req.user = user;
    next();
  }

  function requireAuth(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: 'Не авторизован' });
    next();
  }

  function invalidateUserSessions(userId) {
    try {
      const sessionsDbPath = path.join(__dirname, '..', 'sessions.sqlite');
      if (!fs.existsSync(sessionsDbPath)) return;
      const { openDatabase } = require('../db/connection');
      const sessDb = openDatabase(sessionsDbPath, { timeout: 5000 });
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
    next();
  }

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

  const loginFailures = new Map();
  const MAX_LOGIN_FAILS = 5;
  const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

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

  const magicLinkEmailCooldowns = new Map();
  const MAGIC_LINK_EMAIL_COOLDOWN_MS = 60 * 1000;

  const forgotPasswordEmailCooldowns = new Map();
  const FORGOT_PASSWORD_EMAIL_COOLDOWN_MS = 5 * 60 * 1000;

  function isEmailInCooldown(map, emailNorm, windowMs) {
    const lastSent = map.get(emailNorm);
    if (!lastSent) return false;
    if (Date.now() - lastSent >= windowMs) {
      map.delete(emailNorm);
      return false;
    }
    return true;
  }

  const _devVerificationLinks = process.env.NODE_ENV !== 'production' ? new Map() : null;
  const _devMagicLinks = process.env.NODE_ENV !== 'production' ? new Map() : null;
  const _devResetLinks = process.env.NODE_ENV !== 'production' ? new Map() : null;

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
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
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
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    db.prepare('DELETE FROM magic_links WHERE email = ? AND used_at IS NULL').run(emailNorm);
    db.prepare(
      'INSERT INTO magic_links (email, token_hash, expires_at) VALUES (?, ?, ?)'
    ).run(emailNorm, tokenHash, expiresAt);
    return rawToken;
  }

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

  return {
    registerLimiter, loginLimiter, magicLinkLimiter, magicVerifyLimiter,
    verifyResendLimiter, forgotPasswordLimiter, resetPasswordLimiter,
    avatarUploadLimiter, usernameChangeLimiter,
    DUMMY_HASH,
    stmtGetUserForAuth,
    loadCurrentUser, requireAuth, requireActiveUser, requireRole, invalidateUserSessions,
    loginFailures, getLoginLockout, recordLoginFailure, clearLoginFailures,
    magicLinkEmailCooldowns, MAGIC_LINK_EMAIL_COOLDOWN_MS,
    forgotPasswordEmailCooldowns, FORGOT_PASSWORD_EMAIL_COOLDOWN_MS,
    isEmailInCooldown,
    _devVerificationLinks, _devMagicLinks, _devResetLinks,
    createVerificationToken, createPasswordResetToken, createMagicLinkToken,
    sendVerificationEmail, sendPasswordResetEmail, sendMagicLinkEmail,
  };
};
