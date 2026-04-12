'use strict';

const crypto = require('crypto');

/**
 * HTTP request logging middleware (task 4.6 — structured request logging).
 *
 * - Generates / propagates an X-Request-Id header.
 * - Logs every completed HTTP request as a structured JSON line via
 *   `metrics.log()`.
 * - Logs at `warn` level for 4xx/5xx responses, `info` for everything else.
 *
 * @param {object} metrics - The application metrics module (must export `log`).
 * @returns {import('express').RequestHandler}
 */
function requestLogger(metrics) {
  return (req, res, next) => {
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      metrics.log(res.statusCode >= 400 ? 'warn' : 'info', 'http_request', {
        requestId,
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        userId: req.session && req.session.userId ? req.session.userId : null,
      });
    });

    next();
  };
}

module.exports = { requestLogger };
