'use strict';

module.exports = function mountLeaderboardRoutes(app, db, deps) {
  const { apiReadLimiter } = deps;

  app.get('/api/leaderboard', apiReadLimiter, (req, res) => {
    const range = req.query.range;
    const validRanges = ['all', 'week', 'day'];
    const selectedRange = validRanges.includes(range) ? range : 'all';

    const baseQuery = `SELECT lt.lap_time_ms AS lapTimeMs,
                lt.car_name   AS carName,
                lt.created_at AS date,
                COALESCE(u.username, CAST(lt.user_id AS TEXT)) AS userId
           FROM lap_times lt
      LEFT JOIN users u ON lt.user_id = u.id`;
    const orderLimit = `ORDER BY lt.lap_time_ms ASC LIMIT 10`;

    try {
      let rows;
      if (selectedRange === 'week') {
        rows = db
          .prepare(`${baseQuery} WHERE lt.created_at >= datetime('now', '-7 days') ${orderLimit}`)
          .all();
      } else if (selectedRange === 'day') {
        rows = db
          .prepare(`${baseQuery} WHERE lt.created_at >= datetime('now', '-1 day') ${orderLimit}`)
          .all();
      } else {
        rows = db
          .prepare(`${baseQuery} ${orderLimit}`)
          .all();
      }
      res.json({ leaderboard: rows, range: selectedRange });
    } catch (e) {
      console.error('Leaderboard query error:', e.message);
      res.status(500).json({ error: 'Не удалось загрузить таблицу рекордов.' });
    }
  });
};
