// Migration 017: add audit columns to webhook_events table.
// Adds status (processed/rejected/duplicate/sig_invalid/malformed),
// ip_address, and raw_body_hash for forensic/audit purposes.
module.exports = function (db) {
  const cols = new Set(db.pragma('table_info(webhook_events)').map((c) => c.name));
  if (!cols.has('status')) {
    db.exec("ALTER TABLE webhook_events ADD COLUMN status TEXT DEFAULT 'processed'");
  }
  if (!cols.has('ip_address')) {
    db.exec('ALTER TABLE webhook_events ADD COLUMN ip_address TEXT');
  }
  if (!cols.has('raw_body_hash')) {
    db.exec('ALTER TABLE webhook_events ADD COLUMN raw_body_hash TEXT');
  }
};
