// PR 11: car_maintenance table + session_ref column on rental_sessions
module.exports = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS car_maintenance (
      car_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      admin_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // session_ref column for deterministic join
  const sessionCols = new Set(db.pragma('table_info(rental_sessions)').map((c) => c.name));
  if (!sessionCols.has('session_ref')) {
    try { db.exec('ALTER TABLE rental_sessions ADD COLUMN session_ref TEXT'); } catch (e) { /* already exists */ }
  }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_rental_sessions_session_ref ON rental_sessions(session_ref)'); } catch (e) { /* ignore */ }
};
