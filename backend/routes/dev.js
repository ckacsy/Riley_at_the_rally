'use strict';

const crypto = require('crypto');
const { MIN_LAP_TIME_MS } = require('../lib/rank-config');

module.exports = function mountDevRoutes(app, db, deps) {
  if (process.env.NODE_ENV === 'production') return;

  const {
    socketState,
    normalizeEmail,
    normalizeUsername,
    isKnownRole,
    STATUSES,
    _devVerificationLinks,
    _devMagicLinks,
    _devResetLinks,
    invalidateUserSessions,
    adminRouteDeps,
    csrfMiddleware,
    createRateLimiter,
    DB_PATH,
  } = deps;

  const devLimiter = createRateLimiter({ max: 20, message: 'Too many requests from this IP, please try again later.' });

  app.get('/api/dev/verification-link', devLimiter, (req, res) => {
    const rawEmail = typeof req.query.email === 'string' ? req.query.email.trim() : '';
    if (!rawEmail) {
      return res.status(400).json({ error: 'Query param "email" is required' });
    }
    const emailNorm = normalizeEmail(rawEmail);
    const user = db
      .prepare('SELECT id, username, status FROM users WHERE email_normalized = ?')
      .get(emailNorm);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (user.status !== 'pending') {
      return res.status(400).json({ error: 'Account is already verified', status: user.status });
    }
    const link = _devVerificationLinks && _devVerificationLinks.get(emailNorm);
    if (!link) {
      return res.status(404).json({
        error: 'No verification link in memory. Try resending from the profile page (POST /api/auth/resend-verification) -- the new link will be stored here.',
      });
    }
    return res.json({ verificationLink: link });
  });

  app.get('/api/dev/magic-link', devLimiter, (req, res) => {
    const rawEmail = typeof req.query.email === 'string' ? req.query.email.trim() : '';
    if (!rawEmail) {
      return res.status(400).json({ error: 'Query param "email" is required' });
    }
    const emailNorm = normalizeEmail(rawEmail);
    const link = _devMagicLinks && _devMagicLinks.get(emailNorm);
    if (!link) {
      return res.status(404).json({
        error: 'No magic link in memory. Request a magic link first via POST /api/auth/magic-link.',
      });
    }
    return res.json({ magicLink: link });
  });

  app.get('/api/dev/reset-link', devLimiter, (req, res) => {
    const rawEmail = typeof req.query.email === 'string' ? req.query.email.trim() : '';
    if (!rawEmail) {
      return res.status(400).json({ error: 'Query param "email" is required' });
    }
    const emailNorm = normalizeEmail(rawEmail);
    const link = _devResetLinks && _devResetLinks.get(emailNorm);
    if (!link) {
      return res.status(404).json({
        error: 'No reset link in memory. Request a password reset first via POST /api/auth/forgot-password.',
      });
    }
    return res.json({ resetLink: link });
  });

  app.post('/api/dev/reset-db', (req, res) => {
    try {
      db.transaction(() => {
        db.exec('DELETE FROM email_verification_tokens');
        db.exec('DELETE FROM password_reset_tokens');
        db.exec('DELETE FROM magic_links');
        db.exec('DELETE FROM lap_times');
        db.exec('DELETE FROM rental_sessions');
        db.exec('DELETE FROM chat_messages');
        db.exec('DELETE FROM transactions');
        db.exec('DELETE FROM payment_orders');
        db.exec('DELETE FROM news');
        db.exec('DELETE FROM admin_audit_log');
        db.exec('DELETE FROM daily_checkins');
        db.exec('DELETE FROM users');
        db.exec('DELETE FROM car_maintenance');
        db.exec('DELETE FROM player_ranks');
        db.exec('DELETE FROM duel_results');
        db.exec('DELETE FROM pending_recovery');
        db.exec("DELETE FROM sqlite_sequence WHERE name IN ('users','lap_times','rental_sessions','email_verification_tokens','password_reset_tokens','chat_messages','magic_links','transactions','payment_orders','news','admin_audit_log','daily_checkins','player_ranks','duel_results','pending_recovery')");
      })();
      req.session.destroy((err) => { if (err) console.error('Session destroy error:', err); });
      if (_devVerificationLinks) _devVerificationLinks.clear();
      if (_devMagicLinks) _devMagicLinks.clear();
      if (_devResetLinks) _devResetLinks.clear();
      for (const [sid] of socketState.activeSessions) {
        socketState.clearInactivityTimeout(sid);
        socketState.clearSessionDurationTimeout(sid);
      }
      socketState.activeSessions.clear();
      socketState.raceRooms.clear();
      for (const timer of socketState.presenceGraceTimers.values()) clearTimeout(timer);
      socketState.presenceGraceTimers.clear();
      socketState.presenceMap.clear();
      socketState.broadcastPresenceUpdate();
      socketState.chatRateLimits.clear();
      if (socketState.duelManager) socketState.duelManager.clear();
      socketState.broadcastCarsUpdate();
      console.log('[DEV] Database reset: all users and sessions deleted.');
      res.json({ success: true, message: 'Database reset: all users, sessions and tokens deleted.' });
    } catch (e) {
      console.error('Dev reset error:', e.message);
      res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
    }
  });

  app.post('/api/dev/rental-sessions/insert', devLimiter, (req, res) => {
    const { user_id, car_id, car_name, duration_seconds, cost, session_ref } = req.body || {};
    if (!user_id || !car_id) return res.status(400).json({ error: 'user_id and car_id required' });
    const result = db.prepare(
      'INSERT INTO rental_sessions (user_id, car_id, car_name, duration_seconds, cost, session_ref) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      Number(user_id),
      Number(car_id),
      car_name || ('Машина #' + car_id),
      Number(duration_seconds) || 0,
      Number(cost) || 0,
      session_ref || null
    );
    const row = db.prepare('SELECT * FROM rental_sessions WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, session: row });
  });

  app.post('/api/dev/inject-active-session', devLimiter, (req, res) => {
    const { carId, dbUserId: injectedDbUserId, socketId } = req.body || {};
    if (!carId) return res.status(400).json({ error: 'carId required' });
    if (socketId && injectedDbUserId != null) {
      for (const [key, sess] of socketState.activeSessions) {
        if (sess.dbUserId === Number(injectedDbUserId) && key.startsWith('dev-injected-')) {
          socketState.activeSessions.delete(key);
        }
      }
    }
    const key = socketId || `dev-injected-${carId}-${Date.now()}`;
    socketState.activeSessions.set(key, {
      carId: Number(carId),
      userId: 'dev-test',
      dbUserId: injectedDbUserId != null ? Number(injectedDbUserId) : 0,
      startTime: new Date(),
      holdAmount: 0,
      sessionRef: crypto.randomUUID(),
    });
    res.json({ success: true, sessionId: key });
  });

  app.post('/api/dev/transactions/insert', devLimiter, (req, res) => {
    const { user_id, type, amount, balance_after, description, reference_id, admin_id, created_at } = req.body || {};
    if (!user_id || !type || amount === undefined || balance_after === undefined) {
      return res.status(400).json({ error: 'user_id, type, amount, balance_after required' });
    }
    let result;
    if (created_at && typeof created_at === 'string') {
      result = db.prepare(
        'INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id, admin_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        Number(user_id), String(type), Number(amount), Number(balance_after),
        description || null, reference_id || null, admin_id ? Number(admin_id) : null, created_at,
      );
    } else {
      result = db.prepare(
        'INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id, admin_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        Number(user_id), String(type), Number(amount), Number(balance_after),
        description || null, reference_id || null, admin_id ? Number(admin_id) : null
      );
    }
    const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, transaction: row });
  });

  app.post('/api/dev/activate-user', devLimiter, (req, res) => {
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username required' });
    const usernameNorm = normalizeUsername(username);
    const result = db
      .prepare("UPDATE users SET status = 'active', balance = 200, updated_at = CURRENT_TIMESTAMP WHERE username_normalized = ?")
      .run(usernameNorm);
    if (result.changes === 0) {
      if (process.env.NODE_ENV === 'test') {
        console.log(`[DEV] activate-user: not found for username_normalized='${usernameNorm}', DB_PATH=${DB_PATH}`);
      }
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ success: true });
  });

  app.post('/api/dev/set-user-status', devLimiter, (req, res) => {
    const { username, status } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username required' });
    if (typeof status !== 'string' || (!Object.values(STATUSES).includes(status) && status !== 'disabled')) {
      return res.status(400).json({ error: 'valid status required' });
    }
    const usernameNorm = normalizeUsername(username);
    const result = db
      .prepare('UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE username_normalized = ?')
      .run(status, usernameNorm);
    if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
    const user = db
      .prepare('SELECT id, username, status, role FROM users WHERE username_normalized = ?')
      .get(usernameNorm);
    res.json({ success: true, user });
  });

  app.post('/api/dev/set-user-role', devLimiter, (req, res) => {
    const { username, role } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username required' });
    if (typeof role !== 'string' || !isKnownRole(role)) {
      return res.status(400).json({ error: 'valid role required' });
    }
    const usernameNorm = normalizeUsername(username);
    const result = db
      .prepare('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE username_normalized = ?')
      .run(role, usernameNorm);
    if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
    const user = db
      .prepare('SELECT id, username, status, role FROM users WHERE username_normalized = ?')
      .get(usernameNorm);
    res.json({ success: true, user });
  });

  app.get('/api/dev/role-probe/admin', devLimiter, adminRouteDeps.requireRole('admin'), (req, res) => {
    res.json({
      success: true,
      user: req.user ? {
        id: req.user.id,
        username: req.user.username,
        status: req.user.status,
        role: req.user.role,
      } : null,
    });
  });

  app.post('/api/dev/admin-audit-log/write', devLimiter, adminRouteDeps.requireRole('admin'), csrfMiddleware, (req, res) => {
    const { action, targetType, targetId, details } = req.body || {};
    if (!action || typeof action !== 'string') return res.status(400).json({ error: 'action required' });
    if (!targetType || typeof targetType !== 'string') return res.status(400).json({ error: 'targetType required' });
    const targetIdAsNumber = Number(targetId);
    adminRouteDeps.logAdminAudit({
      adminId: req.user.id,
      action,
      targetType,
      targetId: Number.isInteger(targetIdAsNumber) ? targetIdAsNumber : null,
      details: details && typeof details === 'object' ? details : null,
      ipAddress: req.ip || null,
      userAgent: req.get('user-agent') || null,
    });
    const row = db.prepare(
      `SELECT id, admin_id, action, target_type, target_id, details_json, ip_address, user_agent, created_at
         FROM admin_audit_log
        WHERE admin_id = ? AND action = ? AND target_type = ?
        ORDER BY id DESC LIMIT 1`
    ).get(req.user.id, action, targetType);
    res.json({ success: true, row });
  });

  app.post('/api/dev/insert-reset-token', devLimiter, (req, res) => {
    const { email, expiresAt } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const emailNorm = email.trim().toLowerCase();
    const user = db.prepare('SELECT id FROM users WHERE email_normalized = ?').get(emailNorm);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const exp = expiresAt || new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id);
    db.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(user.id, tokenHash, exp);
    res.json({ success: true, token: rawToken });
  });

  app.post('/api/dev/inject-checkin', devLimiter, (req, res) => {
    const { userId, checkinDate, streakCount, cycleDay, rewardAmount } = req.body || {};
    if (!userId || !checkinDate || streakCount == null || cycleDay == null || rewardAmount == null) {
      return res.status(400).json({ error: 'userId, checkinDate, streakCount, cycleDay, rewardAmount required' });
    }
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    try {
      db.prepare(
        `INSERT OR REPLACE INTO daily_checkins (user_id, checkin_date, cycle_day, streak_count, reward_amount, schedule_version) VALUES (?, ?, ?, ?, ?, 1)`
      ).run(userId, checkinDate, cycleDay, streakCount, rewardAmount);
      res.json({ success: true });
    } catch (err) {
      console.error('[DEV] set-daily-checkin error:', err.message);
      res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
    }
  });

  app.post('/api/dev/set-user-rank', devLimiter, (req, res) => {
    const { username, rank, stars, is_legend, legend_position } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username required' });
    const usernameNorm = normalizeUsername(username);
    const user = db.prepare('SELECT id FROM users WHERE username_normalized = ?').get(usernameNorm);
    if (!user) return res.status(404).json({ error: 'User not found' });
    db.prepare(
      `UPDATE users SET rank = ?, stars = ?, is_legend = ?, legend_position = ? WHERE id = ?`
    ).run(
      rank != null ? Number(rank) : 15,
      stars != null ? Number(stars) : 0,
      is_legend ? 1 : 0,
      legend_position != null ? Number(legend_position) : null,
      user.id,
    );
    res.json({ success: true });
  });

  app.post('/api/dev/rewind-lap-start', devLimiter, (req, res) => {
    const { dbUserId } = req.body || {};
    if (!dbUserId) return res.status(400).json({ error: 'dbUserId required' });
    const dm = socketState && socketState.duelManager;
    if (!dm) return res.status(503).json({ error: 'duel manager not ready' });
    const duel = dm.getDuelByUserId(Number(dbUserId));
    if (!duel) return res.status(404).json({ error: 'no active duel for user' });
    const player = duel.players.find((p) => p.dbUserId === Number(dbUserId));
    if (!player) return res.status(404).json({ error: 'player not found in duel' });
    if (!player.lapStarted) return res.status(409).json({ error: 'lap not started yet' });
    player.currentLapStart -= MIN_LAP_TIME_MS + 5000;
    res.json({ success: true });
  });

  app.post('/api/dev/trigger-duel-timeout-for-user', devLimiter, (req, res) => {
    const { dbUserId } = req.body || {};
    if (!dbUserId) return res.status(400).json({ error: 'dbUserId required' });
    const dm = socketState && socketState.duelManager;
    if (!dm) return res.status(503).json({ error: 'duel manager not ready' });
    const duel = dm.getDuelByUserId(Number(dbUserId));
    if (!duel) return res.status(404).json({ error: 'no active duel for user' });
    dm._handleDuelTimeout(duel.id);
    res.json({ success: true });
  });

  app.post('/api/dev/invalidate-user-sessions', devLimiter, (req, res) => {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    invalidateUserSessions(Number(userId));
    res.json({ success: true });
  });
};
