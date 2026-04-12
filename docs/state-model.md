# State Model

This document describes every stateful entity in the Riley RC-car rental system: where it lives, how it is cached, what happens on restart, when it expires, and how failures are handled.

---

## 1. Balance

| Field | Detail |
|-------|--------|
| **Source of truth** | `users.balance` column in SQLite (`riley.sqlite`) |
| **Cached representation** | None — every read goes directly to the database |
| **Recovery behavior** | No action needed on server restart; the DB is the single source of truth |
| **TTL / lifetime** | Permanent — never expires; only changes via transactions |
| **Failure mode** | All balance mutations run inside `db.transaction()`; if the transaction throws, it is rolled back automatically, leaving balance unchanged |

---

## 2. Active Session

| Field | Detail |
|-------|--------|
| **Source of truth** | In-memory `activeSessions` Map in `backend/socket/index.js` — keyed by `socket.id`, value: `{ carId, userId, dbUserId, startTime, holdAmount, sessionRef }` |
| **Cached representation** | The Map itself is the only representation; no DB row exists for an in-progress session |
| **Recovery behavior** | **On restart all in-memory sessions are lost.** Any hold created at session start becomes an orphaned hold. `startupRecovery` detects these orphan holds (hold transactions with no matching release/deduct) and refunds them automatically |
| **TTL / lifetime** | `SESSION_MAX_DURATION_MS` (default 10 min); also ends on inactivity timeout (`INACTIVITY_TIMEOUT_MS` = 2 min) or client disconnect |
| **Failure mode** | Inactivity timeout or socket disconnect triggers `handleSessionEnd`, which calls `processHoldDeduct` to settle the balance and writes a `rental_sessions` record |

---

## 3. Device State

| Field | Detail |
|-------|--------|
| **Source of truth** | `deviceSockets` Map in `backend/socket/index.js` (keyed by `carId → socket`) for live connectivity; `devices` table in SQLite stores persistent registration and `last_seen_at` |
| **Cached representation** | `deviceSockets` Map — in-memory, lost on restart |
| **Recovery behavior** | On restart all device socket connections are lost; the `devices` table is reset so that `last_seen_at` is cleared for every `status='active'` device, preventing the heartbeat checker from falsely evicting devices that simply haven't reconnected yet. Devices re-connect automatically (Raspberry Pi auto-reconnect) |
| **TTL / lifetime** | `HEARTBEAT_STALE_MS` = 45 s — a device is evicted if no heartbeat arrives within that window; `HEARTBEAT_CHECK_INTERVAL_MS` = 30 s |
| **Failure mode** | If heartbeat stops (network loss, Pi crash), the stale-device checker disconnects the socket entry; the `devices` row stays but `last_seen_at` goes stale — admins can see "offline" status in the admin panel |

---

## 4. Presence

| Field | Detail |
|-------|--------|
| **Source of truth** | In-memory `presenceMap` Map in `backend/socket/index.js` (keyed by `userId → presence entry`) |
| **Cached representation** | The Map itself; no DB backing |
| **Recovery behavior** | On restart the Map is empty. Clients re-send `presence:hello` when they reconnect, repopulating the Map within seconds |
| **TTL / lifetime** | `PRESENCE_STALE_MS` = 60 s — stale entries are pruned by a periodic `setInterval` |
| **Failure mode** | Stale entries expire naturally; a user who crashes or closes the tab simply disappears from presence after 60 s |

---

## 5. Duel

| Field | Detail |
|-------|--------|
| **Source of truth** | In-memory structures managed by `DuelManager` (`backend/lib/duel-manager.js`): a search queue and an active-duels Map |
| **Cached representation** | None beyond the in-memory Maps |
| **Recovery behavior** | On restart all in-progress and queued duels are lost. No DB rows exist for in-progress duels. Clients receive disconnection and can re-enter the queue |
| **TTL / lifetime** | A duel in `ready_pending` state times out after `READY_TIMEOUT_MS` = 60 s. There is no hard TTL on an in-progress duel — it ends when both lap times are recorded |
| **Failure mode** | Socket disconnect during a duel calls the disconnect handler in `DuelManager`, marking the duel as a forfeit/cancel |

---

## 6. Race / Leaderboard

| Field | Detail |
|-------|--------|
| **Source of truth** | Individual lap times are persisted to the `lap_times` table in SQLite; `raceRooms` Map and in-memory `leaderboard` array are derived from live events |
| **Cached representation** | `raceRooms` Map (race state per room) and `leaderboard` array (top-N sorted by best lap) — both in-memory |
| **Recovery behavior** | On restart the Maps are empty and the in-memory leaderboard is cleared. Because lap times are in the DB, the leaderboard can be reconstructed from `lap_times` on demand (REST endpoint re-queries DB) |
| **TTL / lifetime** | A `raceRoom` exists while at least one client is in the race; no expiry on persisted lap times |
| **Failure mode** | If the server crashes mid-race the in-memory race state is lost; persisted lap times survive. The leaderboard shown via REST always reflects the DB state |

---

## 7. Payment Hold

| Field | Detail |
|-------|--------|
| **Source of truth** | `transactions` table, `type='hold'` row — written atomically when a session starts |
| **Cached representation** | `holdAmount` field on the `activeSessions` Map entry for the current session |
| **Recovery behavior** | On restart the `activeSessions` Map is lost, but the `hold` transaction row remains in the DB with no matching `release` or `deduct`. `startupRecovery` detects these **orphan holds** (via `reference_id` matching) and automatically refunds the held amount back to the user's balance, inserting a `type='release'` transaction with description `'Автовосстановление: возврат блокировки при перезапуске'` |
| **TTL / lifetime** | A hold is released or deducted at session end via `processHoldDeduct()`; if not settled by restart it is recovered by `startupRecovery` |
| **Failure mode** | If `processHoldDeduct` throws, the hold remains in the DB. The admin panel exposes orphaned holds at `GET /api/admin/transactions/orphaned-holds`; they can be released manually. `startupRecovery` also handles them automatically on next boot |

---

## 8. Chat Messages

| Field | Detail |
|-------|--------|
| **Source of truth** | `chat_messages` table in SQLite |
| **Cached representation** | None — every read fetches from DB |
| **Recovery behavior** | No action needed on restart; all messages are fully persisted |
| **TTL / lifetime** | Pruned to `CHAT_HISTORY_LIMIT` most-recent entries by a periodic cleanup interval (every 60 s) |
| **Failure mode** | If the DB write fails on `chat:send`, the error is caught and an error event is emitted to the sender; other users are unaffected |

---

## 9. Webhook Events

| Field | Detail |
|-------|--------|
| **Source of truth** | `payment_orders.webhook_event_id` column in SQLite — stores the YooKassa `event_id` for deduplication |
| **Cached representation** | None |
| **Recovery behavior** | No action needed on restart; deduplication state is fully persisted in the DB |
| **TTL / lifetime** | Permanent — kept for the lifetime of the payment order |
| **Failure mode** | If the webhook arrives twice (retry), the second processing attempt finds the existing `webhook_event_id` and returns early (idempotent); the user is not double-credited |
