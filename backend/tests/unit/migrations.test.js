'use strict';

/**
 * Migration smoke tests for backend/db/migrate.js
 * Run with: node tests/unit/migrations.test.js
 * Uses Node.js built-in test runner (node:test), available since Node 18.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrations } = require('../../db/migrate');

describe('Migration runner', () => {

  it('applies all migrations to a clean database', () => {
    const db = new Database(':memory:');
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
    const db = new Database(':memory:');

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
    const db = new Database(':memory:');
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
    const db = new Database(':memory:');
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
    const db = new Database(':memory:');
    runMigrations(db);

    const cols = new Set(db.pragma('table_info(rental_sessions)').map(c => c.name));

    assert.ok(cols.has('session_ref'), 'rental_sessions should have session_ref column');
    assert.ok(cols.has('termination_reason'), 'rental_sessions should have termination_reason column');

    db.close();
  });

  it('creates pending_recovery table with expected columns', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const cols = new Set(db.pragma('table_info(pending_recovery)').map(c => c.name));

    const expectedColumns = ['id', 'user_id', 'type', 'amount', 'session_ref', 'details_json', 'status', 'resolved_by', 'resolved_at', 'created_at'];
    for (const col of expectedColumns) {
      assert.ok(cols.has(col), `pending_recovery should have column '${col}'`);
    }

    db.close();
  });

  it('creates all expected indexes', () => {
    const db = new Database(':memory:');
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
    const db = new Database(':memory:');
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

});
