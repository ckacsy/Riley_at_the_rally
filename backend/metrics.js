'use strict';

// --- Configuration ---
const WINDOW_MS = 60 * 1000; // 1-minute rolling window
const MAX_LATENCY_SAMPLES = 200; // per socket
const ALERT_ERROR_THRESHOLD = parseInt(process.env.ALERT_ERROR_THRESHOLD || '10', 10);
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between repeated alerts

// DB write latency histogram buckets (ms)
const DB_LATENCY_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000];

// --- Rolling window state ---
const commandTimestamps = []; // timestamps of control_command events
const errorTimestamps = []; // timestamps of server/auth errors
const latencyWindows = new Map(); // socketId -> [latency_ms, ...]

let lastAlertAt = 0;

// --- Gauges (set externally via setGauges / getGauges provider) ---
let gaugeProvider = null; // optional function returning { activeSessions, activeSockets, connectedDevices, staleDevices }

// --- Counters ---
const counters = {
  dbWriteLatencyHistogram: Object.fromEntries(DB_LATENCY_BUCKETS.map((b) => [b, 0])),
  dbWriteLatencyTotal: 0,       // total samples
  dbWriteLatencySum: 0,         // sum of all sample values (ms)
  paymentFailures: 0,
  sessionFinalizeFailures: 0,
  authFailures: 0,
  rateLimitHits: 0,
  orphanRecoveryCount: 0,
};

// --- Helpers ---
function pruneOld(arr) {
  const cutoff = Date.now() - WINDOW_MS;
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  if (i > 0) arr.splice(0, i);
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}

// --- Structured Logging ---

const { sanitize } = require('./lib/log-sanitizer');

/**
 * Emit a structured JSON log line.
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} event  - machine-readable event name
 * @param {object} [data] - additional context fields (sensitive values are redacted)
 */
