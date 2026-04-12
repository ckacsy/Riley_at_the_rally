CREATE TABLE IF NOT EXISTS devices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id          INTEGER NOT NULL,
  name            TEXT,
  device_key_hash TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  last_seen_at    TEXT,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
  disabled_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_car_id ON devices(car_id);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_car_active
  ON devices(car_id) WHERE status = 'active';
