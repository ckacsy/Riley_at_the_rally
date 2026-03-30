// Must be first: override DNS so Node.js can resolve hostnames in VPN/Docker/WSL
// environments where the system resolver is broken for the Node.js process.
// Configurable via DNS_SERVERS env var (comma-separated IPs).
{
  const dns = require('dns');
  // Basic IPv4/IPv6 validation — reject non-IP entries (hostnames, empty strings, etc.)
  const isValidIP = s => /^(\d{1,3}\.){3}\d{1,3}$/.test(s) || /^[0-9a-fA-F:]+$/.test(s);
  const servers = (process.env.DNS_SERVERS || '8.8.8.8,8.8.4.4')
    .split(',')
    .map(s => s.trim())
    .filter(isValidIP);
  if (servers.length > 0) {
    try {
      dns.setServers(servers);
    } catch (e) {
      console.warn('[DNS] Failed to set DNS servers — check DNS_SERVERS environment variable:', e.message);
    }
  }
}

const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const socketIo = require('socket.io');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
// Load environment variables from backend/.env (works regardless of cwd).
// Falls back to repo-root .env if backend/.env does not exist.
{
  const backendEnvPath = path.join(__dirname, '.env');
  const rootEnvPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(backendEnvPath)) {
    const result = require('dotenv').config({ path: backendEnvPath });
    if (result.error) {
      console.warn(`[dotenv] Failed to parse ${backendEnvPath}:`, result.error.message);
    } else {
      console.log(`[dotenv] Loaded env from: ${backendEnvPath}`);
    }
  } else if (fs.existsSync(rootEnvPath)) {
    const result = require('dotenv').config({ path: rootEnvPath });
    if (result.error) {
      console.warn(`[dotenv] Failed to parse ${rootEnvPath}:`, result.error.message);
    } else {
      console.log(`[dotenv] Loaded env from fallback: ${rootEnvPath}`);
    }
  } else {
    console.warn(`[dotenv] No .env file found at ${backendEnvPath} or ${rootEnvPath}; relying on process environment.`);
  }
}

const metrics = require('./metrics');
const mailer = require('./mailer');
const { isKnownRole, STATUSES } = require('./middleware/roles');
const { logAdminAudit } = require('./utils/adminAudit');

const {
  validateUsername,
  validateEmail,
  validatePassword,
  normalizeEmail,
  normalizeUsername,
  normalizeText,
} = require('./validators');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());

// Session middleware — uses connect-sqlite3 to persist sessions across server
// restarts, replacing the default in-memory store which lost sessions on restart.
const SESSION_SECRET = process.env.SESSION_SECRET || 'riley-secret-change-in-production';
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: __dirname }),
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
});
app.use(sessionMiddleware);

const PORT = process.env.PORT || 5000;
const RATE_PER_MINUTE = 10;
const INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes AFK
// Max session duration: default 10 min, override via SESSION_MAX_DURATION_MS env var
const _rawMaxDuration = parseInt(process.env.SESSION_MAX_DURATION_MS || '', 10);
if (process.env.SESSION_MAX_DURATION_MS && isNaN(_rawMaxDuration)) {
  console.warn(`Invalid SESSION_MAX_DURATION_MS value "${process.env.SESSION_MAX_DURATION_MS}", using default 600000`);
}
const SESSION_MAX_DURATION_MS = (!isNaN(_rawMaxDuration) && _rawMaxDuration > 0) ? _rawMaxDuration : 10 * 60 * 1000;
// Control command rate limit: max commands per sliding window per socket
const _rawRateLimit = parseInt(process.env.CONTROL_RATE_LIMIT_MAX || '', 10);
if (process.env.CONTROL_RATE_LIMIT_MAX && isNaN(_rawRateLimit)) {
  console.warn(`Invalid CONTROL_RATE_LIMIT_MAX value "${process.env.CONTROL_RATE_LIMIT_MAX}", using default 20`);
}
const CONTROL_RATE_LIMIT_MAX = (!isNaN(_rawRateLimit) && _rawRateLimit > 0) ? _rawRateLimit : 20; // per second
const CONTROL_RATE_LIMIT_WINDOW_MS = 1000;

