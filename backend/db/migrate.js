// backend/db/migrate.js
// Reads migration files from backend/db/migrations/
// Tracks applied migrations in a schema_migrations table
// Applies pending migrations in order on server startup
// Each migration is wrapped in a transaction for atomicity

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function computeChecksum(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function runMigrations(db, migrationsDir) {
  if (!migrationsDir) {
    migrationsDir = path.join(__dirname, 'migrations');
  }

  // 1. Create schema_migrations table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT UNIQUE NOT NULL,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 1b. Self-migrate: add checksum column if it doesn't exist yet
  const schemaCols = db.pragma('table_info(schema_migrations)').map((c) => c.name);
  if (!schemaCols.includes('checksum')) {
    db.exec('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT');
  }

  // 2. Get list of already-applied migrations
  const applied = new Set(
    db.prepare('SELECT filename FROM schema_migrations').all().map((r) => r.filename)
  );

  // 3. Read migration files from migrations/ directory, sorted by name
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') || f.endsWith('.js'))
    .sort();

  // 4. Apply each pending migration in a transaction
  for (const file of files) {
    if (applied.has(file)) continue;

    console.log(`[migrate] Applying: ${file}`);
    const filePath = path.join(migrationsDir, file);
    const checksum = computeChecksum(filePath);

    try {
      db.transaction(() => {
        if (file.endsWith('.sql')) {
          const sql = fs.readFileSync(filePath, 'utf8');
          db.exec(sql);
        } else if (file.endsWith('.js')) {
          // JS migrations export a function: module.exports = function(db) { ... }
          const migrationFn = require(filePath);
          migrationFn(db);
        }

        db.prepare('INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)').run(file, checksum);
      })();
      console.log(`[migrate] Applied: ${file}`);
    } catch (err) {
      console.error(`[migrate] ERROR: Migration "${file}" failed: ${err.message}`);
      console.error('[migrate] Fix the migration or the database state, then restart the server.');
      throw err;
    }
  }
}

module.exports = { runMigrations };
