// Add extra user columns, normalize legacy statuses, backfill normalized fields,
// add unique indexes on normalized columns, and add PR1 transaction columns.
module.exports = function (db) {
  const userCols = new Set(db.pragma('table_info(users)').map((c) => c.name));

  if (!userCols.has('display_name')) db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
  if (!userCols.has('username_normalized')) db.exec('ALTER TABLE users ADD COLUMN username_normalized TEXT');
  if (!userCols.has('email_normalized')) db.exec('ALTER TABLE users ADD COLUMN email_normalized TEXT');
  if (!userCols.has('status')) {
    // Add nullable column first, then backfill — SQLite forbids NOT NULL without constant default in ADD COLUMN
    db.exec("ALTER TABLE users ADD COLUMN status TEXT");
    db.exec("UPDATE users SET status = 'active' WHERE status IS NULL");
  }
  if (!userCols.has('updated_at')) {
    // SQLite disallows non-constant (e.g. CURRENT_TIMESTAMP) DEFAULT in ADD COLUMN
    db.exec('ALTER TABLE users ADD COLUMN updated_at TEXT');
    db.exec("UPDATE users SET updated_at = COALESCE(created_at, CURRENT_TIMESTAMP) WHERE updated_at IS NULL");
  }
  if (!userCols.has('last_login_at')) db.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT');
  if (!userCols.has('username_changed_at')) {
    try { db.exec('ALTER TABLE users ADD COLUMN username_changed_at TEXT'); } catch (_e) { /* already exists */ }
  }
  if (!userCols.has('balance')) {
    try { db.exec('ALTER TABLE users ADD COLUMN balance REAL DEFAULT 0'); } catch (_e) { /* already exists */ }
  }

  // PR 1: role, soft-delete fields
  if (!userCols.has('role')) {
    // SQLite requires a constant DEFAULT for NOT NULL columns added via ALTER TABLE
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }
  if (!userCols.has('deleted_at')) {
    try { db.exec('ALTER TABLE users ADD COLUMN deleted_at TEXT'); } catch (_e) { /* already exists */ }
  }
  if (!userCols.has('deleted_by')) {
    try { db.exec('ALTER TABLE users ADD COLUMN deleted_by INTEGER'); } catch (_e) { /* already exists */ }
  }

  // Normalize legacy 'disabled' status to 'banned'
  db.exec("UPDATE users SET status = 'banned' WHERE status = 'disabled'");

  // Backfill normalized fields for existing rows
  db.prepare(
    `UPDATE users SET
       email_normalized = LOWER(TRIM(email)),
       username_normalized = LOWER(TRIM(username))
     WHERE email_normalized IS NULL OR username_normalized IS NULL`
  ).run();

  // Create unique indexes (safe to re-run)
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_norm ON users(email_normalized)');
  } catch (e) { console.warn('Index warning (email_norm):', e.message); }
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_norm ON users(username_normalized)');
  } catch (e) { console.warn('Index warning (username_norm):', e.message); }

  // PR 1: transactions — admin_id, idempotency_key
  const transCols = new Set(db.pragma('table_info(transactions)').map((c) => c.name));
  if (!transCols.has('admin_id')) {
    try { db.exec('ALTER TABLE transactions ADD COLUMN admin_id INTEGER'); } catch (_e) { /* already exists */ }
  }
  if (!transCols.has('idempotency_key')) {
    try { db.exec('ALTER TABLE transactions ADD COLUMN idempotency_key TEXT'); } catch (_e) { /* already exists */ }
  }

  // Indexes on transactions
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_reference_id ON transactions(reference_id)'); } catch (_e) { /* ignore */ }
  try {
    // Partial unique index — SQLite supports WHERE clause in CREATE INDEX
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_idempotency_key ON transactions(idempotency_key) WHERE idempotency_key IS NOT NULL');
  } catch (_e) { /* ignore */ }
};