function log(level, event, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(data ? sanitize(data) : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

// --- Metrics Recording ---

/** Record one control_command event. */
function recordCommand() {
  commandTimestamps.push(Date.now());
  pruneOld(commandTimestamps);
}

/** Record one error/auth-failure event and check alert threshold. */
function recordError() {
  errorTimestamps.push(Date.now());
  pruneOld(errorTimestamps);
  if (errorTimestamps.length >= ALERT_ERROR_THRESHOLD) {
    fireAlert('error_surge', {
      errorsPerMinute: errorTimestamps.length,
      threshold: ALERT_ERROR_THRESHOLD,
    });
  }
}

/**
 * Record server-side processing latency for a control_command on a socket.
 * @param {string} socketId
 * @param {number} ms - latency in milliseconds
 */
function recordLatency(socketId, ms) {
  if (!latencyWindows.has(socketId)) latencyWindows.set(socketId, []);
  const samples = latencyWindows.get(socketId);
  samples.push(ms);
  if (samples.length > MAX_LATENCY_SAMPLES) samples.shift();
}

/** Remove latency samples for a disconnected socket. */
function clearLatency(socketId) {
  latencyWindows.delete(socketId);
}

/**
 * Record a DB write latency sample (in ms) into the histogram.
 * @param {number} ms
 */
function recordDbLatency(ms) {
  counters.dbWriteLatencyTotal++;
  counters.dbWriteLatencySum += ms;
  for (const bucket of DB_LATENCY_BUCKETS) {
    if (ms <= bucket) {
      counters.dbWriteLatencyHistogram[bucket]++;
      break;
    }
  }
  // If larger than the largest bucket, count into the highest bucket
  if (ms > DB_LATENCY_BUCKETS[DB_LATENCY_BUCKETS.length - 1]) {
    counters.dbWriteLatencyHistogram[DB_LATENCY_BUCKETS[DB_LATENCY_BUCKETS.length - 1]]++;
  }
}

/** Increment payment_failures counter. */
function recordPaymentFailure() { counters.paymentFailures++; }

/** Increment session_finalize_failures counter. */
function recordSessionFinalizeFailure() { counters.sessionFinalizeFailures++; }

/** Increment auth_failures counter. */
function recordAuthFailure() { counters.authFailures++; }

/** Increment rate_limit_hits counter. */
function recordRateLimitHit() { counters.rateLimitHits++; }

/** Increment orphan_recovery_count counter. */
function recordOrphanRecovery() { counters.orphanRecoveryCount++; }

/**
 * Register a gauge provider function.
 * The function will be called each time getMetrics() is invoked.
 * @param {() => { activeSessions: number, activeSockets: number, connectedDevices: number, staleDevices: number }} fn
 */
function setGaugeProvider(fn) {
  gaugeProvider = fn;
}

// --- Metrics Snapshot ---

/**
 * Return a current metrics snapshot.
 * @param {Map} activeSessions - active rental session map (from socketState)
 * @param {Map} raceRooms - race room map (from socketState)
 * @param {object} [extraGauges] - optional { activeSockets, connectedDevices, staleDevices }
 */
function getMetrics(activeSessions, raceRooms, extraGauges) {
  pruneOld(commandTimestamps);
  pruneOld(errorTimestamps);

  // Aggregate all per-socket latency samples for global p95
  const allSamples = [];
  for (const samples of latencyWindows.values()) {
    for (const s of samples) allSamples.push(s);
  }
  allSamples.sort((a, b) => a - b);

  // Resolve gauges: prefer explicitly passed extraGauges, then gaugeProvider, then 0
  const gauges = (extraGauges) || (gaugeProvider && gaugeProvider()) || {};

  return {
    // Gauges
    activeSessions: activeSessions ? activeSessions.size : (gauges.activeSessions || 0),
    activeRaces: raceRooms ? raceRooms.size : 0,
    activeSockets: gauges.activeSockets || 0,
    connectedDevices: gauges.connectedDevices || 0,
    staleDevices: gauges.staleDevices || 0,
    // Rolling-window counters
    commandsPerMinute: commandTimestamps.length,
    errorsPerMinute: errorTimestamps.length,
    p95LatencyMs: percentile(allSamples, 95),
    windowMs: WINDOW_MS,
    // Cumulative counters
    counters: {
      dbWriteLatencyHistogram: { ...counters.dbWriteLatencyHistogram },
      dbWriteLatencyTotal: counters.dbWriteLatencyTotal,
      dbWriteLatencyAvgMs: counters.dbWriteLatencyTotal > 0
        ? Math.round(counters.dbWriteLatencySum / counters.dbWriteLatencyTotal)
        : null,
      paymentFailures: counters.paymentFailures,
      sessionFinalizeFailures: counters.sessionFinalizeFailures,
      authFailures: counters.authFailures,
      rateLimitHits: counters.rateLimitHits,
      orphanRecoveryCount: counters.orphanRecoveryCount,
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Render metrics in Prometheus text format.
 * @param {Map} activeSessions
 * @param {Map} raceRooms
 * @param {object} [extraGauges]
 * @returns {string} Prometheus text
 */
function getPrometheusMetrics(activeSessions, raceRooms, extraGauges) {
  const m = getMetrics(activeSessions, raceRooms, extraGauges);
  const lines = [];

  function gauge(name, help, value) {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value}`);
  }

  function counter(name, help, value) {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${value}`);
  }

  // Gauges
  gauge('riley_active_sessions', 'Number of active rental sessions', m.activeSessions);
  gauge('riley_active_races', 'Number of active race rooms', m.activeRaces);
  gauge('riley_active_sockets', 'Number of connected Socket.IO clients', m.activeSockets);
  gauge('riley_connected_devices', 'Number of connected RPi devices', m.connectedDevices);
  gauge('riley_stale_devices', 'Number of devices with stale heartbeat', m.staleDevices);

  // Rolling window
  gauge('riley_commands_per_minute', 'Control commands in the last minute', m.commandsPerMinute);
  gauge('riley_errors_per_minute', 'Errors in the last minute', m.errorsPerMinute);
  if (m.p95LatencyMs !== null) {
    gauge('riley_p95_latency_ms', 'p95 control command latency in ms', m.p95LatencyMs);
  }

  // Cumulative counters
  counter('riley_payment_failures_total', 'Total payment failures', m.counters.paymentFailures);
  counter('riley_session_finalize_failures_total', 'Total session finalize failures', m.counters.sessionFinalizeFailures);
  counter('riley_auth_failures_total', 'Total authentication failures', m.counters.authFailures);
  counter('riley_rate_limit_hits_total', 'Total rate limiter hits', m.counters.rateLimitHits);
  counter('riley_orphan_recovery_total', 'Total orphaned holds recovered', m.counters.orphanRecoveryCount);

  // DB write latency histogram
  lines.push('# HELP riley_db_write_latency_ms DB write operation latency histogram');
  lines.push('# TYPE riley_db_write_latency_ms histogram');
  let cumulative = 0;
  for (const bucket of DB_LATENCY_BUCKETS) {
    cumulative += m.counters.dbWriteLatencyHistogram[bucket] || 0;
    lines.push(`riley_db_write_latency_ms_bucket{le="${bucket}"} ${cumulative}`);
  }
  lines.push(`riley_db_write_latency_ms_bucket{le="+Inf"} ${m.counters.dbWriteLatencyTotal}`);
  lines.push(`riley_db_write_latency_ms_sum ${m.counters.dbWriteLatencyTotal > 0 ? m.counters.dbWriteLatencyAvgMs * m.counters.dbWriteLatencyTotal : 0}`);
  lines.push(`riley_db_write_latency_ms_count ${m.counters.dbWriteLatencyTotal}`);

  return lines.join('\n') + '\n';
}

// --- Alert Hook ---

/**
 * Fire an alert (console stderr + optional webhook).
 * Respects a cooldown period to avoid flooding.
 */
function fireAlert(reason, data) {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = now;

  const payload = { ts: new Date().toISOString(), reason, ...(data || {}) };
  process.stderr.write('[ALERT] ' + JSON.stringify(payload) + '\n');

  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    const url = new URL(webhookUrl);
    const body = JSON.stringify(payload);
    const lib = url.protocol === 'https:' ? require('https') : require('http');
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = lib.request(options, () => {});
    req.on('error', (e) => {
      process.stderr.write('[ALERT webhook error] ' + e.message + '\n');
    });
    req.write(body);
    req.end();
  } catch (e) {
    process.stderr.write('[ALERT webhook error] ' + e.message + '\n');
  }
}

module.exports = {
  log,
  recordCommand,
  recordError,
  recordLatency,
  clearLatency,
  recordDbLatency,
  recordPaymentFailure,
  recordSessionFinalizeFailure,
  recordAuthFailure,
  recordRateLimitHit,
  recordOrphanRecovery,
  setGaugeProvider,
  getMetrics,
  getPrometheusMetrics,
  fireAlert,
};

