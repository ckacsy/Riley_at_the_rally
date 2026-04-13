'use strict';

module.exports = function mountConfigRoutes(app, deps) {
  const { SESSION_MAX_DURATION_MS, INACTIVITY_TIMEOUT_MS } = deps;

  app.get('/api/config/session', (req, res) => {
    res.json({
      sessionMaxDurationMs: SESSION_MAX_DURATION_MS,
      inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
    });
  });

  app.get('/api/config/video', (req, res) => {
    const raw = (process.env.VIDEO_STREAM_URL || '').trim();
    if (!raw) {
      return res.json({ streamUrl: null, type: null });
    }
    const lower = raw.toLowerCase();
    let type;
    if (lower.endsWith('.mjpeg') || lower.endsWith('.jpg')) {
      type = 'mjpeg';
    } else {
      type = 'hls';
    }
    res.json({ streamUrl: raw, type });
  });
};
