'use strict';

// backend/lib/startup-recovery.js
// Runs at server startup (after migrations, before listen) to enforce state
// invariants that can be violated when the server restarts mid-session.
//
// Steps:
//   1. Recover orphan holds — hold transactions with no matching release/deduct
//   2. Clean stale sessions — incomplete rental_sessions rows older than SESSION_MAX_DURATION_MS
//   3. Reset device state — clear last_seen_at on active devices so heartbeat
//      checker does not falsely evict devices that simply haven't reconnected yet
//   4. Presence reset — presence is in-memory only; log that it was cleared

const { SESSION_MAX_DURATION_MS } = require('../config/constants');

/**
 * Run all startup-recovery steps.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ log: (level: string, event: string, data?: object) => void }} metrics
 * @returns {{ orphanHoldsRecovered: number, staleSessions: number, devicesReset: number }}
 */
function startupRecovery(db, metrics) {
  const summary = {
    orphanHoldsRecovered: 0,
    staleSessions: 0,
    devicesReset: 0,
  };

  // -------------------------------------------------------------------------
  // Step 1: Recover orphan holds
  // An orphan hold is a transactions row with type='hold' and a non-NULL
  // reference_id that has no matching type IN ('release','deduct') row sharing
  // the same reference_id.  These are created when a session was active at the
  // time of a server restart and never settled.
  // -------------------------------------------------------------------------
  try {
    const orphanHolds = db.prepare(
      `SELECT t.id, t.user_id, t.amount, t.reference_id
         FROM transactions t
        WHERE t.type = 'hold'
          AND t.reference_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM transactions t2
             WHERE t2.reference_id = t.reference_id
               AND t2.type IN ('release', 'deduct')
          )`
    ).all();

    metrics.log('info', 'startup_recovery_orphan_check', { found: orphanHolds.length });

    for (const hold of orphanHolds) {
      try {
        db.transaction(() => {
          const releaseAmount = Math.abs(hold.amount);

          // Credit balance back to user
          db.prepare(
            'UPDATE users SET balance = balance + ? WHERE id = ?'
          ).run(releaseAmount, hold.user_id);

          const row = db.prepare('SELECT balance FROM users WHERE id = ?').get(hold.user_id);
          const balanceAfter = row ? row.balance : 0;

          // Insert a release transaction to mark the hold as settled
          db.prepare(
            `INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id)
             VALUES (?, 'release', ?, ?, ?, ?)`
          ).run(
            hold.user_id,
            releaseAmount,
            balanceAfter,
            'Автовосстановление: возврат блокировки при перезапуске',
            hold.reference_id
          );
        })();

        summary.orphanHoldsRecovered += 1;
        metrics.log('info', 'startup_recovery_orphan_hold_refunded', {
          holdId: hold.id,
          userId: hold.user_id,
          amount: Math.abs(hold.amount),
          referenceId: hold.reference_id,
        });
      } catch (e) {
        metrics.log('error', 'startup_recovery_orphan_hold_error', {
          holdId: hold.id,
          error: e.message,
        });
      }
    }
  } catch (e) {
    metrics.log('error', 'startup_recovery_step1_error', { error: e.message });
  }

  // -------------------------------------------------------------------------
  // Step 2: Clean stale sessions
  // rental_sessions rows where duration_seconds IS NULL (incomplete write)
  // and created_at is older than SESSION_MAX_DURATION_MS are unlikely to ever
  // be completed and should be marked with termination_reason='server_restart'.
  // -------------------------------------------------------------------------
  try {
    const maxDurationSeconds = Math.floor(SESSION_MAX_DURATION_MS / 1000);
    const result = db.prepare(
      `UPDATE rental_sessions
          SET termination_reason = 'server_restart'
        WHERE duration_seconds IS NULL
          AND (termination_reason IS NULL OR termination_reason != 'server_restart')
          AND created_at < datetime('now', ?)`
    ).run(`-${maxDurationSeconds} seconds`);

    summary.staleSessions = result.changes;
    metrics.log('info', 'startup_recovery_stale_sessions', { cleaned: result.changes });
  } catch (e) {
    metrics.log('error', 'startup_recovery_step2_error', { error: e.message });
  }

  // -------------------------------------------------------------------------
  // Step 3: Reset device state
  // On restart no device sockets are connected.  Clear last_seen_at for all
  // active devices so the heartbeat checker does not immediately evict devices
  // that simply haven't had time to reconnect yet.
  // -------------------------------------------------------------------------
  try {
    const result = db.prepare(
      `UPDATE devices
          SET last_seen_at = NULL
        WHERE status = 'active'`
    ).run();

    summary.devicesReset = result.changes;
    metrics.log('info', 'startup_recovery_devices_reset', { reset: result.changes });
  } catch (e) {
    metrics.log('error', 'startup_recovery_step3_error', { error: e.message });
  }

  // -------------------------------------------------------------------------
  // Step 4: Presence reset (in-memory only — nothing to do in DB)
  // -------------------------------------------------------------------------
  try {
    metrics.log('info', 'startup_recovery_presence_reset', {
      note: 'presenceMap cleared on restart; clients will re-send presence:hello',
    });
  } catch (e) {
    // Ignore logging errors
  }

  metrics.log('info', 'startup_recovery_complete', summary);
  return summary;
}

module.exports = startupRecovery;
