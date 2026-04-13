'use strict';

const { verifyDeviceKey } = require('../lib/device-auth');

/**
 * Handle device socket connection.
 * If the connecting socket provides carId + deviceKey it is an RC device.
 * Registers device-specific handlers and returns true (for early return in caller).
 * Returns false if this is a regular user socket.
 *
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {object} state
 * @param {object} deps
 * @returns {boolean} true if this is a device socket
 */
function setup(io, socket, state, deps) {
  const { db, metrics } = deps;
  const { carId: rawCarId, deviceKey } = socket.handshake.auth || {};

  if (rawCarId == null || !deviceKey) {
    return false;
  }

  const result = verifyDeviceKey(db, Number(rawCarId), String(deviceKey));
  if (!result.valid) {
    metrics.log('warn', 'device_auth_fail', {
      carId: rawCarId,
      reason: result.reason,
      ip: socket.handshake.address,
    });
    socket.emit('device:auth_error', { reason: result.reason });
    socket.disconnect(true);
    return true;
  }

  socket.data.isDevice = true;
  socket.data.deviceId = result.device.id;
  socket.data.carId = Number(rawCarId);
  socket.join(`car:${rawCarId}`);

  const existing = state.deviceSockets.get(Number(rawCarId));
  if (existing && existing.id !== socket.id) {
    existing.emit('device:kicked', { reason: 'new_connection' });
    existing.disconnect(true);
  }

  state.deviceSockets.set(Number(rawCarId), socket);

  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
    .run(new Date().toISOString(), result.device.id);

  socket.emit('device:auth_ok', { deviceId: result.device.id, carId: Number(rawCarId) });

  metrics.log('info', 'device_connected', {
    deviceId: result.device.id,
    carId: Number(rawCarId),
  });

  socket.on('device:heartbeat', (_data) => {
    const carIdNum = Number(rawCarId);
    const deviceId = result.device.id;
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
      .run(new Date().toISOString(), deviceId);
    socket.emit('device:heartbeat_ack', { ts: new Date().toISOString() });
    metrics.log('debug', 'device_heartbeat', { deviceId, carId: carIdNum });
  });

  socket.on('disconnect', () => {
    if (state.deviceSockets.get(Number(rawCarId))?.id === socket.id) {
      state.deviceSockets.delete(Number(rawCarId));
    }
    metrics.log('info', 'device_disconnected', {
      deviceId: result.device.id,
      carId: Number(rawCarId),
    });
  });

  return true;
}

/**
 * Start the heartbeat checker interval for stale device detection.
 *
 * @param {import('socket.io').Server} io
 * @param {object} state
 * @param {object} deps
 * @returns {NodeJS.Timeout}
 */
function startHeartbeatChecker(io, state, deps) {
  const { db, metrics, HEARTBEAT_STALE_MS, HEARTBEAT_CHECK_INTERVAL_MS } = deps;
  return setInterval(() => {
    const cutoff = new Date(Date.now() - HEARTBEAT_STALE_MS).toISOString();
    let staleDevices;
    try {
      staleDevices = db.prepare(
        "SELECT id, car_id FROM devices WHERE status = 'active' AND last_seen_at IS NOT NULL AND last_seen_at < ?"
      ).all(cutoff);
    } catch (e) {
      metrics.log('error', 'heartbeat_check_error', { error: e.message });
      return;
    }
    for (const dev of staleDevices) {
      const sock = state.deviceSockets.get(Number(dev.car_id));
      if (sock) {
        metrics.log('warn', 'device_heartbeat_timeout', { deviceId: dev.id, carId: dev.car_id });
        sock.emit('device:kicked', { reason: 'heartbeat_timeout' });
        sock.disconnect(true);
        state.deviceSockets.delete(Number(dev.car_id));
      }
    }
  }, HEARTBEAT_CHECK_INTERVAL_MS);
}

module.exports = { setup, startHeartbeatChecker };
