module.exports = function(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_recovery (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      session_ref TEXT,
      details_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_by INTEGER,
      resolved_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_pending_recovery_user_id ON pending_recovery(user_id)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_pending_recovery_status ON pending_recovery(status)'); } catch(e) {}
};
