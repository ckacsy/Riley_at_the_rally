'use strict';

/**
 * Log sanitizer — removes sensitive field values from objects before logging.
 *
 * Recursively walks an object and replaces the values of known sensitive
 * fields with '[REDACTED]' so they never appear in log output.
 */

// Field names whose values must be redacted (case-insensitive matching below)
const SENSITIVE_FIELDS = new Set([
  'password',
  'token',
  'secret',
  'sessionsecret',
  'device_key',
  'api_key',
  'creditcard',
  'x-csrf-token',
  'authorization',
  'cookie',
  'set-cookie',
  'resettoken',
  'verificationtoken',
  'magictoken',
]);

/**
 * Recursively sanitize an object in place (clone is returned).
 *
 * @param {*} input - any value (object, array, primitive)
 * @param {number} [depth=0] - current recursion depth (guards against circular refs)
 * @returns {*} sanitized copy
 */
function sanitize(input, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 10) return input; // max depth guard

  if (input === null || input === undefined) return input;
  if (typeof input !== 'object') return input;

  if (Array.isArray(input)) {
    return input.map((item) => sanitize(item, depth + 1));
  }

  const out = {};
  for (const key of Object.keys(input)) {
    const keyLower = key.toLowerCase().replace(/[_-]/g, '');
    if (SENSITIVE_FIELDS.has(keyLower)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = sanitize(input[key], depth + 1);
    }
  }
  return out;
}

module.exports = { sanitize };