const CARS = [
  { id: 1, name: 'Riley-X1 · Алый',    model: 'Drift Car', cameraUrl: process.env.CAR_1_CAMERA_URL || '' },
  { id: 2, name: 'Riley-X1 · Синий',   model: 'Drift Car', cameraUrl: process.env.CAR_2_CAMERA_URL || '' },
  { id: 3, name: 'Riley-X1 · Зелёный', model: 'Drift Car', cameraUrl: process.env.CAR_3_CAMERA_URL || '' },
  { id: 4, name: 'Riley-X1 · Золотой', model: 'Drift Car', cameraUrl: process.env.CAR_4_CAMERA_URL || '' },
  { id: 5, name: 'Riley-X1 · Чёрный',  model: 'Drift Car', cameraUrl: process.env.CAR_5_CAMERA_URL || '' },
];

// Serve frontend static files
const frontendDir = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendDir));

// --- SQLite Database ---
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'riley.sqlite');
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    username_normalized TEXT UNIQUE,
    display_name TEXT,
    email TEXT UNIQUE NOT NULL,
    email_normalized TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    avatar_path TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT,
    last_login_at TEXT,
    username_changed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS lap_times (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    car_id INTEGER,
    car_name TEXT,
    lap_time_ms INTEGER NOT NULL,
    race_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS rental_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    car_id INTEGER,
    car_name TEXT,
    duration_seconds INTEGER,
    cost REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    deleted INTEGER DEFAULT 0,
    deleted_by TEXT,
    deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS magic_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_magic_links_token_hash ON magic_links(token_hash);
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    balance_after REAL NOT NULL,
    description TEXT,
    reference_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
  CREATE TABLE IF NOT EXISTS payment_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    yookassa_payment_id TEXT UNIQUE,
    amount REAL NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_payment_orders_yookassa_id ON payment_orders(yookassa_payment_id);
`);

// --- DB Migrations (add new columns to existing databases) ---
(function runMigrations() {
  const userCols = new Set(db.pragma('table_info(users)').map((c) => c.name));

  if (!userCols.has('display_name')) db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
  if (!userCols.has('username_normalized')) db.exec('ALTER TABLE users ADD COLUMN username_normalized TEXT');
  if (!userCols.has('email_normalized')) db.exec('ALTER TABLE users ADD COLUMN email_normalized TEXT');
  if (!userCols.has('status')) {
    // Add nullable column first, then backfill — SQLite forbids NOT NULL without constant default in ADD COLUMN
    db.exec("ALTER TABLE users ADD COLUMN status TEXT");
    db.exec("UPDATE users SET status = 'active' WHERE status IS NULL");
  }
  if (!userCols.has('updated_at')) {
    // SQLite disallows non-constant (e.g. CURRENT_TIMESTAMP) DEFAULT in ADD COLUMN
    db.exec('ALTER TABLE users ADD COLUMN updated_at TEXT');
    db.exec("UPDATE users SET updated_at = COALESCE(created_at, CURRENT_TIMESTAMP) WHERE updated_at IS NULL");
  }
  if (!userCols.has('last_login_at')) db.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT');
  if (!userCols.has('username_changed_at')) {
    try { db.exec('ALTER TABLE users ADD COLUMN username_changed_at TEXT'); } catch (e) { /* already exists */ }
  }
  if (!userCols.has('balance')) {
    try { db.exec('ALTER TABLE users ADD COLUMN balance REAL DEFAULT 0'); } catch (e) { /* already exists */ }
  }

  // --- PR 1: role, soft-delete fields ---
  if (!userCols.has('role')) {
    // SQLite requires a constant DEFAULT for NOT NULL columns added via ALTER TABLE
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }
  if (!userCols.has('deleted_at')) {
    try { db.exec('ALTER TABLE users ADD COLUMN deleted_at TEXT'); } catch (e) { /* already exists */ }
  }
  if (!userCols.has('deleted_by')) {
    try { db.exec('ALTER TABLE users ADD COLUMN deleted_by INTEGER'); } catch (e) { /* already exists */ }
  }

  // Normalize legacy 'disabled' status to 'banned'
  db.exec("UPDATE users SET status = 'banned' WHERE status = 'disabled'");

  // Backfill normalized fields for existing rows
  db.prepare(
    `UPDATE users SET
       email_normalized = LOWER(TRIM(email)),
       username_normalized = LOWER(TRIM(username))
     WHERE email_normalized IS NULL OR username_normalized IS NULL`
  ).run();

  // Create unique indexes (safe to re-run)
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_norm ON users(email_normalized)');
  } catch (e) { console.warn('Index warning (email_norm):', e.message); }
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_norm ON users(username_normalized)');
  } catch (e) { console.warn('Index warning (username_norm):', e.message); }

  // --- PR 1: transactions — admin_id, idempotency_key ---
  const transCols = new Set(db.pragma('table_info(transactions)').map((c) => c.name));
  if (!transCols.has('admin_id')) {
    try { db.exec('ALTER TABLE transactions ADD COLUMN admin_id INTEGER'); } catch (e) { /* already exists */ }
  }
  if (!transCols.has('idempotency_key')) {
    try { db.exec('ALTER TABLE transactions ADD COLUMN idempotency_key TEXT'); } catch (e) { /* already exists */ }
  }

  // Indexes on transactions
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_reference_id ON transactions(reference_id)'); } catch (e) { /* ignore */ }
  try {
    // Partial unique index — SQLite supports WHERE clause in CREATE INDEX
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_idempotency_key ON transactions(idempotency_key) WHERE idempotency_key IS NOT NULL');
  } catch (e) { /* ignore */ }
  // --- PR 7: additional transaction indexes for dashboard queries ---
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at)'); } catch (e) { /* ignore */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_type_created ON transactions(type, created_at)'); } catch (e) { /* ignore */ }

  // --- PR 1: admin_audit_log table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER,
      details_json TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_audit_admin_id ON admin_audit_log(admin_id)'); } catch (e) { /* ignore */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_audit_created_at ON admin_audit_log(created_at)'); } catch (e) { /* ignore */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_audit_action ON admin_audit_log(action)'); } catch (e) { /* ignore */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_audit_target_type ON admin_audit_log(target_type)'); } catch (e) { /* ignore */ }

  // --- PR 3: news table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      summary TEXT,
      body_markdown TEXT NOT NULL,
      body_html TEXT NOT NULL,
      cover_image TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      pinned INTEGER NOT NULL DEFAULT 0,
      author_id INTEGER NOT NULL,
      published_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    )
  `);
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_news_slug ON news(slug)'); } catch (e) { /* ignore */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_news_status ON news(status)'); } catch (e) { /* ignore */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_news_published_at ON news(published_at)'); } catch (e) { /* ignore */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_news_pinned ON news(pinned)'); } catch (e) { /* ignore */ }

  // --- PR 6: rental_sessions indexes ---
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_rental_sessions_user_id ON rental_sessions(user_id)'); } catch (e) { /* ignore */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_rental_sessions_car_id ON rental_sessions(car_id)'); } catch (e) { /* ignore */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_rental_sessions_created_at ON rental_sessions(created_at)'); } catch (e) { /* ignore */ }

  // --- PR 8: analytics index ---
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_rental_sessions_car_created ON rental_sessions(car_id, created_at)'); } catch (e) { /* ignore */ }
})();

