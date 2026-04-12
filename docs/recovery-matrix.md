# Recovery Matrix

This document catalogs every known failure scenario for the Riley at the Rally
backend, the state that becomes inconsistent, and how (and when) it is recovered.

---

## Failure Scenario Table

| Failure Scenario | Affected State | Symptom | Recovery Mechanism | When Recovery Runs | Verified By |
|---|---|---|---|---|---|
| Server crash mid-session | `activeSessions` Map lost; hold in `transactions` DB with no matching release/deduct | User's balance shows less than expected (hold amount blocked but never settled) | `startupRecovery` Step 1: queries for orphan holds (`type='hold'` with a `reference_id` that has no matching `release` or `deduct`), credits balance back, inserts `release` transaction | Server startup (before `listen`) | Unit test: `startup-recovery.test.js` |
| Server crash after hold, before session end | Same as above | Same as above | Same as above | Server startup | Unit test: `startup-recovery.test.js` |
| Server crash during billing (`processHoldDeduct`) | Hold exists; partial deduct may or may not have been written | Balance inconsistency | If deduct was inserted: hold is resolved (not an orphan). If deduct was not inserted: orphan hold recovered by `startupRecovery` Step 1 | Server startup | Unit test: `startup-recovery.test.js` |
| Server restart with incomplete `rental_sessions` | `rental_sessions` row with `duration_seconds = NULL` | Admin sees incomplete session records in the dashboard | `startupRecovery` Step 2: marks rows with `duration_seconds IS NULL` and `created_at` older than `SESSION_MAX_DURATION_MS` (default 10 min) as `termination_reason = 'server_restart'` | Server startup | Unit test: `startup-recovery.test.js` |
| Server restart with connected devices | `deviceSockets` Map lost; `devices` table has stale `last_seen_at` | Heartbeat stale-checker would immediately evict devices that simply haven't reconnected yet, showing them as offline | `startupRecovery` Step 3: `UPDATE devices SET last_seen_at = NULL WHERE status = 'active'` — clears stale timestamps so the heartbeat checker starts fresh | Server startup | Unit test: `startup-recovery.test.js` |
| Server restart with active presence | `presenceMap` lost | Drivers disappear from the presence list | Clients automatically re-send `presence:hello` on socket reconnect; `presenceMap` repopulates within seconds | Automatic (client-side reconnect) | E2E observation |
| Socket disconnect during active session | `activeSessions` entry for that socket removed | Session ends abruptly; billing must still be applied | `handleSessionEnd` in `socket/index.js`: calls `processHoldDeduct`, writes `rental_sessions` record, then cleans up `activeSessions` | Immediate (on `disconnect` event) | E2E test |
| Network partition (device stops heartbeating) | Device socket still in `deviceSockets` but last heartbeat is stale | Car shows as "online" but commands don't reach it | Heartbeat stale checker (`setInterval` every `HEARTBEAT_CHECK_INTERVAL_MS = 30 s`) disconnects the socket if no heartbeat within `HEARTBEAT_STALE_MS = 45 s` | Periodic (every 30 s) | Config constants + E2E |
| Webhook arrives twice (YooKassa retry) | `payment_orders` could be double-credited | User receives 2× the purchased credits | `webhook_event_id` deduplication: unique index on `payment_orders.webhook_event_id`; webhook handler checks before crediting. Duplicate webhook → skip | On each webhook request | Unit test in payment tests |
| Admin orphaned-hold release while session still active | Hold released but session still running | Double-credit risk (hold refunded + session later settles) | `GET /api/admin/transactions/orphaned-holds` excludes holds whose `reference_id` matches a currently active session ref from `activeSessions` | Runtime check (admin API) | Unit test in admin-transactions tests |
| Duel in progress during restart | `DuelManager` in-memory state lost | Players stuck in "searching" or "in_progress" duel state with no one to resolve it | On restart no duel state exists; clients get disconnected and can re-queue | Automatic (client reconnect + re-queue) | N/A |
| Magic link / reset token used after expiry | Token row exists in DB but `expires_at` is in the past | User cannot use the link; receives an expiry error | Periodic token cleanup (`runTokenCleanup` runs every 60 min) deletes expired rows from the tokens table | Periodic (every 60 min) | E2E password_reset tests |

---

## Startup Recovery Execution Order

`startupRecovery(db, metrics)` is called in `server.js` **after** all DB migrations
have run and **before** `server.listen()`.  The four steps run sequentially:

```
1. Recover orphan holds       — financial consistency
2. Clean stale sessions       — rental_sessions table consistency
3. Reset device state         — devices.last_seen_at cleared
4. Presence reset (log only)  — no DB write needed; clients repopulate on reconnect
```

Each step is wrapped in its own `try/catch`.  A failure in step 1 does **not**
prevent steps 2–4 from running.  All errors are forwarded to the `metrics.log`
function (structured JSON) so they appear in the application log and can trigger
alerts without crashing the process.

---

## What Happens if Startup Recovery Itself Fails

| Step | On error | Side effect |
|---|---|---|
| Step 1 (orphan holds) | Per-hold errors are caught individually; the outer `try/catch` catches query failures | Unrecovered holds remain; `startup_recovery_step1_error` logged |
| Step 2 (stale sessions) | `try/catch` around the UPDATE | Sessions stay incomplete; `startup_recovery_step2_error` logged |
| Step 3 (device reset) | `try/catch` around the UPDATE | `last_seen_at` not cleared; heartbeat checker may evict slow-reconnecting devices; `startup_recovery_step3_error` logged |
| Step 4 (presence log) | Silently ignored | No state impact |

In all cases the server continues to start.  The `startup_recovery_complete`
metric is logged with the final summary counts regardless of individual step
failures, so operators can see partial recovery at a glance.
