# Socket Events Authorization Matrix

This document is the living reference for every **client → server** Socket.IO event registered in `backend/socket/index.js`.  
Update this file whenever a new event is added or an existing event's auth / mutation behaviour changes.

**Last audited:** Sprint 7.1 — all gaps from Sprint 6.6 have been closed.

---

## Legend

| Column | Meaning |
|--------|---------|
| **Auth required** | Whether `socket.request.session.userId` must exist before the handler runs |
| **Session owner check** | Whether the authenticated userId is cross-checked against the session owner (prevents socket hijacking) |
| **Status check** | Whether the DB user record is fetched and checked for `status === 'active'` |
| **Rate limited** | Any in-process throttle applied to the event |
| **Input validation** | Payload fields validated (type, range, enum, unknown-field rejection) |
| **Reads** | In-memory state or DB tables read by the handler |
| **Mutates** | In-memory state or DB tables written by the handler |
| **Admin only** | Whether the handler enforces a role check |

---

## Events

### `chat:send`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` + DB lookup |
| Session owner check | N/A — no rental session involved |
| Status check | ✅ `user.status === 'active'` |
| Rate limited | ✅ per-user cooldown (`CHAT_COOLDOWN_MS` = 700 ms) + burst cap (`CHAT_BURST_MAX` = 5) |
| Input validation | ✅ `message`: string, length 1–300, sanitized via `sanitize-html` |
| Reads | `users` table, `chatRateLimits` map |
| Mutates | `chat_messages` table (INSERT); broadcasts `chat:message` to room |
| Admin only | ❌ |

---

### `chat:delete`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` + DB lookup |
| Session owner check | N/A |
| Status check | ✅ `user.status === 'active'` |
| Rate limited | ✅ 10 deletes per 10 s per user (`CHAT_DELETE_MAX / CHAT_DELETE_WINDOW_MS`) |
| Input validation | ✅ `id`: positive integer (rejects non-integer and `< 1` silently) |
| Reads | `users` table |
| Mutates | `chat_messages` table (DELETE); broadcasts `chat:deleted` to room |
| Admin only | ✅ DB role check (`admin` or `moderator` via `hasRequiredRole`) |

---

### `presence:hello`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` required for `control` page; viewer path is auth-optional |
| Session owner check | N/A |
| Status check | ✅ `user.status === 'active'` (for `control` page path) |
| Rate limited | ✅ 5 per 60 s per socket (`PRESENCE_HELLO_MAX / PRESENCE_HELLO_WINDOW_MS`) |
| Input validation | ✅ `page`: must be one of `control \| broadcast \| garage \| profile \| index` (unknown values silently dropped) |
| Reads | `users` table, `presenceMap` |
| Mutates | `presenceMap` (upsert entry); broadcasts `presence:update` |
| Admin only | ❌ |

---

### `presence:heartbeat`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Session owner check | N/A |
| Status check | ❌ (heartbeat is a lightweight keep-alive; banning is handled via active status on privileged events) |
| Rate limited | ✅ 5 per 30 s per socket (`PRESENCE_HEARTBEAT_MAX / PRESENCE_HEARTBEAT_WINDOW_MS`) |
| Input validation | N/A — no payload |
| Reads | `presenceMap` |
| Mutates | `presenceMap` (`lastSeen` timestamp only) |
| Admin only | ❌ |

---

### `start_session`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` + DB lookup |
| Session owner check | N/A — session creation event; no prior session to own |
| Status check | ✅ `getAccessBlockReason` (checks active status, balance, maintenance, etc.) |
| Rate limited | ✅ per-user session-start rate limit (`SESSION_START_MAX` / `SESSION_START_WINDOW_MS`) |
| Input validation | ✅ `carId`: positive integer (`Number.isInteger(carId) && carId >= 1`) + must be in `CARS` list |
| Reads | `users`, `cars`, `car_maintenance` tables; `activeSessions` map |
| Mutates | `activeSessions` map (add entry); `transactions` table (hold); emits `session_started` |
| Admin only | ❌ |

---

### `control_command`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` verified via `requireSessionOwner` helper |
| Session owner check | ✅ `session.dbUserId === socket.request.session.userId` — prevents socket.id hijacking |
| Status check | ❌ (session existence implies active state was verified at `start_session`) |
| Rate limited | ✅ `CONTROL_RATE_LIMIT_MAX` / `CONTROL_RATE_LIMIT_WINDOW_MS` per session |
| Input validation | ✅ Strict: unknown fields rejected; `direction` must be `forward \| backward \| stop`; `speed` number −100–100; `steering_angle` number −90–90 |
| Reads | `activeSessions` map |
| Mutates | Emits hardware command to device socket; updates `lastActivity` timestamp |
| Admin only | ❌ |

---

### `end_session`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` present in session |
| Session owner check | ✅ `session.dbUserId === socket.request.session.userId` — prevents unauthorized termination |
| Status check | ❌ (session owner check is sufficient) |
| Rate limited | ❌ (session exists at most once per socket; inherent idempotency via `activeSessions` delete) |
| Input validation | N/A — payload ignored (no payload expected; handler derives all data from server state) |
| Reads | `activeSessions` map |
| Mutates | `activeSessions` map (remove entry); `transactions` table (deduct/release hold); emits `session_ended` |
| Admin only | ❌ |