// --- File uploads (avatars) ---
const { upload, uploadsDir } = require('./middleware/upload');
app.use('/uploads', express.static(uploadsDir));

// --- CSRF helpers ---
function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function csrfMiddleware(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.headers['x-csrf-token'] || (req.body && req.body._csrf);
  if (!token || !req.session.csrfToken || token !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Недопустимый CSRF-токен. Обновите страницу и попробуйте снова.' });
  }
  next();
}

// General API rate limiter — used by auth routes and /api/leaderboard
const apiReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
  keyGenerator: (req) => req.ip,
  skip: () => process.env.NODE_ENV === 'test',
});

// Mount all auth & profile routes; get back shared middleware and dev maps
const mountAuthRoutes = require('./routes/auth');
const { requireAuth, requireActiveUser, loadCurrentUser, requireRole, _devVerificationLinks, _devMagicLinks, _devResetLinks } = mountAuthRoutes(app, db, {
  csrfMiddleware,
  generateCsrfToken,
  apiReadLimiter,
  PORT,
});

const adminRouteDeps = {
  requireAuth,
  requireActiveUser,
  loadCurrentUser,
  requireRole,
  csrfMiddleware,
  logAdminAudit: (auditData) => logAdminAudit(db, auditData),
};
app.locals.adminRouteDeps = adminRouteDeps;

const mountPaymentRoutes = require('./routes/payment');
mountPaymentRoutes(app, db, { requireAuth, requireActiveUser, csrfMiddleware, apiReadLimiter, getActiveSessions: () => socketState && socketState.activeSessions });

const mountAdminRoutes = require('./routes/admin');
mountAdminRoutes(app, db, adminRouteDeps);

const mountNewsRoutes = require('./routes/news');
mountNewsRoutes(app, db, adminRouteDeps);

