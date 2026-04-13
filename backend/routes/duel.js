'use strict';

/**
 * Mount duel read-only REST routes onto `app`.
 *
 * Routes:
 *   GET /api/duel/status   — current duel status for the authenticated user
 *   GET /api/duel/history  — last 20 duel results for the authenticated user
 *
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {{ requireAuth: Function, requireActiveUser: Function, apiReadLimiter: Function, getDuelManager: Function }} deps
 */
module.exports = function mountDuelRoutes(app, db, deps) {
  const { requireActiveUser, apiReadLimiter, getDuelManager } = deps;

  /**
   * GET /api/duel/status
   * Returns the current duel status for the authenticated user.
   *
   * Response shape:
   *   { status: 'none'|'searching'|'matched'|'in_progress'|'finished' }
   */
  app.get('/api/duel/status', requireActiveUser, apiReadLimiter, (req, res) => {
    try {
      const userId = req.session.userId;
      const duelManager = getDuelManager();
      const status = duelManager ? duelManager.getDuelStatus(userId) : 'none';
      return res.json({ status });
    } catch (_e) {
      return res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
    }
  });

  /**
   * GET /api/duel/history
   * Returns the last 20 duel results involving the authenticated user,
   * newest first.
   *
   * Response shape:
   *   { history: Array<{ id, raceId, resultType, winnerId, loserId,
   *                       winnerLapTimeMs, loserLapTimeMs, createdAt,
   *                       isWin: boolean }> }
   */
  app.get('/api/duel/history', requireActiveUser, apiReadLimiter, (req, res) => {
    try {
      const userId = req.session.userId;

      const rows = db
        .prepare(
          `SELECT id, race_id, result_type, winner_id, loser_id,
                  winner_lap_time_ms, loser_lap_time_ms, created_at
           FROM duel_results
           WHERE winner_id = ? OR loser_id = ?
           ORDER BY created_at DESC
           LIMIT 20`,
        )
        .all(userId, userId);

      const history = rows.map((r) => ({
        id: r.id,
        raceId: r.race_id,
        resultType: r.result_type,
        winnerId: r.winner_id,
        loserId: r.loser_id,
        winnerLapTimeMs: r.winner_lap_time_ms,
        loserLapTimeMs: r.loser_lap_time_ms,
        createdAt: r.created_at,
        isWin: r.winner_id === userId,
      }));

      return res.json({ history });
    } catch (_e) {
      return res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
    }
  });
};
