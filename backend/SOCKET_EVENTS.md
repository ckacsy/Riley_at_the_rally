# Socket Events Authorization Matrix

This document is the living reference for every **client → server** Socket.IO event registered in `backend/socket/index.js`.  
Update this file whenever a new event is added or an existing event's auth / mutation behaviour changes.

---

## Legend

| Column | Meaning |
|--------|---------|
| **Auth required** | Whether `socket.request.session.userId` must exist before the handler runs |
| **Status check** | Whether the DB user record is fetched and checked for `status === 'active'` |
| **Rate limited** | Any in-process throttle applied to the event |
| **Reads** | In-memory state or DB tables read by the handler |
| **Mutates** | In-memory state or DB tables written by the handler |
| **Admin only** | Whether the handler enforces the `ADMIN_USERNAMES` list or equivalent role check |

---

## Events

### `chat:send`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` + DB lookup |
| Status check | ✅ `user.status === 'active'` |
| Rate limited | ✅ per-user cooldown (`CHAT_COOLDOWN_MS` = 700 ms) + burst cap (`CHAT_BURST_MAX` = 5) |
| Reads | `users` table, `chatRateLimits` map |
| Mutates | `chat_messages` table (INSERT); broadcasts `chat:message` to room |
| Admin only | ❌ |

---

### `chat:delete`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` + DB lookup |
| Status check | ✅ `user.status === 'active'` |
| Rate limited | ❌ |
| Reads | `users` table |
| Mutates | `chat_messages` table (DELETE); broadcasts `chat:deleted` to room |
| Admin only | ✅ checks `ADMIN_USERNAMES` list |

---

### `presence:hello`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` (required for control page path; guest path allowed for viewers) |
| Status check | ✅ `user.status === 'active'` (for control page path) |
| Rate limited | ❌ |
| Reads | `users` table, `presenceMap` |
| Mutates | `presenceMap` (upsert entry); broadcasts `presence:update` |
| Admin only | ❌ |

---

### `presence:heartbeat`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Status check | ❌ |
| Rate limited | ❌ (fired every ~30 s by client) |
| Reads | `presenceMap` |
| Mutates | `presenceMap` (`lastSeen` timestamp only) |
| Admin only | ❌ |

---

### `start_session`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` + DB lookup |
| Status check | ✅ `getAccessBlockReason` (checks active status, balance, maintenance, etc.) |
| Rate limited | ✅ per-user session-start rate limit (`SESSION_START_MAX` / `SESSION_START_WINDOW_MS`) |
| Reads | `users`, `cars`, `car_maintenance` tables; `activeSessions` map |
| Mutates | `activeSessions` map (add entry); `transactions` table (hold); emits `session_started` |
| Admin only | ❌ |

---

### `control_command`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ⚠️ checks `activeSessions.has(socket.id)` (session existence, no re-auth DB lookup) |
| Status check | ❌ |
| Rate limited | ✅ `CONTROL_RATE_LIMIT_MAX` / `CONTROL_RATE_LIMIT_WINDOW_MS` per session |
| Reads | `activeSessions` map |
| Mutates | Emits hardware command to device socket; updates `lastActivity` timestamp |
| Admin only | ❌ |

---

### `end_session`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ⚠️ checks `activeSessions.get(socket.id)` (session existence, no re-auth DB lookup) |
| Status check | ❌ |
| Rate limited | ❌ |
| Reads | `activeSessions` map |
| Mutates | `activeSessions` map (remove entry); `transactions` table (deduct/release hold); emits `session_ended` |
| Admin only | ❌ |

---

### `join_race`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` + DB lookup |
| Status check | ✅ `getAccessBlockReason` |
| Rate limited | ❌ |
| Reads | `users` table; `raceRooms`, `activeSessions` maps |
| Mutates | `raceRooms` map (add player); emits `race_joined` / `race_updated` |
| Admin only | ❌ |

---

### `leave_race`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Status check | ❌ |
| Rate limited | ❌ |
| Reads | `raceRooms` map; `duelManager` state |
| Mutates | `raceRooms` map (remove player); may trigger duel forfeit; emits `race_left` |
| Admin only | ❌ |

---

### `start_lap`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Status check | ❌ |
| Rate limited | ❌ |
| Reads | `raceRooms` map |
| Mutates | In-memory `player.currentLapStart` timestamp; emits `lap_started` |
| Admin only | ❌ |

---