const mountAdminSessionRoutes = require('./routes/admin-sessions');
mountAdminSessionRoutes(app, db, adminRouteDeps);

const mountAdminTransactionRoutes = require('./routes/admin-transactions');
mountAdminTransactionRoutes(app, db, adminRouteDeps);

const mountAdminAnalyticsRoutes = require('./routes/admin-analytics');
mountAdminAnalyticsRoutes(app, db, adminRouteDeps);

function saveRentalSession(dbUserId, carId, durationSeconds, cost) {
  if (!dbUserId) return;
  const carName = CARS.find((c) => c.id === carId)?.name || ('Машина #' + carId);
  try {
    db.prepare(
      'INSERT INTO rental_sessions (user_id, car_id, car_name, duration_seconds, cost) VALUES (?, ?, ?, ?, ?)'
    ).run(dbUserId, carId, carName, durationSeconds, cost);
  } catch (e) {
    console.error('Failed to save rental session:', e.message);
  }
}

const ADMIN_USERNAMES = new Set(
  (process.env.ADMIN_USERNAMES || '').split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

// Periodic cleanup of expired magic links (older than 24 hours)
setInterval(() => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(
    "DELETE FROM magic_links WHERE expires_at < ?"
  ).run(cutoff);
  if (result.changes > 0) {
    metrics.log('debug', 'magic_links_cleaned', { deleted: result.changes });
  }
}, 60 * 60 * 1000); // every hour

// Set up all Socket.IO logic and get back shared state for REST endpoints
const { setupSocketIo } = require('./socket');
const socketState = setupSocketIo(io, {
  db,
  sessionMiddleware,
  metrics,
  RATE_PER_MINUTE,
  SESSION_MAX_DURATION_MS,
  INACTIVITY_TIMEOUT_MS,
  CONTROL_RATE_LIMIT_MAX,
  CONTROL_RATE_LIMIT_WINDOW_MS,
  CARS,
  saveRentalSession,
  ADMIN_USERNAMES,
});

// Expose session state and constants for admin-sessions route (lazy access)
app.locals.getActiveSessions = () => socketState.activeSessions;
app.locals.getCars = () => CARS;
app.locals.getRatePerMinute = () => RATE_PER_MINUTE;

// Car availability status tracking
let carStatusLastUpdated = new Date().toISOString();
let prevCarStatus = null;

function getCarAvailabilityStatus() {
  let status;
  if (process.env.CAR_OFFLINE === 'true') {
    status = 'offline';
  } else if (socketState.activeSessions.size > 0) {
    status = 'busy';
  } else {
    status = 'available';
  }
  if (status !== prevCarStatus) {
    carStatusLastUpdated = new Date().toISOString();
    prevCarStatus = status;
  }
  return { status, lastUpdated: carStatusLastUpdated };
}

// --- Routes ---

const healthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
  keyGenerator: (req) => req.ip,
  skip: () => process.env.NODE_ENV === 'test',
});

app.get('/api/health', healthLimiter, async (req, res) => {
  const health = { ok: true, ts: new Date().toISOString(), details: {} };

  // DB connectivity check
  try {
    db.prepare('SELECT 1').get();
    health.details.db = { ok: true };
  } catch (e) {
    health.ok = false;
    health.details.db = { ok: false, error: e.message };
  }

  // Socket subsystem check
  try {
    health.details.socket = { ok: true, connectedClients: io.engine.clientsCount };
  } catch (e) {
    health.ok = false;
    health.details.socket = { ok: false, error: e.message };
  }

  // Active driver presence count
  health.details.activeDrivers = socketState.presenceMap.size;

  // Camera stream check (optional — only if CAMERA_STREAM_URL is configured)
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
      // Camera is optional — report but do not fail overall health
      health.details.camera = { ok: false, error: e.message };
    }
  }

  if (!health.ok) {
    metrics.fireAlert('health_check_failure', health);
    metrics.log('error', 'health_check_fail', health);
    return res.status(503).json(health);
  }

  res.json(health);
});

// --- Metrics endpoint ---
const IS_DEV_MODE = process.env.DEBUG === 'true' || process.env.NODE_ENV !== 'production';
const METRICS_SECRET = process.env.METRICS_SECRET || '';

const metricsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
  keyGenerator: (req) => req.ip,
  skip: () => process.env.NODE_ENV === 'test',
});

