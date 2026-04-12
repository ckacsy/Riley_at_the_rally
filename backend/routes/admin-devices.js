'use strict';

const { createRateLimiter } = require('../middleware/rateLimiter');
const {
  registerDevice,
  replaceDevice,
  disableDevice,
  enableDevice,
  regenerateKey,
  getAllDevices,
} = require('../lib/device-auth');

/**
 * Mount admin device-management routes.
 *
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   requireRole: (...roles: string[]) => Function,
 *   csrfMiddleware: Function,
 *   logAdminAudit: Function,
 * }} deps
 * @param {{
 *   CARS: Array,
 *   getDeviceSockets: () => Map|undefined,
 * }} extra
 */
module.exports = function mountAdminDevicesRoutes(app, db, deps, extra) {
  const { requireRole, csrfMiddleware, logAdminAudit } = deps;
  const { CARS, getDeviceSockets } = extra;

  const adminReadLimiter = createRateLimiter({ max: 60 });
  const adminWriteLimiter = createRateLimiter({ max: 20 });

  // -------------------------------------------------------------------------
  // Helper: disconnect a device socket for the given carId (if connected).
  // -------------------------------------------------------------------------
  function kickDeviceSocket(carId, reason) {
    const deviceSockets = typeof getDeviceSockets === 'function' ? getDeviceSockets() : null;
    if (!deviceSockets) return;
    const sock = deviceSockets.get(Number(carId));
    if (sock) {
      sock.emit('device:kicked', { reason: reason || 'admin_action' });
      sock.disconnect(true);
    }
  }

  // -------------------------------------------------------------------------
  // GET /api/admin/devices
  // List all devices, enriched with online status.
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/devices',
    adminReadLimiter,
    requireRole('admin'),
    (req, res) => {
      const all = getAllDevices(db);
      const deviceSockets = typeof getDeviceSockets === 'function' ? getDeviceSockets() : null;

      const devices = all.map((d) => ({
        ...d,
        online: deviceSockets ? deviceSockets.has(d.car_id) : false,
      }));

      res.json({ devices });
    }
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/devices
  // Register a new device for a car.
  // -------------------------------------------------------------------------
  app.post(
    '/api/admin/devices',
    adminWriteLimiter,
    requireRole('admin'),
    csrfMiddleware,
    (req, res) => {
      const { carId, name } = req.body || {};

      if (carId == null || typeof carId !== 'number' || !Number.isInteger(carId) || carId < 1) {
        return res.status(400).json({ error: 'carId обязателен и должен быть числом.' });
      }

      if (name != null && (typeof name !== 'string' || name.length > 100)) {
        return res.status(400).json({ error: 'name должен быть строкой до 100 символов.' });
      }

      const car = CARS.find((c) => c.id === carId);
      if (!car) {
        return res.status(404).json({ error: 'Машина с указанным carId не найдена.' });
      }

      let result;
      try {
        result = registerDevice(db, { carId, name });
      } catch (err) {
        if (err.code === 'DEVICE_ALREADY_EXISTS') {
          return res.status(409).json({ error: err.message });
        }
        throw err;
      }

      logAdminAudit({
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'device_registered',
        targetType: 'device',
        targetId: result.device.id,
        details: { car_id: carId, name: name || null },
      });

      res.status(201).json({
        success: true,
        device: result.device,
        deviceKey: result.rawKey,
      });
    }
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/devices/:id/replace
  // Replace an active device (hardware swap).
  // -------------------------------------------------------------------------
  app.post(
    '/api/admin/devices/:id/replace',
    adminWriteLimiter,
    requireRole('admin'),
    csrfMiddleware,
    (req, res) => {
      const deviceId = parseInt(req.params.id, 10);
      if (!Number.isInteger(deviceId) || deviceId < 1) {
        return res.status(400).json({ error: 'Некорректный id устройства.' });
      }

      const { name } = req.body || {};
      if (name != null && (typeof name !== 'string' || name.length > 100)) {
        return res.status(400).json({ error: 'name должен быть строкой до 100 символов.' });
      }

      const existing = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
      if (!existing) {
        return res.status(404).json({ error: 'Устройство не найдено.' });
      }
      if (existing.status !== 'active') {
        return res.status(409).json({ error: 'Можно заменить только активное устройство.' });
      }

      let result;
      try {
        result = replaceDevice(db, { deviceId, name });
      } catch (err) {
        if (err.code === 'DEVICE_NOT_FOUND') {
          return res.status(404).json({ error: err.message });
        }
        throw err;
      }

      // Kick old device socket (it authenticated with the old key)
      kickDeviceSocket(existing.car_id, 'device_replaced');

      logAdminAudit({
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'device_replaced',
        targetType: 'device',
        targetId: result.newDevice.id,
        details: {
          old_device_id: result.oldDevice.id,
          new_device_id: result.newDevice.id,
          car_id: existing.car_id,
        },
      });

      res.json({
        success: true,
        oldDevice: result.oldDevice,
        newDevice: result.newDevice,
        deviceKey: result.rawKey,
      });
    }
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/devices/:id/disable
  // Disable a device (blocks authentication).
  // -------------------------------------------------------------------------
  app.post(
    '/api/admin/devices/:id/disable',
    adminWriteLimiter,
    requireRole('admin'),
    csrfMiddleware,
    (req, res) => {
      const deviceId = parseInt(req.params.id, 10);
      if (!Number.isInteger(deviceId) || deviceId < 1) {
        return res.status(400).json({ error: 'Некорректный id устройства.' });
      }

      let result;
      try {
        result = disableDevice(db, deviceId);
      } catch (err) {
        if (err.code === 'DEVICE_NOT_FOUND') {
          return res.status(404).json({ error: err.message });
        }
        throw err;
      }

      kickDeviceSocket(result.device.car_id, 'device_disabled');

      logAdminAudit({
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'device_disabled',
        targetType: 'device',
        targetId: result.device.id,
        details: { car_id: result.device.car_id },
      });

      res.json({ success: true, device: result.device });
    }
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/devices/:id/enable
  // Re-enable a disabled device.
  // -------------------------------------------------------------------------
  app.post(
    '/api/admin/devices/:id/enable',
    adminWriteLimiter,
    requireRole('admin'),
    csrfMiddleware,
    (req, res) => {
      const deviceId = parseInt(req.params.id, 10);
      if (!Number.isInteger(deviceId) || deviceId < 1) {
        return res.status(400).json({ error: 'Некорректный id устройства.' });
      }

      let result;
      try {
        result = enableDevice(db, deviceId);
      } catch (err) {
        if (err.code === 'DEVICE_NOT_FOUND') {
          return res.status(404).json({ error: err.message });
        }
        if (err.code === 'DEVICE_CONFLICT') {
          return res.status(409).json({ error: err.message });
        }
        throw err;
      }

      logAdminAudit({
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'device_enabled',
        targetType: 'device',
        targetId: result.device.id,
        details: { car_id: result.device.car_id },
      });

      res.json({ success: true, device: result.device });
    }
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/devices/:id/regenerate-key
  // Generate a new authentication key for a device.
  // -------------------------------------------------------------------------
  app.post(
    '/api/admin/devices/:id/regenerate-key',
    adminWriteLimiter,
    requireRole('admin'),
    csrfMiddleware,
    (req, res) => {
      const deviceId = parseInt(req.params.id, 10);
      if (!Number.isInteger(deviceId) || deviceId < 1) {
        return res.status(400).json({ error: 'Некорректный id устройства.' });
      }

      const existing = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
      if (!existing) {
        return res.status(404).json({ error: 'Устройство не найдено.' });
      }

      let result;
      try {
        result = regenerateKey(db, deviceId);
      } catch (err) {
        if (err.code === 'DEVICE_NOT_FOUND') {
          return res.status(404).json({ error: err.message });
        }
        throw err;
      }

      // Kick device socket — it must re-authenticate with the new key
      kickDeviceSocket(existing.car_id, 'key_regenerated');

      logAdminAudit({
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'device_key_regenerated',
        targetType: 'device',
        targetId: result.device.id,
        details: { car_id: result.device.car_id },
      });

      res.json({ success: true, device: result.device, deviceKey: result.rawKey });
    }
  );
};