**Replay protection:** `processHoldDeduct` is idempotent via `sessionRef` + `idempotency_key` checks.  
**Double-end protection:** `activeSessions.delete()` runs before financial logic; a second `end_session` call returns `no_active_session`.

---

### `join_race`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` + DB lookup |
| Session owner check | N/A |
| Status check | ✅ `getAccessBlockReason` |
| Rate limited | ✅ 10 per 60 s per user (`JOIN_RACE_MAX / JOIN_RACE_WINDOW_MS`) |
| Input validation | ✅ `raceId`: optional string; `carId`: positive integer when provided; `carName`: max 100 chars |
| Reads | `users` table; `raceRooms`, `activeSessions` maps |
| Mutates | `raceRooms` map (add player); emits `race_joined` / `race_updated` |
| Admin only | ❌ |

---

### `leave_race`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Session owner check | N/A |
| Status check | ✅ `user.status === 'active'` (DB lookup to prevent banned users from manipulating race state) |
| Rate limited | ❌ (once-per-session action; natural idempotency) |
| Input validation | N/A — no payload |
| Reads | `raceRooms` map; `duelManager` state |
| Mutates | `raceRooms` map (remove player); may trigger duel forfeit; emits `race_left` |
| Admin only | ❌ |

---

### `start_lap`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Session owner check | N/A |
| Status check | ✅ `user.status === 'active'` (DB lookup to prevent banned users from creating lap records) |
| Rate limited | ❌ (at most one active lap per player) |
| Input validation | N/A — no payload |
| Reads | `raceRooms` map |
| Mutates | In-memory `player.currentLapStart` timestamp; emits `lap_started` |
| Admin only | ❌ |

---

### `end_lap`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Session owner check | N/A |
| Status check | ✅ `user.status === 'active'` (DB lookup to prevent banned users from recording lap times) |
| Rate limited | ✅ 60 per 60 s per user (`END_LAP_MAX / END_LAP_WINDOW_MS`) |
| Input validation | N/A — no payload; server derives timing from server-side `currentLapStart` |
| Reads | `raceRooms` map; in-memory `leaderboard` array |
| Mutates | `lap_times` table (INSERT); in-memory `leaderboard`; emits `lap_recorded` / `race_updated` |
| Admin only | ❌ |

---

### `duel:search`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` + DB lookup |
| Session owner check | N/A |
| Status check | ✅ `getAccessBlockReason` |
| Rate limited | ✅ `DUEL_SEARCH_MAX` (3) per `DUEL_SEARCH_WINDOW_MS` (60 s) per user |
| Input validation | N/A — no payload |
| Reads | `users` table; `duelManager` queue; `activeSessions` map |
| Mutates | `duelManager` queue (add to matchmaking); may create a duel and emit `duel:matched` |
| Admin only | ❌ |

---

### `duel:cancel_search`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Session owner check | N/A |
| Status check | ✅ `user.status === 'active'` (DB lookup) |
| Rate limited | ✅ group duel rate limit: 10 per 1 s per socket (`DUEL_EVENT_MAX / DUEL_EVENT_WINDOW_MS`) |
| Input validation | N/A — no payload |
| Reads | `duelManager` queue |
| Mutates | `duelManager` queue (remove from matchmaking); emits `duel:search_cancelled` |
| Admin only | ❌ |

---

### `duel:cancel_ready`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Session owner check | N/A |
| Status check | ✅ `user.status === 'active'` (DB lookup) |
| Rate limited | ✅ group duel rate limit: 10 per 1 s per socket |
| Input validation | N/A — no payload |
| Reads | `duelManager` state |
| Mutates | `duelManager` state (cancel duel); emits `duel:cancelled` to both players |
| Admin only | ❌ |

---

### `duel:ready`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Session owner check | N/A |
| Status check | ✅ `user.status === 'active'` (DB lookup) |
| Rate limited | ✅ group duel rate limit: 10 per 1 s per socket |
| Input validation | N/A — no payload |
| Reads | `duelManager` state |
| Mutates | `duelManager` state (ready flag per player); may transition duel to `in_progress`; emits `duel:start` countdown |
| Admin only | ❌ |

---

### `duel:start_lap`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Session owner check | N/A |
| Status check | ❌ (status verified at `duel:search` entry; duel state machine enforces sequence) |
| Rate limited | ✅ group duel rate limit: 10 per 1 s per socket |
| Input validation | N/A — no payload |
| Reads | `duelManager` state |
| Mutates | In-memory `player.lapStarted` / `currentLapStart`; emits `duel:lap_started` |
| Admin only | ❌ |

---

### `duel:checkpoint`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Session owner check | N/A |
| Status check | ❌ |
| Rate limited | ✅ group duel rate limit: 10 per 1 s per socket |
| Input validation | ✅ `index`: non-negative integer (`Number.isInteger && index >= 0`) |
| Reads | `duelManager` state |
| Mutates | In-memory `player.checkpointIndex`; emits `duel:checkpoint_ok` |
| Admin only | ❌ |

