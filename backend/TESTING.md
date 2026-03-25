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

| Spec | Coverage |
|------|----------|
| `api.spec.ts` | `GET /`, `/control`, `/garage` → 200; `/api/health` → `ok:true`; `/api/leaderboard` (all / week / day) → no 500, array payload; `/api/metrics` → 401/403 for unauthenticated; `/api/cars` → `ratePerMinute` + `cars` array |
| `garage.spec.ts` | Page loads, initial car title visible; carousel renders 5 thumbnails; clicking a thumbnail updates the title (livery switch) |
| `auth_cta.spec.ts` | Guest CTA = "Только просмотр / Войти", click → `/login`; pending user CTA = "Подтвердите email"; active user CTA = "Старт / Подключиться" |

## How it works

- Playwright automatically starts the backend server (`node server.js`) with `NODE_ENV=test` before running tests (via `webServer` in `playwright.config.ts`).
- `NODE_ENV=test` skips Express rate-limit counters so tests can run rapidly without hitting throttle limits.
- `NODE_ENV=test` also enables the `/api/dev/reset-db` endpoint used between role-state tests to start with a clean database.
- For the **active user** test, `better-sqlite3` is opened directly inside the test process and issues `UPDATE users SET status='active'` — matching the pattern documented in the problem statement.

## CI

Set `CI=true` in the environment to prevent reuse of an already-running server and to enable automatic retries on flaky tests:

```bash
CI=true npm run test:e2e
```
