'use strict';

const crypto = require('crypto');

/**
 * Generate a new device key.
 *
 * @returns {{ rawKey: string, keyHash: string }}
 *   rawKey — 64 hex characters (256-bit), shown once to the admin.
 *   keyHash — SHA-256 hex digest of rawKey, stored in the database.
 */
function generateDeviceKey() {
  const rawKey = crypto.randomBytes(32).toString('hex');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  return { rawKey, keyHash };
}

/**
 * Verify a raw device key against the stored hash for the given car.
 *
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} carId
 * @param {string} rawKey
 * @returns {{ valid: true, device: object } | { valid: false, reason: 'no_device'|'disabled'|'invalid_key' }}
 */
function verifyDeviceKey(db, carId, rawKey) {
  const device = db
    .prepare("SELECT * FROM devices WHERE car_id = ? AND status = 'active'")
    .get(carId);

  if (!device) {
    return { valid: false, reason: 'no_device' };
  }

  const inputHash = crypto.createHash('sha256').update(String(rawKey)).digest('hex');

  let safe;
  try {
    safe = crypto.timingSafeEqual(
      Buffer.from(inputHash, 'hex'),
      Buffer.from(device.device_key_hash, 'hex')
    );
  } catch (_) {
    safe = false;
  }

  if (!safe) {
    return { valid: false, reason: 'invalid_key' };
  }

  return { valid: true, device };
}

/**
 * Register a new device for the given car.
 *
 * Fails if there is already an active device for car_id.
 * Returns the raw key exactly once.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ carId: number, name?: string }} params
 * @param {{ log: Function }} [metrics]
 * @returns {{ device: object, rawKey: string }}
 */
function registerDevice(db, { carId, name }, metrics) {
  const existing = db
    .prepare("SELECT id FROM devices WHERE car_id = ? AND status = 'active'")
    .get(carId);

  if (existing) {
    const err = new Error('Для этой машины уже есть активное устройство. Используйте «Заменить» вместо создания нового.');
    err.code = 'DEVICE_ALREADY_EXISTS';
    throw err;
  }

  const { rawKey, keyHash } = generateDeviceKey();

  const result = db.prepare(
    'INSERT INTO devices (car_id, name, device_key_hash, status, created_at) VALUES (?, ?, ?, \'active\', ?)'
  ).run(carId, name || null, keyHash, new Date().toISOString());

  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(result.lastInsertRowid);

  if (metrics) {
    metrics.log('info', 'device_registered', { deviceId: device.id, carId });
  }

  return { device, rawKey };
}

/**
 * Replace an existing device with a new one (for hardware swap).
 *
 * In a single transaction: marks the old device as 'replaced' and inserts a
 * new active device with the same car_id.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ deviceId: number, name?: string }} params
 * @param {{ log: Function }} [metrics]
 * @returns {{ oldDevice: object, newDevice: object, rawKey: string }}
 */
function replaceDevice(db, { deviceId, name }, metrics) {
  const { rawKey, keyHash } = generateDeviceKey();
  const now = new Date().toISOString();

  const result = db.transaction(() => {
    const oldDevice = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
    if (!oldDevice) {
      const err = new Error('Устройство не найдено.');
      err.code = 'DEVICE_NOT_FOUND';
      throw err;
    }

    db.prepare(
      "UPDATE devices SET status = 'replaced', disabled_at = ? WHERE id = ?"
    ).run(now, deviceId);

    const ins = db.prepare(
      'INSERT INTO devices (car_id, name, device_key_hash, status, created_at) VALUES (?, ?, ?, \'active\', ?)'
    ).run(oldDevice.car_id, name || null, keyHash, now);

    const newDevice = db.prepare('SELECT * FROM devices WHERE id = ?').get(ins.lastInsertRowid);
    const updatedOld = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);

    return { oldDevice: updatedOld, newDevice };
  })();

  if (metrics) {
    metrics.log('info', 'device_replaced', {
      oldDeviceId: result.oldDevice.id,
      newDeviceId: result.newDevice.id,
      carId: result.newDevice.car_id,
    });
  }

  return { ...result, rawKey };
}

/**
 * Disable a device (prevents authentication).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} deviceId
 * @param {{ log: Function }} [metrics]
 * @returns {{ device: object }}
 */
function disableDevice(db, deviceId, metrics) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!device) {
    const err = new Error('Устройство не найдено.');
    err.code = 'DEVICE_NOT_FOUND';
    throw err;
  }

  const now = new Date().toISOString();
  db.prepare(
    "UPDATE devices SET status = 'disabled', disabled_at = ? WHERE id = ?"
  ).run(now, deviceId);

  const updated = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);

  if (metrics) {
    metrics.log('info', 'device_disabled', { deviceId, carId: updated.car_id });
  }

  return { device: updated };
}

/**
 * Re-enable a disabled device.
 *
 * Fails if another active device already exists for the same car_id.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} deviceId
 * @param {{ log: Function }} [metrics]
 * @returns {{ device: object }}
 */
function enableDevice(db, deviceId, metrics) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!device) {
    const err = new Error('Устройство не найдено.');
    err.code = 'DEVICE_NOT_FOUND';
    throw err;
  }

  const conflict = db
    .prepare("SELECT id FROM devices WHERE car_id = ? AND status = 'active' AND id != ?")
    .get(device.car_id, deviceId);

  if (conflict) {
    const err = new Error('Для этой машины уже есть другое активное устройство. Сначала отключите его.');
    err.code = 'DEVICE_CONFLICT';
    throw err;
  }

  db.prepare(
    "UPDATE devices SET status = 'active', disabled_at = NULL WHERE id = ?"
  ).run(deviceId);

  const updated = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);

  if (metrics) {
    metrics.log('info', 'device_enabled', { deviceId, carId: updated.car_id });
  }

  return { device: updated };
}

/**
 * Regenerate the authentication key for a device.
 *
 * The old key becomes invalid immediately.
 * Returns the new raw key exactly once.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} deviceId
 * @param {{ log: Function }} [metrics]
 * @returns {{ device: object, rawKey: string }}
 */
function regenerateKey(db, deviceId, metrics) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!device) {
    const err = new Error('Устройство не найдено.');
    err.code = 'DEVICE_NOT_FOUND';
    throw err;
  }

  const { rawKey, keyHash } = generateDeviceKey();
  db.prepare('UPDATE devices SET device_key_hash = ? WHERE id = ?').run(keyHash, deviceId);

  const updated = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);

  if (metrics) {
    metrics.log('info', 'device_key_regenerated', { deviceId, carId: updated.car_id });
  }

  return { device: updated, rawKey };
}

/**
 * Get the active device for a given car, or null if none exists.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} carId
 * @returns {object|null}
 */
function getDeviceForCar(db, carId) {
  return db
    .prepare("SELECT * FROM devices WHERE car_id = ? AND status = 'active'")
    .get(carId) || null;
}

/**
 * Get all devices (for admin listing).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {object[]}
 */
function getAllDevices(db) {
  return db.prepare('SELECT * FROM devices ORDER BY id DESC').all();
}

module.exports = {
  generateDeviceKey,
  verifyDeviceKey,
  registerDevice,
  replaceDevice,
  disableDevice,
  enableDevice,
  regenerateKey,
  getDeviceForCar,
  getAllDevices,
};
