# Performance Baseline — Riley at the Rally

## Methodology

Load tests are run using `scripts/load-test.js`, a Node.js script using built-in `http`/`https` modules and `socket.io-client`.

### Test Environment

| Parameter | Value |
|-----------|-------|
| OS | Ubuntu 22.04 LTS |
| Node.js | v18 LTS |
| DB | SQLite (better-sqlite3) |
| Transport | HTTP/1.1 + WebSocket |

### Running the Tests

```bash
# Start the server
cd backend && NODE_ENV=test npm start

# In another terminal
node scripts/load-test.js --base-url http://localhost:5000
```

> **Note:** The load test script hits endpoints without CSRF tokens and without an authenticated session.
> Scenario 1 errors reflect CSRF/auth failures (403), not server crashes.
> Scenarios 3 & 4 latencies are dominated by the client-side timeout because the server
> correctly ignores unauthenticated `control_command` events (returns nothing) and emits
> `chat:error` (not the generic `'error'` event the script listens for).
> Re-run with a seeded authenticated user and CSRF-aware HTTP client for production baselines.

### Scenarios

| # | Scenario | Description |
|---|----------|-------------|
| 1 | Concurrent Logins | 50 concurrent POST /api/auth/login requests |
| 2 | Socket Connections | 20 concurrent Socket.IO connect + handshake |
| 3 | Control Commands | 10 sockets × 10 control_command events |
| 4 | Chat Burst | 50 send_message events/sec for 1 second |

---

## Baseline Results (dev machine — CI sandbox)

> Measured on a CI/sandbox instance: Node.js v24, localhost, SQLite in `/tmp`.
> **These are not Pi hardware numbers** — re-run on Raspberry Pi 4 and update the
> "Raspberry Pi Baseline" section below for production reference.

### Scenario 1 — 50 Concurrent Logins (POST /api/auth/login)

| Metric | Value |
|--------|-------|
| p50 latency | 38 ms |
| p95 latency | 52 ms |
| p99 latency | 53 ms |
| Min latency | 19 ms |
| Max latency | 53 ms |
| Error rate | 100 % ¹ |
| Throughput | 769 req/s |

¹ All requests returned 403 (CSRF token required). The latency numbers reflect real round-trip
time to the server; the errors are expected when using the load-test script without a CSRF token.

### Scenario 2 — 20 Concurrent Socket.IO Connections

| Metric | Value |
|--------|-------|
| p50 connect latency | 33 ms |
| p95 connect latency | 35 ms |
| p99 connect latency | 46 ms |
| Min latency | 30 ms |
| Max latency | 46 ms |
| Error rate | 0 % |

### Scenario 3 — 100 Control Commands (10 sockets × 10 commands)

| Metric | Value |
|--------|-------|
| p50 latency | 100 ms |
| p95 latency | 101 ms |
| p99 latency | 101 ms |
| Min latency | 100 ms |
| Max latency | 102 ms |
| Error rate | 0 % ² |
| Throughput | 735 cmd/s |

² No errors — latency capped at the 100 ms client-side timeout because unauthenticated
`control_command` events are silently ignored (no `session_error` emitted without a session).

### Scenario 4 — Chat Burst (50 msg/sec)

| Metric | Value |
|--------|-------|
| p50 latency | 200 ms |
| p95 latency | 201 ms |
| p99 latency | 201 ms |
| Min latency | 200 ms |
| Max latency | 201 ms |
| Error rate | 0 % ³ |
| Throughput | 41 msg/s |

³ Server emits `chat:error` (auth_required) but the script listens for the generic `'error'`
event, so responses are not captured; latency reflects the 200 ms client-side timeout.

---

## Raspberry Pi Baseline (target — fill in after running on hardware)

> Run `node scripts/load-test.js --base-url http://<pi-ip>:5000` on Pi hardware and replace
> the `_TBD_` values below.

### Scenario 1 — 50 Concurrent Logins

| Metric | Value |
|--------|-------|
| p50 latency | _TBD_ ms |
| p95 latency | _TBD_ ms |
| Error rate | _TBD_ % |

### Scenario 2 — 20 Concurrent Socket.IO Connections

| Metric | Value |
|--------|-------|
| p50 connect latency | _TBD_ ms |
| p95 connect latency | _TBD_ ms |
| Error rate | _TBD_ % |

### Scenario 3 — 100 Control Commands

| Metric | Value |
|--------|-------|
| p50 latency | _TBD_ ms |
| p95 latency | _TBD_ ms |
| Error rate | _TBD_ % |

### Scenario 4 — Chat Burst (50 msg/sec)

| Metric | Value |
|--------|-------|
| p50 latency | _TBD_ ms |
| p95 latency | _TBD_ ms |
| Error rate | _TBD_ % |

---

## Bottleneck Analysis

### Known Bottlenecks (anticipated)

1. **SQLite write serialization** — all writes go through a single writer. Under concurrent session start/end events, `db.transaction()` calls will queue. Expected to show up as high p99 latency in Scenario 1 (login writes session records) and Scenario 3.

2. **bcrypt hashing** — login uses bcrypt with 12 rounds (≈300ms on Pi). With 50 concurrent logins, this will fully saturate Node.js event loop. Expected: p95 > 1000ms for Scenario 1 on Pi hardware.

3. **Socket.IO handshake overhead** — session middleware runs for every socket connection (HTTP session lookup). Should be fast on SQLite but may degrade under load.

4. **Rate limiter memory** — per-IP/per-user rate limit Maps grow unbounded in high-concurrency tests. Not a bottleneck in short tests but relevant for sustained load.

### Raspberry Pi Hardware Reference

| Component | Spec |
|-----------|------|
| Model | Raspberry Pi 4 Model B |
| CPU | Quad-core Cortex-A72 (ARM v8) 1.8GHz |
| RAM | 4GB LPDDR4 |
| Storage | 32GB microSD (Class 10) |
| OS | Raspberry Pi OS 64-bit (Bookworm) |
| Node.js | v18 LTS |

### Acceptance Criteria (targets)

| Scenario | p95 target | Error rate target |
|----------|-----------|-------------------|
| Concurrent Logins | < 2000ms | < 1% |
| Socket Connections | < 500ms | < 1% |
| Control Commands | < 100ms | < 1% |
| Chat Burst | < 200ms | < 1% |

---

## How to Re-run and Update Baseline

1. Boot the Pi, ensure `riley-backend` is running via PM2:
   ```bash
   cd backend && npm run pm2:start
   ```
2. From a separate machine on the same LAN:
   ```bash
   node scripts/load-test.js --base-url http://<pi-ip>:5000
   ```
3. Copy the output into the tables above.
4. Commit the updated `docs/performance-baseline.md`.
