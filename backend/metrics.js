'use strict';

// --- Configuration ---
const WINDOW_MS = 60 * 1000; // 1-minute rolling window
const MAX_LATENCY_SAMPLES = 200; // per socket
const ALERT_ERROR_THRESHOLD = parseInt(process.env.ALERT_ERROR_THRESHOLD || '10', 10);
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between repeated alerts

// --- Rolling window state ---
const commandTimestamps = []; // timestamps of control_command events
const errorTimestamps = []; // timestamps of server/auth errors
const latencyWindows = new Map(); // socketId -> [latency_ms, ...]

let lastAlertAt = 0;

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

/**
 * Emit a structured JSON log line.
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} event  - machine-readable event name
 * @param {object} [data] - additional context fields
 */
function log(level, event, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(data || {}),
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

// --- Metrics Snapshot ---

/** Return a current metrics snapshot. Needs live references to session/race maps. */
function getMetrics(activeSessions, raceRooms) {
  pruneOld(commandTimestamps);
  pruneOld(errorTimestamps);

  // Aggregate all per-socket latency samples for global p95
  const allSamples = [];
  for (const samples of latencyWindows.values()) {
    for (const s of samples) allSamples.push(s);
  }
  allSamples.sort((a, b) => a - b);

  return {
    activeSessions: activeSessions.size,
    activeRaces: raceRooms.size,
    commandsPerMinute: commandTimestamps.length,
    errorsPerMinute: errorTimestamps.length,
    p95LatencyMs: percentile(allSamples, 95),
    windowMs: WINDOW_MS,
    timestamp: new Date().toISOString(),
  };
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
  getMetrics,
  fireAlert,
};
