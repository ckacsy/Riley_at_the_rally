'use strict';

/**
 * Migration smoke tests for backend/db/migrate.js
 * Run with: node tests/unit/migrations.test.js
 * Uses Node.js built-in test runner (node:test), available since Node 18.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { openDatabase } = require('../../db/connection');
const { runMigrations } = require('../../db/migrate');

describe('Migration runner', () => {

  it('applies all migrations to a clean database', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);

    // Verify schema_migrations table exists and has entries
    const applied = db.prepare('SELECT filename FROM schema_migrations ORDER BY id').all();
    assert.ok(applied.length > 0, 'Should have applied at least one migration');

    // Verify all expected tables exist
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all().map(r => r.name);

    const expectedTables = [
      'users',
      'email_verification_tokens',
      'lap_times',
      'rental_sessions',
      'password_reset_tokens',
      'chat_messages',
      'magic_links',
      'transactions',
      'payment_orders',
      'admin_audit_log',
      'news',
      'car_maintenance',
      'daily_checkins',
      'player_ranks',
      'duel_results',
      'schema_migrations',
    ];

    for (const table of expectedTables) {
      assert.ok(tables.includes(table), `Table '${table}' should exist`);
    }

    db.close();
  });

  it('is idempotent — re-running migrations causes no errors', () => {
    const db = openDatabase(':memory:');

    // First run
    runMigrations(db);
    const firstRun = db.prepare('SELECT filename FROM schema_migrations ORDER BY id').all();

    // Second run — should skip all, no errors
    runMigrations(db);
    const secondRun = db.prepare('SELECT filename FROM schema_migrations ORDER BY id').all();

    // Same migrations recorded
    assert.deepStrictEqual(firstRun, secondRun, 'Second run should not add new migration records');

    db.close();
  });

  it('creates all expected columns on users table', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);

    const cols = new Set(db.pragma('table_info(users)').map(c => c.name));

    const expectedColumns = [
      'id', 'username', 'username_normalized', 'display_name',
      'email', 'email_normalized', 'password_hash', 'avatar_path',
      'status', 'created_at', 'updated_at', 'last_login_at',
      'username_changed_at', 'balance', 'role', 'deleted_at', 'deleted_by',
      'rank', 'stars', 'is_legend', 'legend_position',
      'duels_won', 'duels_lost',
    ];

    for (const col of expectedColumns) {
      assert.ok(cols.has(col), `users table should have column '${col}'`);
    }

    db.close();
  });

  it('creates all expected columns on transactions table', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);

    const cols = new Set(db.pragma('table_info(transactions)').map(c => c.name));

    const expectedColumns = [
      'id', 'user_id', 'type', 'amount', 'balance_after',
      'description', 'reference_id', 'created_at',
      'admin_id', 'idempotency_key',
    ];

    for (const col of expectedColumns) {
      assert.ok(cols.has(col), `transactions table should have column '${col}'`);
    }

    db.close();
  });

  it('creates all expected columns on rental_sessions table', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);

    const cols = new Set(db.pragma('table_info(rental_sessions)').map(c => c.name));

    assert.ok(cols.has('session_ref'), 'rental_sessions should have session_ref column');
    assert.ok(cols.has('termination_reason'), 'rental_sessions should have termination_reason column');

    db.close();
  });

  it('creates pending_recovery table with expected columns', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);

    const cols = new Set(db.pragma('table_info(pending_recovery)').map(c => c.name));

    const expectedColumns = ['id', 'user_id', 'type', 'amount', 'session_ref', 'details_json', 'status', 'resolved_by', 'resolved_at', 'created_at'];
    for (const col of expectedColumns) {
      assert.ok(cols.has(col), `pending_recovery should have column '${col}'`);
    }

    db.close();
  });

  it('creates all expected indexes', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
    ).all().map(r => r.name);

    // Spot-check some important indexes
    const expectedIndexes = [
      'idx_transactions_user_id',
      'idx_payment_orders_yookassa_id',
      'idx_magic_links_token_hash',
      'idx_pending_recovery_user_id',
      'idx_pending_recovery_status',
    ];

    for (const idx of expectedIndexes) {
      assert.ok(indexes.includes(idx), `Index '${idx}' should exist`);
    }

    db.close();
  });

  it('can insert and query data after migrations', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);

    // Insert a user
    db.prepare(
      `INSERT INTO users (username, username_normalized, email, email_normalized, password_hash, status, role)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('testuser', 'testuser', 'test@example.com', 'test@example.com', 'hash123', 'active', 'user');

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get('testuser');
    assert.ok(user, 'Should be able to insert and query a user');
    assert.equal(user.status, 'active');
    assert.equal(user.role, 'user');

    db.close();
  });

  it('schema_migrations records checksum', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);

    const rows = db.prepare('SELECT filename, checksum FROM schema_migrations').all();
    assert.ok(rows.length > 0, 'Should have applied migrations');

    for (const row of rows) {
      assert.ok(row.checksum, `Migration ${row.filename} should have a non-null checksum`);
      assert.match(row.checksum, /^[a-f0-9]{64}$/, `Checksum for ${row.filename} should be a SHA-256 hex string`);
    }

    db.close();
  });

  it('failed SQL migration does not leave partial state', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-sql-test-'));
    try {
      // Migration 001: valid — creates good_table
      fs.writeFileSync(
        path.join(tmpDir, '001_good.sql'),
        'CREATE TABLE good_table (id INTEGER PRIMARY KEY);'
      );

      // Migration 002: partially valid then syntax error — should roll back
      fs.writeFileSync(
        path.join(tmpDir, '002_bad.sql'),
        'CREATE TABLE partial_table (id INTEGER PRIMARY KEY);\nINVALID SQL SYNTAX HERE!!!'
      );

      // Migration 003: should never be attempted
      fs.writeFileSync(
        path.join(tmpDir, '003_after_bad.sql'),
        'CREATE TABLE after_bad_table (id INTEGER PRIMARY KEY);'
      );

      const db = openDatabase(':memory:');

      assert.throws(
        () => runMigrations(db, tmpDir),
        (err) => {
          assert.ok(err instanceof Error, 'Should throw an Error');
          return true;
        }
      );

      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table'"
      ).all().map((r) => r.name);

      assert.ok(tables.includes('good_table'), 'good_table should exist (001 succeeded)');
      assert.ok(!tables.includes('partial_table'), 'partial_table should NOT exist (rolled back)');
      assert.ok(!tables.includes('after_bad_table'), 'after_bad_table should NOT exist (not attempted)');

      const applied = db.prepare('SELECT filename FROM schema_migrations').all().map((r) => r.filename);
      assert.ok(applied.includes('001_good.sql'), '001_good.sql should be recorded');
      assert.ok(!applied.includes('002_bad.sql'), '002_bad.sql should NOT be recorded');
      assert.ok(!applied.includes('003_after_bad.sql'), '003_after_bad.sql should NOT be recorded');

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('failed JS migration does not leave partial state', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-js-test-'));
    try {
      // Migration 001: valid SQL
      fs.writeFileSync(
        path.join(tmpDir, '001_good.sql'),
        'CREATE TABLE js_good_table (id INTEGER PRIMARY KEY);'
      );

      // Migration 002: JS that creates a table then throws
      fs.writeFileSync(
        path.join(tmpDir, '002_bad.js'),
        [
          'module.exports = function(db) {',
          "  db.exec('CREATE TABLE js_partial_table (id INTEGER PRIMARY KEY);');",
          "  throw new Error('Intentional JS migration failure');",
          '};',
        ].join('\n')
      );

      // Migration 003: should never be attempted
      fs.writeFileSync(
        path.join(tmpDir, '003_after_bad.sql'),
        'CREATE TABLE js_after_bad_table (id INTEGER PRIMARY KEY);'
      );

      const db = openDatabase(':memory:');

      assert.throws(
        () => runMigrations(db, tmpDir),
        /Intentional JS migration failure/
      );

      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table'"
      ).all().map((r) => r.name);

      assert.ok(tables.includes('js_good_table'), 'js_good_table should exist (001 succeeded)');
      assert.ok(!tables.includes('js_partial_table'), 'js_partial_table should NOT exist (rolled back)');
      assert.ok(!tables.includes('js_after_bad_table'), 'js_after_bad_table should NOT exist (not attempted)');

      const applied = db.prepare('SELECT filename FROM schema_migrations').all().map((r) => r.filename);
      assert.ok(applied.includes('001_good.sql'), '001_good.sql should be recorded');
      assert.ok(!applied.includes('002_bad.js'), '002_bad.js should NOT be recorded');
      assert.ok(!applied.includes('003_after_bad.sql'), '003_after_bad.sql should NOT be recorded');

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('stops on first failure — later migrations are not attempted', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-stop-test-'));
    try {
      fs.writeFileSync(
        path.join(tmpDir, '001_ok.sql'),
        'CREATE TABLE stop_test_ok (id INTEGER PRIMARY KEY);'
      );
      fs.writeFileSync(
        path.join(tmpDir, '002_fail.sql'),
        'INVALID SQL THAT WILL FAIL!!!'
      );
      fs.writeFileSync(
        path.join(tmpDir, '003_never.sql'),
        'CREATE TABLE stop_test_never (id INTEGER PRIMARY KEY);'
      );
      fs.writeFileSync(
        path.join(tmpDir, '004_never.sql'),
        'CREATE TABLE stop_test_never2 (id INTEGER PRIMARY KEY);'
      );

      const db = openDatabase(':memory:');

      assert.throws(() => runMigrations(db, tmpDir));

      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table'"
      ).all().map((r) => r.name);

      assert.ok(tables.includes('stop_test_ok'), 'stop_test_ok should exist');
      assert.ok(!tables.includes('stop_test_never'), 'stop_test_never should NOT exist');
      assert.ok(!tables.includes('stop_test_never2'), 'stop_test_never2 should NOT exist');

      const applied = db.prepare('SELECT filename FROM schema_migrations').all().map((r) => r.filename);
      assert.equal(applied.length, 1, 'Only 001_ok.sql should be recorded');
      assert.equal(applied[0], '001_ok.sql');

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});
