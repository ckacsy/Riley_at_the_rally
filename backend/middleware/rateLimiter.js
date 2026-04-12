'use strict';

const rateLimit = require('express-rate-limit');

/**
 * Create a rate limiter with project defaults.
 *
 * @param {object} [options]
 * @param {number} [options.windowMs=60000]  — sliding window in ms
 * @param {number} [options.max=60]          — max requests per window
 * @param {string} [options.message]         — error message (Russian default)
 * @param {Function} [options.keyGenerator]  — key extractor (default: req.ip)
 * @param {Function} [options.skip]          — skip predicate (default: skip in test env)
 * @returns {import('express').RequestHandler}
 */
function createRateLimiter(options = {}) {
  const {
    windowMs = 60 * 1000,
    max = 60,
    message = 'Слишком много запросов. Попробуйте позже.',
    keyGenerator = (req) => req.ip,
    skip = () => process.env.NODE_ENV === 'test',
    ...rest
  } = options;

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: typeof message === 'string' ? { error: message } : message,
    keyGenerator,
    skip,
    ...rest,
  });
}

module.exports = { createRateLimiter };
