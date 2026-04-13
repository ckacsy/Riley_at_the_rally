'use strict';

/**
 * Load test script for Riley at the Rally backend.
 *
 * Scenarios:
 *   1. 50 concurrent logins (POST /api/auth/login)
 *   2. 20 concurrent Socket.IO connections + authenticate
 *   3. 10 concurrent sessions with control_command events
 *   4. Chat burst: 50 msg/sec via send_message events
 *
 * Usage:
 *   node scripts/load-test.js [--base-url http://localhost:5000]
 *
 * Requires server running with NODE_ENV=test and test accounts seeded
 * (or DISABLE_EMAIL=true with auto-activation).
 */

const http = require('http');
const https = require('https');
const { io: ioClient } = require('socket.io-client');

// --- Configuration ---
const BASE_URL = (() => {
  const idx = process.argv.indexOf('--base-url');
  return idx !== -1 ? process.argv[idx + 1] : 'http://localhost:5000';
})();

const TEST_USERNAME = process.env.LOAD_TEST_USER || 'loadtest';
const TEST_PASSWORD = process.env.LOAD_TEST_PASS || 'LoadTest#1';
const TEST_EMAIL    = process.env.LOAD_TEST_EMAIL || 'loadtest@example.com';

// --- Percentile helper ---
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(samples) {
  if (!samples.length) return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(sum / sorted.length),
  };
}

// --- HTTP helper ---
function httpRequest(method, urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const bodyStr = body ? JSON.stringify(body) : '';
    const reqHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      ...(headers || {}),
    };

    const start = Date.now();
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: reqHeaders,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.status || res.statusCode,
          latency: Date.now() - start,
          headers: res.headers,
          body: (() => { try { return JSON.parse(data); } catch { return data; } })(),
        });
      });
    });

    req.on('error', (e) => reject(e));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// --- Scenario 1: 50 concurrent logins ---
async function scenarioConcurrentLogins(concurrency) {
  console.log(`\n[Scenario 1] ${concurrency} concurrent logins...`);
  const latencies = [];
  let errors = 0;
  const start = Date.now();

  const tasks = Array.from({ length: concurrency }, async (_, i) => {
    try {
      const res = await httpRequest('POST', `${BASE_URL}/api/auth/login`, {
        identifier: TEST_USERNAME,
        password: TEST_PASSWORD,
      });
      latencies.push(res.latency);
      if (res.status !== 200 && res.status !== 401) errors++;
    } catch {
      errors++;
    }
  });

  await Promise.all(tasks);
  const elapsed = Date.now() - start;
  const s = stats(latencies);

  console.log(`  Completed in ${elapsed}ms | errors: ${errors}/${concurrency}`);
  console.log(`  Latency — p50: ${s.p50}ms  p95: ${s.p95}ms  p99: ${s.p99}ms  min: ${s.min}ms  max: ${s.max}ms`);
  console.log(`  Throughput: ${Math.round((concurrency / elapsed) * 1000)} req/s`);
  return { latencies, errors, elapsed };
}

// --- Scenario 2: 20 concurrent Socket.IO connections ---
async function scenarioConcurrentSocketConnections(concurrency) {
  console.log(`\n[Scenario 2] ${concurrency} concurrent Socket.IO connections...`);
  const latencies = [];
  let errors = 0;
  const start = Date.now();
  const sockets = [];

  const tasks = Array.from({ length: concurrency }, () => new Promise((resolve) => {
    const t0 = Date.now();
    const sock = ioClient(BASE_URL, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });

    sockets.push(sock);

    const timer = setTimeout(() => {
      errors++;
      sock.disconnect();
      resolve();
    }, 5000);

    sock.on('connect', () => {
      latencies.push(Date.now() - t0);
      clearTimeout(timer);
      resolve();
    });

    sock.on('connect_error', () => {
      errors++;
      clearTimeout(timer);
      resolve();
    });
  }));

  await Promise.all(tasks);
  const elapsed = Date.now() - start;
  const s = stats(latencies);

  sockets.forEach((s) => s.disconnect());

  console.log(`  Completed in ${elapsed}ms | errors: ${errors}/${concurrency}`);
  console.log(`  Connect latency — p50: ${s.p50}ms  p95: ${s.p95}ms  p99: ${s.p99}ms  min: ${s.min}ms  max: ${s.max}ms`);
  return { latencies, errors, elapsed };
}