app.get('/api/metrics', metricsLimiter, requireAuth, (req, res) => {
  // Access control: open in debug/dev mode; require METRICS_SECRET header in production
  const providedSecret = req.headers['x-metrics-key'];
  if (!IS_DEV_MODE && !(METRICS_SECRET && providedSecret === METRICS_SECRET)) {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  res.json(metrics.getMetrics(socketState.activeSessions, socketState.raceRooms));
});
app.get('/api/cars', (req, res) => {
  const activeCars = new Set([...socketState.activeSessions.values()].map((s) => s.carId));
  res.json({
    ratePerMinute: RATE_PER_MINUTE,
    cars: CARS.map((c) => ({ ...c, status: activeCars.has(c.id) ? 'unavailable' : 'available' })),
  });
});

// API: Car availability status (available / busy / offline)
app.get('/api/car-status', (req, res) => {
  res.json(getCarAvailabilityStatus());
});

// API: Get active race sessions
app.get('/api/races', (req, res) => {
  const races = [...socketState.raceRooms.values()].map((r) => ({
    id: r.id,
    name: r.name,
    playerCount: r.players.length,
    status: r.status,
    createdAt: r.createdAt,
  }));
  res.json({ races });
});

// API: Get global leaderboard (top 10 best lap times) — sourced from SQLite for persistence across restarts
// Supports ?range=all|week|day (default: all)
app.get('/api/leaderboard', apiReadLimiter, (req, res) => {
  const range = req.query.range;
  const validRanges = ['all', 'week', 'day'];
  const selectedRange = validRanges.includes(range) ? range : 'all';

  const baseQuery = `SELECT lt.lap_time_ms AS lapTimeMs,
                lt.car_name   AS carName,
                lt.created_at AS date,
                COALESCE(u.username, CAST(lt.user_id AS TEXT)) AS userId
           FROM lap_times lt
      LEFT JOIN users u ON lt.user_id = u.id`;
  const orderLimit = `ORDER BY lt.lap_time_ms ASC LIMIT 10`;

  try {
    let rows;
    if (selectedRange === 'week') {
      rows = db
        .prepare(`${baseQuery} WHERE lt.created_at >= datetime('now', '-7 days') ${orderLimit}`)
        .all();
    } else if (selectedRange === 'day') {
      rows = db
        .prepare(`${baseQuery} WHERE lt.created_at >= datetime('now', '-1 day') ${orderLimit}`)
        .all();
    } else {
      rows = db
        .prepare(`${baseQuery} ${orderLimit}`)
        .all();
    }
    res.json({ leaderboard: rows, range: selectedRange });
  } catch (e) {
    console.error('Leaderboard query error:', e.message);
    res.status(500).json({ error: 'Не удалось загрузить таблицу рекордов.' });
  }
});

// Session config (public read, for frontend hydration)
app.get('/api/config/session', (req, res) => {
  res.json({
    sessionMaxDurationMs: SESSION_MAX_DURATION_MS,
    inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
  });
});

// Video stream config — derived from VIDEO_STREAM_URL env var.
// Returns { streamUrl, type } where type is 'hls' or 'mjpeg'.
// streamUrl is null when the env var is not set.
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

// End session via HTTP (used by navigator.sendBeacon on page unload)
app.post('/api/session/end', (req, res) => {
  const { sessionId, dbUserId } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ ended: false, message: 'Invalid sessionId.' });
  }
  const session = socketState.activeSessions.get(sessionId);
  if (!session) {
    return res.json({ ended: false, message: 'No active session found.' });
  }
  socketState.clearInactivityTimeout(sessionId);
  const endTime = new Date();
  const durationMs = endTime - session.startTime;
  const durationSeconds = Math.floor(durationMs / 1000);
  const durationMinutes = durationMs / 60000;
  const cost = durationMinutes * RATE_PER_MINUTE;
  socketState.activeSessions.delete(sessionId);
  const effectiveDbUserId = session.dbUserId || (Number.isInteger(dbUserId) ? dbUserId : null);
  saveRentalSession(effectiveDbUserId, session.carId, durationSeconds, cost);
  socketState.processHoldDeduct(effectiveDbUserId, session.holdAmount, cost, session.carId, durationSeconds);
  socketState.broadcastCarsUpdate();
  metrics.log('info', 'session_end', {
    userId: session.userId,
    dbUserId: effectiveDbUserId,
    carId: session.carId,
    durationSeconds,
    cost: parseFloat(cost.toFixed(4)),
    reason: 'http_beacon',
  });
  res.json({ ended: true, carId: session.carId, durationSeconds, cost });
});

