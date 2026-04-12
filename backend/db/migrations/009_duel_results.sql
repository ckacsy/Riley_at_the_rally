-- PR 3 (duel backend): duel_results table and indexes
CREATE TABLE IF NOT EXISTS duel_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER DEFAULT 1,
  race_id TEXT NOT NULL,
  winner_id INTEGER,
  loser_id INTEGER,
  result_type TEXT NOT NULL,
  winner_lap_time_ms INTEGER,
  loser_lap_time_ms INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_duel_results_race_id ON duel_results(race_id);
CREATE INDEX IF NOT EXISTS idx_duel_results_winner_id ON duel_results(winner_id);
CREATE INDEX IF NOT EXISTS idx_duel_results_loser_id ON duel_results(loser_id);
CREATE INDEX IF NOT EXISTS idx_duel_results_created_at ON duel_results(created_at);