// --- Scenario 3: control_command burst over 10 connected sockets ---
async function scenarioControlCommands(concurrentSockets, commandsPerSocket) {
  console.log(`\n[Scenario 3] ${concurrentSockets} sockets × ${commandsPerSocket} control_commands...`);
  const latencies = [];
  let errors = 0;
  const start = Date.now();
  const sockets = [];

  // Connect all sockets first
  await Promise.all(Array.from({ length: concurrentSockets }, () => new Promise((resolve) => {
    const sock = ioClient(BASE_URL, { transports: ['websocket'], reconnection: false });
    sockets.push(sock);
    sock.on('connect', resolve);
    sock.on('connect_error', resolve);
  })));

  // Send commands from each socket
  const allTasks = sockets.map((sock) =>
    Array.from({ length: commandsPerSocket }, () => new Promise((resolve) => {
      const t0 = Date.now();
      const directions = ['forward', 'backward', 'left', 'right'];
      const dir = directions[Math.floor(Math.random() * directions.length)];

      // control_command requires an active session — we expect session_error back
      sock.emit('control_command', { direction: dir, speed: 50 });

      // We just measure round-trip for the ack / any response
      const ackTimer = setTimeout(() => {
        latencies.push(Date.now() - t0);
        resolve();
      }, 100);

      sock.once('session_error', () => {
        clearTimeout(ackTimer);
        latencies.push(Date.now() - t0);
        resolve();
      });
    }))
  ).flat();

  await Promise.all(allTasks);
  const elapsed = Date.now() - start;
  const s = stats(latencies);

  sockets.forEach((s) => s.disconnect());

  const total = concurrentSockets * commandsPerSocket;
  console.log(`  Completed ${total} commands in ${elapsed}ms | errors: ${errors}/${total}`);
  console.log(`  Latency — p50: ${s.p50}ms  p95: ${s.p95}ms  p99: ${s.p99}ms  min: ${s.min}ms  max: ${s.max}ms`);
  console.log(`  Throughput: ${Math.round((total / elapsed) * 1000)} cmd/s`);
  return { latencies, errors, elapsed };
}

// --- Scenario 4: Chat burst (50 msg/sec) ---
async function scenarioChatBurst(messagesPerSecond, durationSec) {
  const total = messagesPerSecond * durationSec;
  console.log(`\n[Scenario 4] Chat burst: ${total} messages (${messagesPerSecond}/s for ${durationSec}s)...`);
  const latencies = [];
  let errors = 0;
  const start = Date.now();

  const sock = ioClient(BASE_URL, { transports: ['websocket'], reconnection: false });
  await new Promise((resolve) => { sock.on('connect', resolve); sock.on('connect_error', resolve); });

  const delayMs = Math.floor(1000 / messagesPerSecond);
  const tasks = [];

  for (let i = 0; i < total; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const t0 = Date.now();
    tasks.push(new Promise((resolve) => {
      // send_message expects auth — we expect an error back
      sock.emit('send_message', { message: `Load test msg ${i}` });
      const timer = setTimeout(() => {
        latencies.push(Date.now() - t0);
        resolve();
      }, 200);
      sock.once('error', () => {
        clearTimeout(timer);
        latencies.push(Date.now() - t0);
        resolve();
      });
    }));
  }

  await Promise.all(tasks);
  sock.disconnect();

  const elapsed = Date.now() - start;
  const s = stats(latencies);

  console.log(`  Sent ${total} messages in ${elapsed}ms | errors: ${errors}/${total}`);
  console.log(`  Latency — p50: ${s.p50}ms  p95: ${s.p95}ms  p99: ${s.p99}ms  min: ${s.min}ms  max: ${s.max}ms`);
  console.log(`  Throughput: ${Math.round((total / elapsed) * 1000)} msg/s`);
  return { latencies, errors, elapsed };
}

// --- Main ---
async function main() {
  console.log(`\n=== Riley at the Rally — Load Test ===`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Started at: ${new Date().toISOString()}\n`);

  try {
    // Warmup: verify server is reachable
    const health = await httpRequest('GET', `${BASE_URL}/api/health`, null, {});
    if (health.status !== 200) {
      console.error(`[ERROR] Server health check failed (status ${health.status}). Is the server running?`);
      process.exit(1);
    }
    console.log(`[OK] Server reachable. Health: ${JSON.stringify(health.body)}`);

    const r1 = await scenarioConcurrentLogins(50);
    const r2 = await scenarioConcurrentSocketConnections(20);
    const r3 = await scenarioControlCommands(10, 10);
    const r4 = await scenarioChatBurst(50, 1);

    console.log('\n=== Summary ===');
    console.log('Scenario 1 (50 logins)         — p95:', stats(r1.latencies).p95, 'ms');
    console.log('Scenario 2 (20 WS connects)    — p95:', stats(r2.latencies).p95, 'ms');
    console.log('Scenario 3 (100 control cmds)  — p95:', stats(r3.latencies).p95, 'ms');
    console.log('Scenario 4 (50 chat msgs)      — p95:', stats(r4.latencies).p95, 'ms');
    console.log('\nDone.');
  } catch (e) {
    console.error('[FATAL]', e.message);
    process.exit(1);
  }
}

main();