// Routes for frontend pages
const pageRateLimit = rateLimit({ windowMs: 60 * 1000, max: 60 });

app.get('/', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

app.get('/control', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'control.html'));
});

app.get('/register', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'register.html'));
});

app.get('/login', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'login.html'));
});

app.get('/profile', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'profile.html'));
});

app.get('/verify-email', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'verify-email.html'));
});

app.get('/forgot-password', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'forgot-password.html'));
});

app.get('/reset-password', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'reset-password.html'));
});

app.get('/magic-link', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'magic-link.html'));
});

app.get('/garage', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'garage.html'));
});

app.get('/broadcast', pageRateLimit, (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  res.sendFile(path.join(frontendDir, 'broadcast.html'));
});

// /track is an alias for /broadcast (Трансляция трека)
app.get('/track', pageRateLimit, (req, res) => {
  if (!req.session.userId) return res.redirect('/login?redirect=/track');
  res.redirect('/broadcast');
});

// Admin pages (frontend route guards handle role checks)
app.get('/admin', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'admin.html'));
});

app.get('/admin-users', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'admin-users.html'));
});

app.get('/admin-news', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'admin-news.html'));
});

app.get('/admin-audit', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'admin-audit.html'));
});

app.get('/admin-sessions', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'admin-sessions.html'));
});

app.get('/admin-transactions', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'admin-transactions.html'));
});

app.get('/admin-analytics', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'admin-analytics.html'));
});

