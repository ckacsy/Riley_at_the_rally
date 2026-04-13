'use strict';

const { HEARTBEAT_STALE_MS } = require('../config/constants');

module.exports = function mountMetricsRoutes(app, deps) {
  const { metrics, socketState, io, requireAuth, createRateLimiter, db } = deps;

  const IS_DEV_MODE = process.env.DEBUG === 'true' || process.env.NODE_ENV !== 'production';
  const METRICS_SECRET = process.env.METRICS_SECRET || '';
  const metricsLimiter = createRateLimiter({ max: 30 });

  function getStaleDeviceCount() {
    try {
      const cutoff = new Date(Date.now() - HEARTBEAT_STALE_MS).toISOString();
      const row = db.prepare(
        "SELECT COUNT(*) as count FROM devices WHERE status = 'active' AND last_seen_at IS NOT NULL AND last_seen_at < ?"
      ).get(cutoff);
      return row ? row.count : 0;
    } catch {
      return 0;
    }
  }

  function buildExtraGauges() {
    return {
      activeSockets: io.engine.clientsCount,
      connectedDevices: socketState.deviceSockets ? socketState.deviceSockets.size : 0,
      staleDevices: getStaleDeviceCount(),
    };
  }

  app.get('/api/metrics', metricsLimiter, requireAuth, (req, res) => {
    const providedSecret = req.headers['x-metrics-key'];
    if (!IS_DEV_MODE && !(METRICS_SECRET && providedSecret === METRICS_SECRET)) {
      return res.status(403).json({ error: 'Доступ запрещён' });
    }
    res.json(metrics.getMetrics(socketState.activeSessions, socketState.raceRooms, buildExtraGauges()));
  });

  app.get('/api/metrics/prometheus', metricsLimiter, requireAuth, (req, res) => {
    const providedSecret = req.headers['x-metrics-key'];
    if (!IS_DEV_MODE && !(METRICS_SECRET && providedSecret === METRICS_SECRET)) {
      return res.status(403).json({ error: 'Доступ запрещён' });
    }
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics.getPrometheusMetrics(socketState.activeSessions, socketState.raceRooms, buildExtraGauges()));
  });
};
