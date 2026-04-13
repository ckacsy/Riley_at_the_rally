'use strict';

module.exports = function createGracefulShutdown(deps) {
  const { server, io, db, socketState, metrics, RATE_PER_MINUTE, saveRentalSession, getTokenCleanupInterval } = deps;
  let isShuttingDown = false;

  return function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    metrics.log('info', 'shutdown_start', { signal });

    server.close(() => {
      metrics.log('info', 'http_server_closed');
    });

    clearInterval(getTokenCleanupInterval());

    if (socketState && socketState.heartbeatCheckInterval) {
      clearInterval(socketState.heartbeatCheckInterval);
    }

    for (const [sessionId, session] of socketState.activeSessions) {
      try {
        socketState.clearInactivityTimeout(sessionId);
        socketState.clearSessionDurationTimeout(sessionId);
        const endTime = new Date();
        const durationMs = endTime - session.startTime;
        const durationSeconds = Math.floor(durationMs / 1000);
        const durationMinutes = durationMs / 60000;
        const cost = durationMinutes * RATE_PER_MINUTE;
        saveRentalSession(session.dbUserId, session.carId, durationSeconds, cost, session.sessionRef, 'server_shutdown');
        try {
          socketState.processHoldDeduct(session.dbUserId, session.holdAmount, cost, session.carId, durationSeconds, session.sessionRef);
        } catch (holdErr) {
          metrics.log('error', 'shutdown_hold_error', { sessionId, error: holdErr.message });
          try {
            db.prepare(
              "INSERT INTO pending_recovery (user_id, type, amount, session_ref, details_json) VALUES (?, 'hold_refund', ?, ?, ?)"
            ).run(
              session.dbUserId,
              session.holdAmount || 0,
              session.sessionRef || null,
              JSON.stringify({ carId: session.carId, durationSeconds, cost, error: holdErr.message })
            );
          } catch (recErr) {
            metrics.log('error', 'pending_recovery_insert_error', { sessionId, error: recErr.message });
          }
        }
        metrics.log('info', 'session_end', {
          userId: session.userId,
          dbUserId: session.dbUserId,
          carId: session.carId,
          durationSeconds,
          cost: parseFloat(cost.toFixed(4)),
          reason: 'server_shutdown',
        });
      } catch (e) {
        metrics.log('error', 'shutdown_session_error', { sessionId, error: e.message });
      }
    }
    socketState.activeSessions.clear();

    try {
      io.close();
      metrics.log('info', 'socketio_closed');
    } catch (e) {
      metrics.log('error', 'socketio_close_error', { error: e.message });
    }

    try {
      db.close();
      metrics.log('info', 'db_closed');
    } catch (e) {
      metrics.log('error', 'db_close_error', { error: e.message });
    }

    metrics.log('info', 'shutdown_complete', { signal });

    setTimeout(() => {
      process.stderr.write('[shutdown] Forced exit after timeout\n');
      process.exit(1);
    }, 5000).unref();

    process.exit(0);
  };
};