---

### `duel:finish_lap`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Session owner check | N/A |
| Status check | ❌ |
| Rate limited | ✅ group duel rate limit: 10 per 1 s per socket |
| Input validation | N/A — no payload |
| Reads | `duelManager` state; `users` table |
| Mutates | `users` table (rank/stars UPDATE); `duelManager` state (mark resolved); emits `duel:result` to both players |
| Admin only | ❌ |

**Replay protection:** `player.finished` flag in `DuelManager.handleFinishLap` prevents double-finish. The `recentlyResolved` grace timer (`RECENTLY_RESOLVED_GRACE_MS`) prevents duplicate resolution.

---

## Summary Table

| # | Event | Auth | Session owner | Status check | Rate limited | Input validation |
|---|-------|------|--------------|-------------|-------------|-----------------|
| 1 | `chat:send` | ✅ userId + DB | N/A | ✅ active | ✅ cooldown + burst | ✅ string 1–300 chars |
| 2 | `chat:delete` | ✅ userId + DB | N/A | ✅ active | ✅ 10/10s | ✅ positive integer id |
| 3 | `presence:hello` | ✅ userId (control path) | N/A | ✅ active (control) | ✅ 5/60s | ✅ page enum |
| 4 | `presence:heartbeat` | ✅ userId | N/A | ❌ | ✅ 5/30s | N/A |
| 5 | `start_session` | ✅ userId + DB | N/A | ✅ getAccessBlockReason | ✅ per-user | ✅ carId positive int |
| 6 | `control_command` | ✅ userId + DB | ✅ cross-check | ❌ | ✅ per-session | ✅ strict schema |
| 7 | `end_session` | ✅ userId | ✅ cross-check | ❌ | ❌ (idempotent) | N/A (no payload) |
| 8 | `join_race` | ✅ userId + DB | N/A | ✅ getAccessBlockReason | ✅ 10/60s | ✅ carId, carName |
| 9 | `leave_race` | ✅ userId | N/A | ✅ active | ❌ | N/A |
| 10 | `start_lap` | ✅ userId | N/A | ✅ active | ❌ | N/A |
| 11 | `end_lap` | ✅ userId | N/A | ✅ active | ✅ 60/60s | N/A |
| 12 | `duel:search` | ✅ userId + DB | N/A | ✅ getAccessBlockReason | ✅ 3/60s | N/A |
| 13 | `duel:cancel_search` | ✅ userId | N/A | ✅ active | ✅ 10/1s (group) | N/A |
| 14 | `duel:cancel_ready` | ✅ userId | N/A | ✅ active | ✅ 10/1s (group) | N/A |
| 15 | `duel:ready` | ✅ userId | N/A | ✅ active | ✅ 10/1s (group) | N/A |
| 16 | `duel:start_lap` | ✅ userId | N/A | ❌ | ✅ 10/1s (group) | N/A |
| 17 | `duel:checkpoint` | ✅ userId | N/A | ❌ | ✅ 10/1s (group) | ✅ non-negative int |
| 18 | `duel:finish_lap` | ✅ userId | N/A | ❌ | ✅ 10/1s (group) | N/A |

---

## Security Gaps — Sprint 7.1 Status

All gaps identified in Sprint 6.6 have been **CLOSED**:

| # | Gap | Status | Fix |
|---|-----|--------|-----|
| 1 | `control_command`: only session existence, no userId re-auth | ✅ CLOSED | `requireSessionOwner` cross-checks `dbUserId === session.userId` |
| 2 | `end_session`: only session existence, no userId re-auth | ✅ CLOSED | `_endSess.userId !== session.dbUserId` → `forbidden` |
| 3 | `control_command`: no strict input validation | ✅ CLOSED | Unknown fields rejected; direction/speed/steering_angle strict enums + ranges |
| 4 | All `duel:*` events: no rate limiting | ✅ CLOSED | Group rate limit: 10 events/sec/socket for 6 duel events |
| 5 | `chat:delete`: no rate limiting | ✅ CLOSED | 10 deletes/10s per user |
| 6 | `leave_race`, `start_lap`, `end_lap`: no status check | ✅ CLOSED | DB lookup + `status === 'active'` check added |
| 7 | `presence:hello`, `presence:heartbeat`: no rate limiting | ✅ CLOSED | 5/60s for hello; 5/30s for heartbeat |
| 8 | `join_race`, `end_lap`: no rate limiting | ✅ CLOSED | join_race: 10/60s; end_lap: 60/60s |
| 9 | `duel:cancel_search`, `duel:cancel_ready`, `duel:ready`: no status check | ✅ CLOSED | DB lookup + `status === 'active'` added |
| 10 | `start_session`: no explicit type validation on `carId` | ✅ CLOSED | `Number.isInteger(carId) && carId >= 1` check added |
| 11 | `chat:delete`: accepted non-positive integer ids | ✅ CLOSED | `!Number.isInteger(id) \|\| id < 1` → silent drop |
| 12 | `presence:hello`: no `page` enum validation | ✅ CLOSED | `ALLOWED_PRESENCE_PAGES` set; invalid values dropped silently |

