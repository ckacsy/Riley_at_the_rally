'use strict';

module.exports = function mountSessionEndRoute(app, deps) {
  const { socketState, saveRentalSession, metrics, RATE_PER_MINUTE } = deps;

  app.post('/api/session/end', (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ ended: false, message: 'Invalid sessionId.' });
    }

    const reqUserId = req.session?.userId;
    if (!reqUserId) {
      return res.status(401).json({ ended: false, message: 'Authentication required.' });
    }

    const session = socketState.activeSessions.get(sessionId);
    if (!session) {
      return res.json({ ended: false, message: 'No active session found.' });
    }

    if (session.dbUserId !== reqUserId) {
      return res.status(403).json({ ended: false, message: 'Not your session.' });
    }

    socketState.clearInactivityTimeout(sessionId);
    socketState.clearSessionDurationTimeout(sessionId);
    const endTime = new Date();
    const durationMs = endTime - session.startTime;
    const durationSeconds = Math.floor(durationMs / 1000);
    const durationMinutes = durationMs / 60000;
    const cost = durationMinutes * RATE_PER_MINUTE;
    socketState.activeSessions.delete(sessionId);
    saveRentalSession(session.dbUserId, session.carId, durationSeconds, cost, session.sessionRef, 'http_beacon');
    socketState.processHoldDeduct(session.dbUserId, session.holdAmount, cost, session.carId, durationSeconds, session.sessionRef);
    socketState.broadcastCarsUpdate();
    metrics.log('info', 'session_end', {
      userId: session.userId,
      dbUserId: session.dbUserId,
      carId: session.carId,
      durationSeconds,
      cost: parseFloat(cost.toFixed(4)),
      reason: 'http_beacon',
    });
    res.json({ ended: true, carId: session.carId, durationSeconds, cost });
  });
};
