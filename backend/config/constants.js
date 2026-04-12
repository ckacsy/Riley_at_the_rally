'use strict';

// backend/config/constants.js
// Server-wide configuration constants.
// Centralises all tuneable values so they can be imported by server.js
// and socket/index.js without duplicating env-var parsing logic.

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

/** RC credits charged per minute of driving. */
const RATE_PER_MINUTE = 10;

/** Amount held (blocked) at session start (in RC credits). */
const HOLD_AMOUNT = 100;

// ---------------------------------------------------------------------------
// Session limits
// ---------------------------------------------------------------------------

/** Session inactivity timeout (ms). Defaults to 2 minutes. */
const INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;

/** Maximum session duration (ms). Overridable via SESSION_MAX_DURATION_MS env var. */
const _rawMaxDuration = parseInt(process.env.SESSION_MAX_DURATION_MS || '', 10);
if (process.env.SESSION_MAX_DURATION_MS && isNaN(_rawMaxDuration)) {
  console.warn(`Invalid SESSION_MAX_DURATION_MS value "${process.env.SESSION_MAX_DURATION_MS}", using default 600000`);
}
const SESSION_MAX_DURATION_MS = (!isNaN(_rawMaxDuration) && _rawMaxDuration > 0)
  ? _rawMaxDuration
  : 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Control command rate limiting
// ---------------------------------------------------------------------------

/** Max control commands per socket per CONTROL_RATE_LIMIT_WINDOW_MS. */
const _rawRateLimit = parseInt(process.env.CONTROL_RATE_LIMIT_MAX || '', 10);
if (process.env.CONTROL_RATE_LIMIT_MAX && isNaN(_rawRateLimit)) {
  console.warn(`Invalid CONTROL_RATE_LIMIT_MAX value "${process.env.CONTROL_RATE_LIMIT_MAX}", using default 20`);
}
const CONTROL_RATE_LIMIT_MAX = (!isNaN(_rawRateLimit) && _rawRateLimit > 0) ? _rawRateLimit : 20;

/** Sliding window size (ms) for control-command rate limiting. */
const CONTROL_RATE_LIMIT_WINDOW_MS = 1000;

// ---------------------------------------------------------------------------
// Cars
// ---------------------------------------------------------------------------

/**
 * Static car roster.  Camera URLs come from environment variables so the list
 * can be deployed without code changes.
 * @type {Array<{id: number, name: string, model: string, cameraUrl: string}>}
 */
const CARS = [
  { id: 1, name: 'Riley-X1 · Алый',    model: 'Drift Car', cameraUrl: process.env.CAR_1_CAMERA_URL || '' },
  { id: 2, name: 'Riley-X1 · Синий',   model: 'Drift Car', cameraUrl: process.env.CAR_2_CAMERA_URL || '' },
  { id: 3, name: 'Riley-X1 · Зелёный', model: 'Drift Car', cameraUrl: process.env.CAR_3_CAMERA_URL || '' },
  { id: 4, name: 'Riley-X1 · Золотой', model: 'Drift Car', cameraUrl: process.env.CAR_4_CAMERA_URL || '' },
  { id: 5, name: 'Riley-X1 · Чёрный',  model: 'Drift Car', cameraUrl: process.env.CAR_5_CAMERA_URL || '' },
];

module.exports = {
  RATE_PER_MINUTE,
  HOLD_AMOUNT,
  INACTIVITY_TIMEOUT_MS,
  SESSION_MAX_DURATION_MS,
  CONTROL_RATE_LIMIT_MAX,
  CONTROL_RATE_LIMIT_WINDOW_MS,
  CARS,
};
