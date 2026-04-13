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

### Scenarios

| # | Scenario | Description |
|---|----------|-------------|
| 1 | Concurrent Logins | 50 concurrent POST /api/auth/login requests |
| 2 | Socket Connections | 20 concurrent Socket.IO connect + handshake |
| 3 | Control Commands | 10 sockets × 10 control_command events |
| 4 | Chat Burst | 50 send_message events/sec for 1 second |

---

## Baseline Results

> **Note:** Fill these in after running `node scripts/load-test.js` against the production server on a Raspberry Pi.

### Scenario 1 — 50 Concurrent Logins (POST /api/auth/login)

| Metric | Value |
|--------|-------|
| p50 latency | _TBD_ ms |
| p95 latency | _TBD_ ms |
| p99 latency | _TBD_ ms |
| Min latency | _TBD_ ms |
| Max latency | _TBD_ ms |
| Error rate | _TBD_ % |
| Throughput | _TBD_ req/s |

### Scenario 2 — 20 Concurrent Socket.IO Connections

| Metric | Value |
|--------|-------|
| p50 connect latency | _TBD_ ms |
| p95 connect latency | _TBD_ ms |
| p99 connect latency | _TBD_ ms |
| Min latency | _TBD_ ms |
| Max latency | _TBD_ ms |
| Error rate | _TBD_ % |

### Scenario 3 — 100 Control Commands (10 sockets × 10 commands)

| Metric | Value |
|--------|-------|
| p50 latency | _TBD_ ms |
| p95 latency | _TBD_ ms |
| p99 latency | _TBD_ ms |
| Min latency | _TBD_ ms |
| Max latency | _TBD_ ms |
| Error rate | _TBD_ % |
| Throughput | _TBD_ cmd/s |

### Scenario 4 — Chat Burst (50 msg/sec)

| Metric | Value |
|--------|-------|
| p50 latency | _TBD_ ms |
| p95 latency | _TBD_ ms |
| p99 latency | _TBD_ ms |
| Min latency | _TBD_ ms |
| Max latency | _TBD_ ms |
| Error rate | _TBD_ % |
| Throughput | _TBD_ msg/s |

---

## Bottleneck Analysis

> _Fill in after running the baseline tests and profiling._

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
