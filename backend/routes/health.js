'use strict';

module.exports = function mountHealthRoutes(app, deps) {
  const { io, metrics, socketState, db, https, http, createRateLimiter } = deps;

  const healthLimiter = createRateLimiter({ max: 30 });

  app.get('/api/health', healthLimiter, async (req, res) => {
    const health = { ok: true, ts: new Date().toISOString(), details: {} };

    try {
      db.prepare('SELECT 1').get();
      health.details.db = { ok: true };
    } catch (e) {
      health.ok = false;
      metrics.log('error', 'health_check_db', { error: e.message });
      health.details.db = { ok: false };
    }

    try {
      health.details.socket = { ok: true, connectedClients: io.engine.clientsCount };
    } catch (e) {
      health.ok = false;
      metrics.log('error', 'health_check_socket', { error: e.message });
      health.details.socket = { ok: false };
    }

    health.details.activeDrivers = socketState.presenceMap.size;

    const cameraUrl = process.env.CAMERA_STREAM_URL;
    if (cameraUrl) {
      try {
        await new Promise((resolve, reject) => {
          let parsed;
          try { parsed = new URL(cameraUrl); } catch (e) { return reject(e); }
          const lib = parsed.protocol === 'https:' ? https : http;
          const reqCam = lib.request(
            {
              hostname: parsed.hostname,
              port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
              path: parsed.pathname + (parsed.search || ''),
              method: 'HEAD',
              timeout: 2000,
            },
            () => resolve()
          );
          reqCam.on('error', reject);
          reqCam.on('timeout', () => { reqCam.destroy(); reject(new Error('camera stream health check timed out')); });
          reqCam.end();
        });
        health.details.camera = { ok: true };
      } catch (e) {
        metrics.log('warn', 'health_check_camera', { error: e.message });
        health.details.camera = { ok: false };
      }
    }

    if (!health.ok) {
      metrics.fireAlert('health_check_failure', health);
      metrics.log('error', 'health_check_fail', health);
      return res.status(503).json(health);
    }

    res.json(health);
  });
};