// --- Dev-only: reset database (delete all users and sessions) ---
// Accessible only when NODE_ENV !== 'production'
if (process.env.NODE_ENV !== 'production') {
  const devLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests from this IP, please try again later.' },
    keyGenerator: (req) => req.ip,
    skip: () => process.env.NODE_ENV === 'test',
  });

  // Dev helper: retrieve the current pending verification link for a user by email.
  // Useful when SMTP is misconfigured and emails cannot be delivered.
  app.get('/api/dev/verification-link', devLimiter, (req, res) => {
    const rawEmail = typeof req.query.email === 'string' ? req.query.email.trim() : '';
    if (!rawEmail) {
      return res.status(400).json({ error: 'Query param "email" is required' });
    }
    const emailNorm = normalizeEmail(rawEmail);
    const user = db
      .prepare('SELECT id, username, status FROM users WHERE email_normalized = ?')
      .get(emailNorm);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (user.status !== 'pending') {
      return res.status(400).json({ error: 'Account is already verified', status: user.status });
    }
    const link = _devVerificationLinks && _devVerificationLinks.get(emailNorm);
    if (!link) {
      return res.status(404).json({
        error: 'No verification link in memory. Try resending from the profile page (POST /api/auth/resend-verification) -- the new link will be stored here.',
      });
    }
    return res.json({ verificationLink: link });
  });

  // Dev helper: retrieve the last magic link URL for a given email.
  // Useful when SMTP is misconfigured and emails cannot be delivered.
  app.get('/api/dev/magic-link', devLimiter, (req, res) => {
    const rawEmail = typeof req.query.email === 'string' ? req.query.email.trim() : '';
    if (!rawEmail) {
      return res.status(400).json({ error: 'Query param "email" is required' });
    }
    const emailNorm = normalizeEmail(rawEmail);
    const link = _devMagicLinks && _devMagicLinks.get(emailNorm);
    if (!link) {
      return res.status(404).json({
        error: 'No magic link in memory. Request a magic link first via POST /api/auth/magic-link.',
      });
    }
    return res.json({ magicLink: link });
  });

  // Dev helper: retrieve the last password reset link URL for a given email.
  // Useful when SMTP is misconfigured and emails cannot be delivered.
  app.get('/api/dev/reset-link', devLimiter, (req, res) => {
    const rawEmail = typeof req.query.email === 'string' ? req.query.email.trim() : '';
    if (!rawEmail) {
      return res.status(400).json({ error: 'Query param "email" is required' });
    }
    const emailNorm = normalizeEmail(rawEmail);
    const link = _devResetLinks && _devResetLinks.get(emailNorm);
    if (!link) {
      return res.status(404).json({
        error: 'No reset link in memory. Request a password reset first via POST /api/auth/forgot-password.',
      });
    }
    return res.json({ resetLink: link });
  });

  app.post('/api/dev/reset-db', (req, res) => {
    try {
      db.transaction(() => {
        db.exec('DELETE FROM email_verification_tokens');
        db.exec('DELETE FROM password_reset_tokens');
        db.exec('DELETE FROM magic_links');
        db.exec('DELETE FROM lap_times');
        db.exec('DELETE FROM rental_sessions');
        db.exec('DELETE FROM chat_messages');
        db.exec('DELETE FROM transactions');
        db.exec('DELETE FROM payment_orders');
        db.exec('DELETE FROM news');
        db.exec('DELETE FROM admin_audit_log');
        db.exec('DELETE FROM users');
        // Reset autoincrement counters
        db.exec("DELETE FROM sqlite_sequence WHERE name IN ('users','lap_times','rental_sessions','email_verification_tokens','password_reset_tokens','chat_messages','magic_links','transactions','payment_orders','news','admin_audit_log')");
      })();
      req.session.destroy((err) => { if (err) console.error('Session destroy error:', err); });
      if (_devVerificationLinks) _devVerificationLinks.clear();
      if (_devMagicLinks) _devMagicLinks.clear();
      if (_devResetLinks) _devResetLinks.clear();
      // Clear active rental sessions and their associated timeouts
      for (const [sid] of socketState.activeSessions) {
        socketState.clearInactivityTimeout(sid);
        socketState.clearSessionDurationTimeout(sid);
      }
      socketState.activeSessions.clear();
      // Clear race rooms
      socketState.raceRooms.clear();
      // Clear in-memory driver presence
      for (const timer of socketState.presenceGraceTimers.values()) clearTimeout(timer);
      socketState.presenceGraceTimers.clear();
      socketState.presenceMap.clear();
      socketState.broadcastPresenceUpdate();
      // Clear chat rate limits (messages already removed from DB above)
      socketState.chatRateLimits.clear();
      // Broadcast clean car state to all connected sockets
      socketState.broadcastCarsUpdate();
      console.log('[DEV] Database reset: all users and sessions deleted.');
      res.json({ success: true, message: 'Database reset: all users, sessions and tokens deleted.' });
    } catch (e) {
      console.error('Dev reset error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Dev helper: insert a rental session directly for testing.
  app.post('/api/dev/rental-sessions/insert', devLimiter, (req, res) => {
    const { user_id, car_id, car_name, duration_seconds, cost } = req.body || {};
    if (!user_id || !car_id) return res.status(400).json({ error: 'user_id and car_id required' });
    const result = db.prepare(
      'INSERT INTO rental_sessions (user_id, car_id, car_name, duration_seconds, cost) VALUES (?, ?, ?, ?, ?)'
    ).run(
      Number(user_id),
      Number(car_id),
      car_name || ('Машина #' + car_id),
      Number(duration_seconds) || 0,
      Number(cost) || 0
    );
    const row = db.prepare('SELECT * FROM rental_sessions WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, session: row });
  });

  // Dev helper: insert a transaction directly for testing.
  app.post('/api/dev/transactions/insert', devLimiter, (req, res) => {
    const { user_id, type, amount, balance_after, description, reference_id, admin_id } = req.body || {};
    if (!user_id || !type || amount === undefined || balance_after === undefined) {
      return res.status(400).json({ error: 'user_id, type, amount, balance_after required' });
    }
    const result = db.prepare(
      'INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id, admin_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      Number(user_id),
      String(type),
      Number(amount),
      Number(balance_after),
      description || null,
      reference_id || null,
      admin_id ? Number(admin_id) : null
    );
    const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, transaction: row });
  });


  // Only available in non-production environments.
  app.post('/api/dev/activate-user', devLimiter, (req, res) => {
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username required' });
    const usernameNorm = normalizeUsername(username);
    const result = db
      .prepare("UPDATE users SET status = 'active', balance = 200, updated_at = CURRENT_TIMESTAMP WHERE username_normalized = ?")
      .run(usernameNorm);
    if (result.changes === 0) {
      if (process.env.NODE_ENV === 'test') {
        console.log(`[DEV] activate-user: not found for username_normalized='${usernameNorm}', DB_PATH=${DB_PATH}`);
      }
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ success: true });
  });

  app.post('/api/dev/set-user-status', devLimiter, (req, res) => {
    const { username, status } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username required' });
    if (typeof status !== 'string' || (!Object.values(STATUSES).includes(status) && status !== 'disabled')) {
      return res.status(400).json({ error: 'valid status required' });
    }
    const usernameNorm = normalizeUsername(username);
    const result = db
      .prepare('UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE username_normalized = ?')
      .run(status, usernameNorm);
    if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
    const user = db
      .prepare('SELECT id, username, status, role FROM users WHERE username_normalized = ?')
      .get(usernameNorm);
    res.json({ success: true, user });
  });

  app.post('/api/dev/set-user-role', devLimiter, (req, res) => {
    const { username, role } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username required' });
    if (typeof role !== 'string' || !isKnownRole(role)) {
      return res.status(400).json({ error: 'valid role required' });
    }
    const usernameNorm = normalizeUsername(username);
    const result = db
      .prepare('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE username_normalized = ?')
      .run(role, usernameNorm);
    if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
    const user = db
      .prepare('SELECT id, username, status, role FROM users WHERE username_normalized = ?')
      .get(usernameNorm);
    res.json({ success: true, user });
  });

  app.get('/api/dev/role-probe/admin', devLimiter, adminRouteDeps.requireRole('admin'), (req, res) => {
    res.json({
      success: true,
      user: req.user ? {
        id: req.user.id,
        username: req.user.username,
        status: req.user.status,
        role: req.user.role,
      } : null,
    });
  });

  app.post('/api/dev/admin-audit-log/write', devLimiter, adminRouteDeps.requireRole('admin'), csrfMiddleware, (req, res) => {
    const { action, targetType, targetId, details } = req.body || {};
    if (!action || typeof action !== 'string') return res.status(400).json({ error: 'action required' });
    if (!targetType || typeof targetType !== 'string') return res.status(400).json({ error: 'targetType required' });
    const targetIdAsNumber = Number(targetId);

    adminRouteDeps.logAdminAudit({
      adminId: req.user.id,
      action,
      targetType,
      targetId: Number.isInteger(targetIdAsNumber) ? targetIdAsNumber : null,
      details: details && typeof details === 'object' ? details : null,
      ipAddress: req.ip || null,
      userAgent: req.get('user-agent') || null,
    });

    const row = db.prepare(
      `SELECT id, admin_id, action, target_type, target_id, details_json, ip_address, user_agent, created_at
         FROM admin_audit_log
        WHERE admin_id = ? AND action = ? AND target_type = ?
        ORDER BY id DESC
        LIMIT 1`
    ).get(req.user.id, action, targetType);

    res.json({ success: true, row });
  });

  // Dev helper: insert a password reset token directly (bypasses email flow).
  // Accepts { email, expiresAt } and returns { token: rawToken }.
  app.post('/api/dev/insert-reset-token', devLimiter, (req, res) => {
    const { email, expiresAt } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const emailNorm = email.trim().toLowerCase();
    const user = db.prepare('SELECT id FROM users WHERE email_normalized = ?').get(emailNorm);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const exp = expiresAt || new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id);
    db.prepare(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    ).run(user.id, tokenHash, exp);
    res.json({ success: true, token: rawToken });
  });
}

