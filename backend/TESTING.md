# E2E Testing

This document describes how to run the Playwright end-to-end test suite for the Riley at the Rally backend and frontend.

## Requirements

- Node.js 18 or later
- No special environment variables are needed (all defaults work)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_USERNAMES` | *(empty)* | Comma-separated list of usernames with chat moderation rights (e.g. `admin,mod`). Set in `playwright.config.ts` `webServer.env` for tests. |
| `CHAT_HISTORY_LIMIT` | `500` | Maximum number of chat messages to keep in the database. Older messages are pruned on insert. |

## Running the tests

```bash
cd backend
npm install
npx playwright install --with-deps chromium   # first-time setup
npm run test:e2e
```

`npm run test:e2e` is equivalent to `playwright test`.

## What is tested

The suite contains 22 spec files. The table below describes what each covers.

| Spec | What it covers |
|------|----------------|
| `api.spec.ts` | Static page routes (`/`, `/control`, `/garage`) return 200 and correct `Content-Type`; `/garage` and `/control` HTML includes key structural elements (`garage-canvas`, `car-name`, `session-timer`, `chat-toggle-btn`, directional buttons); `/api/health` → `ok:true`; `/api/leaderboard` (all / week / day) → no 500, array payload; `/api/metrics` → 401/403 for unauthenticated; `/api/cars` → `ratePerMinute` + `cars` array; `/api/car-status` → status + ISO timestamp; `/api/config/session` → timing values; leaderboard page HTML content; profile page nav link; control page UI element smoke tests |
| `garage.spec.ts` | Page loads in fallback mode; initial car title non-empty; carousel renders 5 thumbnails and updates the title on click (all 5 variants); availability status badge (`available` / `busy` / `offline`); CTA button gating (disabled + text when busy or offline; enabled when available); WoT-style UI blocks (profile card, news panel, characteristics, upgrades grid, carousel arrows, balance, bonuses); upgrade item rarity classes; no stale layout elements (gold credits bar, level text) |
| `auth_cta.spec.ts` | Guest CTA = "Только просмотр / Войти", click → `/login`; pending user CTA = "Подтвердите email"; active user CTA = "НА ТРЕК" (correct text after activation) |
| `broadcast.spec.ts` | Unauthenticated visit redirects to `/login`; authenticated user sees the broadcast viewport; fullscreen toggle works; `/api/config/video` returns expected shape |
| `chat.spec.ts` | Cross-page chat (broadcast ↔ control): message sent from one page appears on the other; history loaded on reconnect; unauthenticated users are blocked from sending |
| `news.spec.ts` | `news` table schema is created; moderator and admin can create/publish news; published items appear in the public API; drafts are excluded; XSS payloads are sanitised via DOMPurify; slug generation is deterministic |
| `password_reset.spec.ts` | Forgot-password form submits without leaking user existence; reset-password page validates token; tokens are single-use; error states render correctly |
| `presence.spec.ts` | Active drivers list on `/broadcast`; `/api/health` `activeDrivers` count increments on connect and decrements on disconnect |
| `session_timers.spec.ts` | Countdown display and warning banner on `/control` (stubbed session); countdown reflects `sessionMaxDurationMs` and `inactivityTimeoutMs` from config; redirect guard bounces visitors without an active session back to `/garage`; API config values match what the timer UI uses |
| `socket_race.spec.ts` | `join_race`, `leave_race`, `start_lap`, `end_lap` socket events; `/api/races` returns current races; `/api/leaderboard` reflects completed lap |
| `socket_session.spec.ts` | `start_session` → `session_started` event with `sessionRef`; `end_session` → `session_ended`; `/api/car-status` reflects session state; `/api/session/end` works from REST |
| `admin_roles.spec.ts` | User role enum (`user` / `moderator` / `admin`) via dev helpers; `requireRole` blocks wrong roles; banned users are rejected at login; soft-delete marks users deleted; audit log persists high-impact actions |
| `admin_ui.spec.ts` | Admin page access / route guards (admin and moderator can open admin pages; plain user is redirected to `/garage`); moderator can ban a user via the UI (button click → confirm → success flash → status badge update); admin can adjust balance via the UI modal form; moderator does not see the Delete button; admin/moderator can open the admin news page; admin can create a draft news item from the UI; markdown preview renders formatted `<h2>` and `<strong>` output |
| `admin_users.spec.ts` | `GET /api/admin/users` (admin access, pagination, search); `POST` ban / unban / delete / balance-adjust; each action writes to `admin_audit_log`; idempotency key enforcement |
| `admin_sessions.spec.ts` | `GET /api/admin/sessions` with filters (status, user, car, date) and pagination; active sessions endpoint; completed sessions; force-end session (admin only); UI renders session list and filters |
| `admin_analytics.spec.ts` | `GET /api/admin/analytics/overview`; time-series endpoint; period presets (day / week / month / year); KPI field presence; UI renders charts and KPI cards |
| `admin_audit.spec.ts` | `GET /api/admin/audit-log` access control (admin only); filtering by action type; pagination; safe JSON rendering in UI (XSS-safe display) |
| `admin_cars.spec.ts` | `GET /api/admin/cars`; `POST /api/admin/cars/:id/maintenance` (enable / disable); cars in maintenance mode are blocked from new sessions; audit log entry written |
| `admin_transactions.spec.ts` | `GET /api/admin/transactions` access control; filters (user_id, type including `admin_compensation`, reference_id, date range, amount range); combined filters; invalid param → 400; pagination; summary `byType` totals; `admin_id` / `admin_username` join; `GET /api/admin/users/:id/ledger`; UI filters, summary, type badges, username → ledger panel, admin_adjust shows actor username |
| `admin_compensation.spec.ts` | `POST /api/admin/users/:id/compensations` access control (401 / 403 for non-admin); field validation (amount, reason_code, idempotency_key); idempotency (same actor → idempotent, different actor → 409); balance credit applied; transaction record has type `admin_compensation`; audit log written; `admin_compensation` visible in `/api/admin/transactions` and user ledger; ledger `totalCompensations` summary; UI: compensation button visible for admin, modal opens and submits, success flash |
| `admin_dashboard.spec.ts` | `GET /api/admin/dashboard` access control (401 / 403); moderator sees only `activeSessions`; admin sees all sections (`activeSessions`, `orphanedHolds`, `maintenanceCars`, `bannedUsers`, `recentAuditActions`); counts reflect actual data; recent audit actions limited to high-impact types; UI: Operations Hub section (`#ops-hub-section`) and widget grid (`#ops-hub-grid`) render; moderator grid shows active sessions only; manual refresh button reloads data |
| `orphaned_holds.spec.ts` | `GET /api/admin/transactions/orphaned-holds` access control (401 / 403 / moderator blocked); empty result when no orphaned holds; hold with `reference_id` and no matching deduct older than grace period → appears as orphaned; matching deduct present → not orphaned; `NULL` `reference_id` holds excluded (legacy data); hold within grace period excluded; `POST /api/admin/transactions/orphaned-holds/:holdId/release` access control (401 / 403); invalid holdId → 400; hold not found → 404; hold without `reference_id` → 400; already-resolved hold → 409; valid orphaned hold → 200, `release` transaction inserted, balance credited, hold no longer returned as orphaned; integration: real session hold gets `reference_id`, `end_session` deduct shares same `reference_id`; admin force-end shares `reference_id`; active session exclusion |

## How it works

- Playwright automatically starts the backend server (`node server.js`) with `NODE_ENV=test` before running tests (via `webServer` in `playwright.config.ts`).
- `NODE_ENV=test` skips Express rate-limit counters so tests can run rapidly without hitting throttle limits.
- `NODE_ENV=test` also enables the `/api/dev/reset-db` endpoint used between tests to start with a clean database.
- Dev-only endpoints (`/api/dev/activate-user`, `/api/dev/set-user-role`, `/api/dev/set-user-status`, `/api/dev/transactions/insert`) allow tests to set up specific database states without going through the full UI flow.
- `window.__testSocket` is exposed globally on `broadcast.html` for Playwright tests to emit socket events directly.

## CI

Set `CI=true` in the environment to prevent reuse of an already-running server and to enable automatic retries on flaky tests:

```bash
CI=true npm run test:e2e
```
