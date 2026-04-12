'use strict';

/**
 * Global Express error-handling middleware (task 4.5 — server.js decomposition).
 *
 * Must be mounted **last** (after all routes) so it catches errors forwarded
 * via `next(err)` from any route handler.
 *
 * @param {object} metrics - The application metrics module (must export `log`).
 * @returns {import('express').ErrorRequestHandler}
 */
function errorHandler(metrics) {
  return (err, req, res, _next) => {
    metrics.log('error', 'unhandled_error', {
      method: req.method,
      path: req.path,
      error: err.message,
      stack: err.stack,
      requestId: req.requestId,
    });

    if (process.env.NODE_ENV === 'production') {
      return res.status(err.status || 500).json({
        error: 'Внутренняя ошибка сервера. Попробуйте позже.',
        requestId: req.requestId,
      });
    }

    res.status(err.status || 500).json({
      error: err.message,
      requestId: req.requestId,
    });
  };
}

module.exports = { errorHandler };
