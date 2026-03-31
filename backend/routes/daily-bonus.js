'use strict';

const rateLimit = require('express-rate-limit');

const REWARD_SCHEDULE = [2, 3, 5, 5, 8, 10, 15];
const SCHEDULE_VERSION = 1;

function getUtcDateString(date) {
  return (date || new Date()).toISOString().slice(0, 10);
}

function getPreviousUtcDateString(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function getCycleDay(streakCount) {
  return ((streakCount - 1) % REWARD_SCHEDULE.length) + 1;
}

function getRewardForCycleDay(cycleDay) {
  return REWARD_SCHEDULE[cycleDay - 1] || REWARD_SCHEDULE[0];
}

/**
 * Mount daily bonus routes.
 *
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {{ requireAuth: Function, requireActiveUser: Function, csrfMiddleware: Function, apiReadLimiter: Function }} deps
 */
module.exports = function mountDailyBonusRoutes(app, db, { requireAuth, requireActiveUser, csrfMiddleware, apiReadLimiter }) {
  const dailyBonusReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много запросов. Попробуйте позже.' },
    keyGenerator: (req) => req.ip,
    skip: () => process.env.NODE_ENV === 'test',
  });

  const dailyBonusClaimLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много запросов. Попробуйте позже.' },
    keyGenerator: (req) => req.ip,
    skip: () => process.env.NODE_ENV === 'test',
  });

  // -------------------------------------------------------------------------
  // GET /api/daily-bonus/status
  // -------------------------------------------------------------------------
  app.get('/api/daily-bonus/status', dailyBonusReadLimiter, requireAuth, requireActiveUser, (req, res) => {
    const userId = req.session.userId;
    const today = getUtcDateString();

    const last = db.prepare(
      'SELECT checkin_date, streak_count, cycle_day FROM daily_checkins WHERE user_id = ? ORDER BY checkin_date DESC LIMIT 1'
    ).get(userId);

    const claimedToday = last ? last.checkin_date === today : false;

    let streakCount;
    if (!last) {
      streakCount = 1;
    } else if (last.checkin_date === today) {
      streakCount = last.streak_count;
    } else if (last.checkin_date === getPreviousUtcDateString(today)) {
      streakCount = last.streak_count + 1;
    } else {
      streakCount = 1;
    }

    const cycleDay = getCycleDay(streakCount);
    const todayReward = getRewardForCycleDay(cycleDay);
    const nextCycleDay = getCycleDay(streakCount + 1);
    const nextReward = getRewardForCycleDay(nextCycleDay);

    res.json({
      claimedToday,
      cycleDay,
      streakCount,
      todayReward,
      nextReward,
      serverDate: today,
      lastCheckinDate: last ? last.checkin_date : null,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/daily-bonus/claim
  // -------------------------------------------------------------------------
  app.post('/api/daily-bonus/claim', dailyBonusClaimLimiter, requireAuth, requireActiveUser, csrfMiddleware, (req, res) => {
    const userId = req.session.userId;
    const today = getUtcDateString();

    try {
      const result = db.transaction(() => {
        // 1. Check if already claimed today
        const existing = db.prepare(
          'SELECT id FROM daily_checkins WHERE user_id = ? AND checkin_date = ?'
        ).get(userId, today);
        if (existing) {
          return { alreadyClaimed: true };
        }

        // 2. Get last checkin to compute streak
        const last = db.prepare(
          'SELECT checkin_date, streak_count FROM daily_checkins WHERE user_id = ? ORDER BY checkin_date DESC LIMIT 1'
        ).get(userId);

        let streakCount;
        if (!last) {
          streakCount = 1;
        } else if (last.checkin_date === getPreviousUtcDateString(today)) {
          streakCount = last.streak_count + 1;
        } else {
          streakCount = 1;
        }

        // 3. Calculate cycleDay and reward
        const cycleDay = getCycleDay(streakCount);
        const reward = getRewardForCycleDay(cycleDay);

        // 4. INSERT into daily_checkins
        db.prepare(
          `INSERT INTO daily_checkins (user_id, checkin_date, cycle_day, streak_count, reward_amount, schedule_version)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(userId, today, cycleDay, streakCount, reward, SCHEDULE_VERSION);

        // 5. UPDATE users balance
        db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(reward, userId);

        // 6. Read new balance
        const userRow = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
        const balance = userRow ? userRow.balance : reward;

        // 7. INSERT into transactions
        db.prepare(
          `INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id)
           VALUES (?, 'daily_bonus', ?, ?, ?, ?)`
        ).run(userId, reward, balance, 'Ежедневный бонус (день ' + cycleDay + ')', 'daily_bonus:' + today);

        const nextCycleDay = getCycleDay(streakCount + 1);
        const nextReward = getRewardForCycleDay(nextCycleDay);

        return { alreadyClaimed: false, reward, cycleDay, streakCount, nextReward, balance };
      })();

      if (result.alreadyClaimed) {
        return res.status(409).json({ error: 'Бонус уже получен сегодня.', code: 'already_claimed' });
      }

      return res.json({
        claimed: true,
        reward: result.reward,
        cycleDay: result.cycleDay,
        streakCount: result.streakCount,
        nextReward: result.nextReward,
        balance: result.balance,
        serverDate: today,
      });
    } catch (err) {
      // Handle UNIQUE constraint violation as concurrent duplicate claim
      if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ error: 'Бонус уже получен сегодня.', code: 'already_claimed' });
      }
      console.error('[DailyBonus] claim error:', err);
      return res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
    }
  });
};
