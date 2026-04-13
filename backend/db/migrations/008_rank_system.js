// Rank foundation: ladder columns on users + player_ranks history table
module.exports = function (db) {
  const userCols = new Set(db.pragma('table_info(users)').map((c) => c.name));

  if (!userCols.has('rank')) {
    try { db.exec('ALTER TABLE users ADD COLUMN rank INTEGER DEFAULT 15'); } catch (_e) { /* already exists */ }
    db.exec('UPDATE users SET rank = 15 WHERE rank IS NULL');
  }
  if (!userCols.has('stars')) {
    try { db.exec('ALTER TABLE users ADD COLUMN stars INTEGER DEFAULT 0'); } catch (_e) { /* already exists */ }
    db.exec('UPDATE users SET stars = 0 WHERE stars IS NULL');
  }
  if (!userCols.has('is_legend')) {
    try { db.exec('ALTER TABLE users ADD COLUMN is_legend INTEGER DEFAULT 0'); } catch (_e) { /* already exists */ }
    db.exec('UPDATE users SET is_legend = 0 WHERE is_legend IS NULL');
  }
  if (!userCols.has('legend_position')) {
    try { db.exec('ALTER TABLE users ADD COLUMN legend_position INTEGER'); } catch (_e) { /* already exists */ }
  }
  if (!userCols.has('duels_won')) {
    try { db.exec('ALTER TABLE users ADD COLUMN duels_won INTEGER DEFAULT 0'); } catch (_e) { /* already exists */ }
    db.exec('UPDATE users SET duels_won = 0 WHERE duels_won IS NULL');
  }
  if (!userCols.has('duels_lost')) {
    try { db.exec('ALTER TABLE users ADD COLUMN duels_lost INTEGER DEFAULT 0'); } catch (_e) { /* already exists */ }
    db.exec('UPDATE users SET duels_lost = 0 WHERE duels_lost IS NULL');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS player_ranks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      old_rank INTEGER,
      old_stars INTEGER,
      old_is_legend INTEGER DEFAULT 0,
      old_legend_position INTEGER,
      new_rank INTEGER,
      new_stars INTEGER,
      new_is_legend INTEGER DEFAULT 0,
      new_legend_position INTEGER,
      reason TEXT NOT NULL,
      race_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_player_ranks_user_id ON player_ranks(user_id)'); } catch (_e) { /* ignore */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_player_ranks_race_id ON player_ranks(race_id)'); } catch (_e) { /* ignore */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_player_ranks_created_at ON player_ranks(created_at)'); } catch (_e) { /* ignore */ }
};
