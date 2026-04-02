'use strict';

const { getRankDisplay, normalizeRankState } = require('../lib/rank-system');

/**
 * Mount read-only rank routes onto `app`.
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {{ requireAuth, apiReadLimiter }} deps
 */
module.exports = function mountRankRoutes(app, db, deps) {
  const { requireAuth, apiReadLimiter } = deps;

  /**
   * GET /api/profile/rank
   * Returns the current user's rank, stars, legend status, duel record, and display data.
   */
  app.get('/api/profile/rank', requireAuth, apiReadLimiter, (req, res) => {
    try {
      const userId = req.session.userId;
      const row = db.prepare(
        `SELECT rank, stars, is_legend, legend_position, duels_won, duels_lost
         FROM users WHERE id = ?`
      ).get(userId);

      if (!row) return res.status(404).json({ error: 'Пользователь не найден.' });

      const state = normalizeRankState({
        rank: row.rank,
        stars: row.stars,
        isLegend: Boolean(row.is_legend),
        legendPosition: row.legend_position,
      });

      return res.json({
        rank: state.rank,
        stars: state.stars,
        isLegend: state.isLegend,
        legendPosition: state.legendPosition,
        duelsWon: row.duels_won || 0,
        duelsLost: row.duels_lost || 0,
        display: getRankDisplay(state),
      });
    } catch (e) {
      return res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
    }
  });

  /**
   * GET /api/rankings
   * Public read — returns sorted non-Legend ladder and Legend list.
   */
  app.get('/api/rankings', apiReadLimiter, (req, res) => {
    try {
      const ladderRows = db.prepare(
        `SELECT id, username, display_name, avatar_path,
                rank, stars, duels_won, duels_lost
         FROM users
         WHERE is_legend = 0 AND status = 'active' AND deleted_at IS NULL
         ORDER BY rank ASC, stars DESC, duels_won DESC, id ASC`
      ).all();

      const legendRows = db.prepare(
        `SELECT id, username, display_name, avatar_path,
                rank, stars, legend_position, duels_won, duels_lost
         FROM users
         WHERE is_legend = 1 AND status = 'active' AND deleted_at IS NULL
         ORDER BY legend_position ASC`
      ).all();

      const ladder = ladderRows.map((r) => {
        const state = normalizeRankState({ rank: r.rank, stars: r.stars, isLegend: false, legendPosition: null });
        return {
          id: r.id,
          username: r.username,
          displayName: r.display_name || r.username,
          avatarPath: r.avatar_path || null,
          rank: state.rank,
          stars: state.stars,
          duelsWon: r.duels_won || 0,
          duelsLost: r.duels_lost || 0,
          display: getRankDisplay(state),
        };
      });

      const legend = legendRows.map((r) => {
        const state = normalizeRankState({ rank: r.rank, stars: r.stars, isLegend: true, legendPosition: r.legend_position });
        return {
          id: r.id,
          username: r.username,
          displayName: r.display_name || r.username,
          avatarPath: r.avatar_path || null,
          legendPosition: r.legend_position,
          duelsWon: r.duels_won || 0,
          duelsLost: r.duels_lost || 0,
          display: getRankDisplay(state),
        };
      });

      return res.json({ ladder, legend });
    } catch (e) {
      return res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
    }
  });
};
