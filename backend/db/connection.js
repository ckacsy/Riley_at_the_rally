'use strict';

const Database = require('better-sqlite3');

/**
 * Default PRAGMA configuration applied to every database connection.
 * These are applied at connection time (runtime bootstrap), NOT in migrations,
 * because PRAGMA settings are per-connection and do not persist in the DB file
 * (except journal_mode which persists but must still be verified).
 */
const DEFAULT_PRAGMAS = {
  journal_mode: 'WAL',
  busy_timeout: 5000,
  foreign_keys: 'ON',       // SQLite default is OFF — we MUST enable
  synchronous: 'NORMAL',    // Safe with WAL, faster than default FULL
};

/**
 * Open a SQLite database with hardened PRAGMA configuration.
 *
 * @param {string} dbPath — file path or ':memory:' for in-memory DB
 * @param {object} [options] — options passed to better-sqlite3 constructor
 * @param {object} [pragmaOverrides] — override specific PRAGMA values
 * @returns {import('better-sqlite3').Database}
 */
function openDatabase(dbPath, options = {}, pragmaOverrides = {}) {
  const db = new Database(dbPath, options);

  const pragmas = { ...DEFAULT_PRAGMAS, ...pragmaOverrides };

  for (const [key, value] of Object.entries(pragmas)) {
    // Guard against injection: key must be a plain identifier, value must be
    // a number or one of the known safe keyword/string values.
    if (!/^\w+$/.test(key)) {
      throw new Error(`[db] Invalid PRAGMA key: ${key}`);
    }
    // Numeric values are always safe; string values must not contain quotes or semicolons.
    if (typeof value === 'string' && /['"`;]/.test(value)) {
      throw new Error(`[db] Unsafe PRAGMA value for key '${key}': ${value}`);
    }
    db.pragma(`${key} = ${value}`);
  }

  // Verify critical PRAGMA were actually applied
  const journalMode = db.pragma('journal_mode', { simple: true });
  // WAL may not work on :memory: databases — that's expected
  if (dbPath !== ':memory:' && journalMode !== 'wal') {
    console.warn(`[db] WARNING: journal_mode is '${journalMode}', expected 'wal'. Path: ${dbPath}`);
  }

  const fkEnabled = db.pragma('foreign_keys', { simple: true });
  if (fkEnabled !== 1) {
    console.warn(`[db] WARNING: foreign_keys is ${fkEnabled}, expected 1. Path: ${dbPath}`);
  }

  return db;
}

module.exports = { openDatabase, DEFAULT_PRAGMAS };