const MAX_PORT_RETRIES = 10;
const BASE_PORT = parseInt(PORT, 10) || 5000;

function startServer(port, attempt) {
  attempt = attempt || 0;

  server.listen(port, () => {
    const finalPort = server.address().port;
    metrics.log('info', 'server_start', { port: finalPort, nodeEnv: process.env.NODE_ENV || 'development' });

    const appBaseUrl = process.env.APP_BASE_URL;
    if (appBaseUrl && finalPort !== BASE_PORT) {
      console.warn(`[server] Warning: APP_BASE_URL (${appBaseUrl}) still points at port ${BASE_PORT}, but server started on port ${finalPort}. Update your .env if needed.`);
    }

    mailer.verifyConnection();
  });

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      if (process.env.NODE_ENV === 'production') {
        console.error(`[server] Port ${port} is already in use. Exiting (production mode).`);
        process.exit(1);
      }
      if (attempt >= MAX_PORT_RETRIES) {
        console.error(`[server] Could not find a free port after ${MAX_PORT_RETRIES} attempts. Last tried: ${port}. Exiting.`);
        process.exit(1);
      }
      const nextPort = port + 1;
      console.warn(`[server] Port ${port} is already in use, retrying on port ${nextPort} (attempt ${attempt + 1}/${MAX_PORT_RETRIES})...`);
      startServer(nextPort, attempt + 1);
    } else {
      console.error('[server] Unexpected server error:', err.message);
      process.exit(1);
    }
  });
}

startServer(BASE_PORT);
