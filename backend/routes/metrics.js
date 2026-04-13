'use strict';

module.exports = function mountMetricsRoutes(app, deps) {
  const { metrics, socketState, io, requireAuth, createRateLimiter } = deps;

  const IS_DEV_MODE = process.env.DEBUG === 'true' || process.env.NODE_ENV !== 'production';
  const METRICS_SECRET = process.env.METRICS_SECRET || '';
  const metricsLimiter = createRateLimiter({ max: 30 });

  app.get('/api/metrics', metricsLimiter, requireAuth, (req, res) => {
    const providedSecret = req.headers['x-metrics-key'];
    if (!IS_DEV_MODE && !(METRICS_SECRET && providedSecret === METRICS_SECRET)) {
      return res.status(403).json({ error: 'Доступ запрещён' });
    }
    const extraGauges = {
      activeSockets: io.engine.clientsCount,
      connectedDevices: socketState.deviceSockets ? socketState.deviceSockets.size : 0,
      staleDevices: 0,
    };
    res.json(metrics.getMetrics(socketState.activeSessions, socketState.raceRooms, extraGauges));
  });

  app.get('/api/metrics/prometheus', metricsLimiter, requireAuth, (req, res) => {
    const providedSecret = req.headers['x-metrics-key'];
    if (!IS_DEV_MODE && !(METRICS_SECRET && providedSecret === METRICS_SECRET)) {
      return res.status(403).json({ error: 'Доступ запрещён' });
    }
    const extraGauges = {
      activeSockets: io.engine.clientsCount,
      connectedDevices: socketState.deviceSockets ? socketState.deviceSockets.size : 0,
      staleDevices: 0,
    };
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics.getPrometheusMetrics(socketState.activeSessions, socketState.raceRooms, extraGauges));
  });
};