### `end_lap`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Status check | ❌ |
| Rate limited | ❌ |
| Reads | `raceRooms` map; in-memory `leaderboard` array |
| Mutates | `lap_times` table (INSERT); in-memory `leaderboard`; emits `lap_recorded` / `race_updated` |
| Admin only | ❌ |

---

### `duel:search`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` + DB lookup |
| Status check | ✅ `getAccessBlockReason` |
| Rate limited | ❌ |
| Reads | `users` table; `duelManager` queue; `activeSessions` map |
| Mutates | `duelManager` queue (add to matchmaking); may create a duel and emit `duel:matched` |
| Admin only | ❌ |

---

### `duel:cancel_search`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Status check | ❌ |
| Rate limited | ❌ |
| Reads | `duelManager` queue |
| Mutates | `duelManager` queue (remove from matchmaking); emits `duel:search_cancelled` |
| Admin only | ❌ |

---

### `duel:cancel_ready`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Status check | ❌ |
| Rate limited | ❌ |
| Reads | `duelManager` state |
| Mutates | `duelManager` state (cancel duel); emits `duel:cancelled` to both players |
| Admin only | ❌ |

---

### `duel:ready`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Status check | ❌ |
| Rate limited | ❌ |
| Reads | `duelManager` state |
| Mutates | `duelManager` state (ready flag per player); may transition duel to `in_progress`; emits `duel:start` countdown |
| Admin only | ❌ |

---

### `duel:start_lap`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Status check | ❌ |
| Rate limited | ❌ |
| Reads | `duelManager` state |
| Mutates | In-memory `player.lapStarted` / `currentLapStart`; emits `duel:lap_started` |
| Admin only | ❌ |

---

### `duel:checkpoint`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Status check | ❌ |
| Rate limited | ❌ |
| Reads | `duelManager` state |
| Mutates | In-memory `player.checkpointIndex`; emits `duel:checkpoint_ok` |
| Admin only | ❌ |

---

### `duel:finish_lap`

| Property | Value |
|----------|-------|
| Direction | client → server |
| Auth required | ✅ `session.userId` |
| Status check | ❌ |
| Rate limited | ❌ |
| Reads | `duelManager` state; `users` table |
| Mutates | `users` table (rank/stars UPDATE); `duelManager` state (mark resolved); emits `duel:result` to both players |
| Admin only | ❌ |

---

## Summary Table

| # | Event | Auth | Status check | Rate limited | DB writes | Admin only |
|---|-------|------|-------------|-------------|-----------|-----------|
| 1 | `chat:send` | ✅ userId + DB | ✅ active | ✅ cooldown + burst | `chat_messages` INSERT | ❌ |
| 2 | `chat:delete` | ✅ userId + DB | ✅ active | ❌ | `chat_messages` DELETE | ✅ |
| 3 | `presence:hello` | ✅ userId (control) | ✅ active (control) | ❌ | — | ❌ |
| 4 | `presence:heartbeat` | ✅ userId | ❌ | ❌ | — | ❌ |
| 5 | `start_session` | ✅ userId + DB | ✅ via getAccessBlockReason | ✅ per-user | `transactions` INSERT | ❌ |
| 6 | `control_command` | ⚠️ session existence | ❌ | ✅ per-session | — | ❌ |
| 7 | `end_session` | ⚠️ session existence | ❌ | ❌ | `transactions` INSERT | ❌ |
| 8 | `join_race` | ✅ userId + DB | ✅ via getAccessBlockReason | ❌ | — | ❌ |
| 9 | `leave_race` | ✅ userId | ❌ | ❌ | — | ❌ |
| 10 | `start_lap` | ✅ userId | ❌ | ❌ | — | ❌ |
| 11 | `end_lap` | ✅ userId | ❌ | ❌ | `lap_times` INSERT | ❌ |
| 12 | `duel:search` | ✅ userId + DB | ✅ via getAccessBlockReason | ❌ | — | ❌ |
| 13 | `duel:cancel_search` | ✅ userId | ❌ | ❌ | — | ❌ |
| 14 | `duel:cancel_ready` | ✅ userId | ❌ | ❌ | — | ❌ |
| 15 | `duel:ready` | ✅ userId | ❌ | ❌ | — | ❌ |
| 16 | `duel:start_lap` | ✅ userId | ❌ | ❌ | — | ❌ |
| 17 | `duel:checkpoint` | ✅ userId | ❌ | ❌ | — | ❌ |
| 18 | `duel:finish_lap` | ✅ userId | ❌ | ❌ | `users` UPDATE (rank/stars) | ❌ |
