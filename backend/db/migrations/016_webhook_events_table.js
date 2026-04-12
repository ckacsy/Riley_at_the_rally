// Migration 016: dedicated webhook_events table for tracking ALL processed
// webhook event IDs, providing a second layer of deduplication beyond the
// webhook_event_id column on payment_orders.
module.exports = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id     TEXT    NOT NULL UNIQUE,
      payment_id   TEXT,
      event_type   TEXT,
      processed_at TEXT    DEFAULT CURRENT_TIMESTAMP
    )
  `);
};
