// backend/db/migrate.js
// Reads migration files from backend/db/migrations/
// Tracks applied migrations in a schema_migrations table
// Applies pending migrations in order on server startup

const path = require('path');
const fs = require('fs');

function runMigrations(db) {
  // 1. Create schema_migrations table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT UNIQUE NOT NULL,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2. Get list of already-applied migrations
  const applied = new Set(
    db.prepare('SELECT filename FROM schema_migrations').all().map((r) => r.filename)
  );

  // 3. Read migration files from migrations/ directory, sorted by name
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') || f.endsWith('.js'))
    .sort();

  // 4. Apply each pending migration in a transaction
  for (const file of files) {
    if (applied.has(file)) continue;

    console.log(`[migrate] Applying: ${file}`);
    const filePath = path.join(migrationsDir, file);

    if (file.endsWith('.sql')) {
      const sql = fs.readFileSync(filePath, 'utf8');
      db.exec(sql);
    } else if (file.endsWith('.js')) {
      // JS migrations export a function: module.exports = function(db) { ... }
      const migrationFn = require(filePath);
      migrationFn(db);
    }

    db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(file);
    console.log(`[migrate] Applied: ${file}`);
  }
}

module.exports = { runMigrations };
