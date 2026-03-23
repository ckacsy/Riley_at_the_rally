const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const socketIo = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
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
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

// Session middleware
const SESSION_SECRET = process.env.SESSION_SECRET || 'riley-secret-change-in-production';
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

const PORT = process.env.PORT || 5000;
const RATE_PER_MINUTE = 0.50;
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
  { id: 1, name: 'MJX Hyper Go 14302', model: 'Drift Car' },
  { id: 2, name: 'WLtoys 144001', model: 'Buggy' },
];

// Serve frontend static files
const frontendDir = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendDir));

// --- SQLite Database ---
const DB_PATH = path.join(__dirname, 'riley.sqlite');
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
    last_login_at TEXT
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
})();

// --- File uploads (avatars) ---
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, 'avatar-' + req.session.userId + '-' + Date.now() + ext);
  },
});
const upload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// --- Auth helpers ---
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Не авторизован' });
  next();
}

function requireActiveUser(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Не авторизован' });
  const user = db.prepare('SELECT status FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Не авторизован' });
  }
  if (user.status === 'pending') {
    return res.status(403).json({ error: 'pending_verification', message: 'Подтвердите email для доступа к этой функции' });
  }
  if (user.status === 'disabled') {
    return res.status(403).json({ error: 'account_disabled', message: 'Аккаунт заблокирован' });
  }
  next();
}

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

// --- Rate limiters ---
const registerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много регистраций с этого IP. Попробуйте через минуту.' },
  keyGenerator: (req) => req.ip,
  skip: () => process.env.NODE_ENV === 'test',
});

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много попыток входа. Попробуйте позже.' },
  keyGenerator: (req) => req.ip,
  skip: () => process.env.NODE_ENV === 'test',
});

// --- Login failure lockout (in-memory per IP) ---
// NOTE: Resets on server restart. Sufficient for single-process Pi deployment.
// For multi-instance production, persist to DB or Redis.
const loginFailures = new Map(); // ip -> { count, lockUntil }
const MAX_LOGIN_FAILS = 10;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

function getLoginLockout(ip) {
  const entry = loginFailures.get(ip);
  if (!entry || !entry.lockUntil) return null;
  if (Date.now() >= entry.lockUntil) {
    loginFailures.delete(ip);
    return null;
  }
  const remaining = Math.ceil((entry.lockUntil - Date.now()) / 60000);
  return `Слишком много попыток входа. Аккаунт временно заблокирован. Попробуйте через ${remaining} мин.`;
}

function recordLoginFailure(ip) {
  const entry = loginFailures.get(ip) || { count: 0, lockUntil: null };
  entry.count += 1;
  if (entry.count >= MAX_LOGIN_FAILS) {
    entry.lockUntil = Date.now() + LOCKOUT_DURATION_MS;
    entry.count = 0;
  }
  loginFailures.set(ip, entry);
}

function clearLoginFailures(ip) {
  loginFailures.delete(ip);
}

// --- Mailer helpers ---

// In non-production environments, keep the last verification URL per normalised email
// so the /api/dev/verification-link endpoint can return it when SMTP is unavailable.
const _devVerificationLinks = process.env.NODE_ENV !== 'production' ? new Map() : null;

function sendVerificationEmail(email, token, req) {
  const baseUrl = process.env.APP_BASE_URL ||
    (req ? `${req.protocol}://${req.get('host')}` : `http://localhost:${PORT}`);
  const verifyUrl = `${baseUrl}/verify-email?token=${token}`;
  const subject = 'Подтвердите email — Riley at the Rally';
  const text = `Здравствуйте!\n\nДля подтверждения вашего email перейдите по ссылке:\n${verifyUrl}\n\nСсылка действительна 24 часа.\n\nЕсли вы не регистрировались на нашем сайте, просто проигнорируйте это письмо.`;
  const html = `<p>Здравствуйте!</p><p>Для подтверждения вашего email перейдите по ссылке:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>Ссылка действительна 24 часа.</p><p>Если вы не регистрировались на нашем сайте, просто проигнорируйте это письмо.</p>`;
  if (_devVerificationLinks) {
    _devVerificationLinks.set(normalizeEmail(email), verifyUrl);
  }
  mailer.sendMail({ to: email, subject, text, html }).catch((err) => {
    console.error('[Mailer] Failed to send verification email:', err.message);
    if (_devVerificationLinks) {
      console.error('[Mailer] Tip: set DISABLE_EMAIL=true to print links to console, or fix SMTP env vars (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS) in .env');
      console.error(`[Mailer] Verification link (dev only): ${verifyUrl}`);
    }
  });
}

function sendPasswordResetEmail(email, token, req) {
  const baseUrl = process.env.APP_BASE_URL ||
    (req ? `${req.protocol}://${req.get('host')}` : `http://localhost:${PORT}`);
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;
  const subject = 'Сброс пароля — Riley at the Rally';
  const text = `Здравствуйте!\n\nДля сброса пароля перейдите по ссылке:\n${resetUrl}\n\nСсылка действительна 1 час.\n\nЕсли вы не запрашивали сброс пароля, просто проигнорируйте это письмо.`;
  const html = `<p>Здравствуйте!</p><p>Для сброса пароля перейдите по ссылке:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>Ссылка действительна 1 час.</p><p>Если вы не запрашивали сброс пароля, просто проигнорируйте это письмо.</p>`;
  mailer.sendMail({ to: email, subject, text, html }).catch((err) => {
    console.error('[Mailer] Failed to send password reset email:', err.message);
  });
}

function createVerificationToken(userId) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(userId);
  db.prepare(
    'INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
  ).run(userId, tokenHash, expiresAt);
  return rawToken;
}

function createPasswordResetToken(userId) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(userId);
  db.prepare(
    'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
  ).run(userId, tokenHash, expiresAt);
  return rawToken;
}

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

// Track active sessions and inactivity timers (keyed by socket.id)
const activeSessions = new Map();
const inactivityTimeouts = new Map();
// Session duration limit timers (keyed by socket.id)
const sessionDurationTimeouts = new Map();
// Control-command rate-limit counters (keyed by socket.id)
const controlCommandCounters = new Map(); // socketId -> { count, windowStart }

// Car availability status tracking
let carStatusLastUpdated = new Date().toISOString();
let prevCarStatus = null;

function getCarAvailabilityStatus() {
  let status;
  if (process.env.CAR_OFFLINE === 'true') {
    status = 'offline';
  } else if (activeSessions.size > 0) {
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

// --- Race Management ---
const raceRooms = new Map(); // raceId -> race object
const leaderboard = []; // sorted array of { userId, carName, lapTimeMs, date }
const MAX_LEADERBOARD = 20;
let raceCounter = 0;

function createRaceId() {
  raceCounter += 1;
  return 'race-' + Date.now() + '-' + raceCounter + '-' + Math.random().toString(36).slice(2, 7);
}

function serializePlayer(p) {
  return {
    socketId: p.socketId,
    userId: p.userId,
    carId: p.carId,
    carName: p.carName,
    lapCount: p.lapCount,
    bestLapTime: p.bestLapTime,
  };
}

function findRaceBySocketId(socketId) {
  for (const race of raceRooms.values()) {
    if (race.players.some((p) => p.socketId === socketId)) return race;
  }
  return null;
}

function removeFromRace(socket) {
  const race = findRaceBySocketId(socket.id);
  if (!race) return;
  race.players = race.players.filter((p) => p.socketId !== socket.id);
  socket.leave(race.id);
  if (race.players.length === 0) {
    raceRooms.delete(race.id);
  } else {
    io.to(race.id).emit('race_updated', {
      raceId: race.id,
      raceName: race.name,
      players: race.players.map(serializePlayer),
    });
  }
}

function broadcastCarsUpdate() {
  const activeCars = new Set([...activeSessions.values()].map((s) => s.carId));
  io.emit('cars_updated', {
    cars: CARS.map((c) => ({ ...c, status: activeCars.has(c.id) ? 'unavailable' : 'available' })),
  });
}

function broadcastRacesUpdate() {
  const races = [...raceRooms.values()].map((r) => ({
    id: r.id,
    name: r.name,
    playerCount: r.players.length,
    status: r.status,
    createdAt: r.createdAt,
  }));
  io.emit('races_updated', { races });
}

function clearInactivityTimeout(socketId) {
  if (inactivityTimeouts.has(socketId)) {
    clearTimeout(inactivityTimeouts.get(socketId));
    inactivityTimeouts.delete(socketId);
  }
}

function setInactivityTimeout(socket) {
  clearInactivityTimeout(socket.id);
  const timeout = setTimeout(() => {
    const session = activeSessions.get(socket.id);
    if (!session) return;
    const endTime = new Date();
    const durationMs = endTime - session.startTime;
    const durationSeconds = Math.floor(durationMs / 1000);
    const durationMinutes = durationMs / 60000;
    const cost = durationMinutes * RATE_PER_MINUTE;
    activeSessions.delete(socket.id);
    inactivityTimeouts.delete(socket.id);
    clearSessionDurationTimeout(socket.id);
    saveRentalSession(session.dbUserId, session.carId, durationSeconds, cost);
    socket.emit('session_ended', { carId: session.carId, durationSeconds, cost, reason: 'inactivity' });
    broadcastCarsUpdate();
    metrics.log('info', 'session_end', {
      userId: session.userId,
      dbUserId: session.dbUserId,
      carId: session.carId,
      durationSeconds,
      cost: parseFloat(cost.toFixed(4)),
      reason: 'inactivity',
    });
  }, INACTIVITY_TIMEOUT_MS);
  inactivityTimeouts.set(socket.id, timeout);
}

function clearSessionDurationTimeout(socketId) {
  if (sessionDurationTimeouts.has(socketId)) {
    clearTimeout(sessionDurationTimeouts.get(socketId));
    sessionDurationTimeouts.delete(socketId);
  }
}

function setSessionDurationTimeout(socket) {
  clearSessionDurationTimeout(socket.id);
  const timeout = setTimeout(() => {
    const session = activeSessions.get(socket.id);
    if (!session) return;
    const endTime = new Date();
    const durationMs = endTime - session.startTime;
    const durationSeconds = Math.floor(durationMs / 1000);
    const durationMinutes = durationMs / 60000;
    const cost = durationMinutes * RATE_PER_MINUTE;
    activeSessions.delete(socket.id);
    sessionDurationTimeouts.delete(socket.id);
    clearInactivityTimeout(socket.id);
    saveRentalSession(session.dbUserId, session.carId, durationSeconds, cost);
    socket.emit('session_ended', { carId: session.carId, durationSeconds, cost, reason: 'time_limit' });
    broadcastCarsUpdate();
    metrics.log('info', 'session_end', {
      userId: session.userId,
      dbUserId: session.dbUserId,
      carId: session.carId,
      durationSeconds,
      cost: parseFloat(cost.toFixed(4)),
      reason: 'time_limit',
    });
  }, SESSION_MAX_DURATION_MS);
  sessionDurationTimeouts.set(socket.id, timeout);
}

// Returns true if the command is within the allowed rate, false if throttled.
function checkControlRateLimit(socketId) {
  const now = Date.now();
  const entry = controlCommandCounters.get(socketId) || { count: 0, windowStart: now };
  if (now - entry.windowStart >= CONTROL_RATE_LIMIT_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  controlCommandCounters.set(socketId, entry);
  return entry.count <= CONTROL_RATE_LIMIT_MAX;
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
  res.json(metrics.getMetrics(activeSessions, raceRooms));
});
app.get('/api/csrf-token', (req, res) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = generateCsrfToken();
  }
  res.json({ csrfToken: req.session.csrfToken });
});

// --- Auth routes ---
app.post('/api/auth/register', registerLimiter, csrfMiddleware, (req, res) => {
  const body = req.body || {};
  const rawUsername = typeof body.username === 'string' ? body.username : '';
  const rawEmail = typeof body.email === 'string' ? body.email : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const confirmPassword = typeof body.confirm_password === 'string' ? body.confirm_password : undefined;

  // Field-specific validation
  const errors = {};

  const usernameErr = validateUsername(rawUsername);
  if (usernameErr) errors.username = usernameErr;

  const emailErr = validateEmail(rawEmail);
  if (emailErr) errors.email = emailErr;

  const passwordErr = validatePassword(password, confirmPassword);
  if (passwordErr) errors.password = passwordErr;

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ errors, error: Object.values(errors)[0] });
  }

  const username = normalizeText(rawUsername);
  const emailNorm = normalizeEmail(rawEmail);
  const usernameNorm = normalizeUsername(rawUsername);

  try {
    const hash = bcrypt.hashSync(password, 12);

    const insertUser = db.prepare(
      `INSERT INTO users
         (username, username_normalized, email, email_normalized, password_hash, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    );

    let userId;
    db.transaction(() => {
      const result = insertUser.run(username, usernameNorm, rawEmail.trim(), emailNorm, hash);
      userId = result.lastInsertRowid;
    })();

    // Generate email verification token
    const verifyToken = createVerificationToken(userId);
    sendVerificationEmail(emailNorm, verifyToken, req);

    // Regenerate session to prevent session fixation
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Ошибка сервера' });
      req.session.userId = userId;
      req.session.csrfToken = generateCsrfToken();
      res.json({
        success: true,
        user: { id: userId, username, status: 'pending' },
        csrfToken: req.session.csrfToken,
      });
    });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      if (e.message.includes('username') || e.message.includes('username_norm')) {
        return res.status(400).json({ errors: { username: 'Это имя пользователя уже занято' }, error: 'Это имя пользователя уже занято' });
      }
      return res.status(400).json({ errors: { email: 'Этот email уже зарегистрирован' }, error: 'Этот email уже зарегистрирован' });
    }
    console.error('Register error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/auth/login', loginLimiter, csrfMiddleware, (req, res) => {
  const body = req.body || {};
  // Accept either 'identifier' (username or email) or legacy 'email' field
  const rawIdentifier = typeof body.identifier === 'string' ? body.identifier
    : typeof body.email === 'string' ? body.email : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!rawIdentifier || !password) {
    return res.status(400).json({ error: 'Имя пользователя/email и пароль обязательны' });
  }

  const clientIp = req.ip;
  const lockoutMsg = getLoginLockout(clientIp);
  if (lockoutMsg) return res.status(429).json({ error: lockoutMsg });

  // Try to find user by email_normalized first, then by username_normalized
  const identifierNorm = rawIdentifier.trim().toLowerCase();
  let user = db.prepare('SELECT * FROM users WHERE email_normalized = ?').get(identifierNorm);
  if (!user) {
    user = db.prepare('SELECT * FROM users WHERE username_normalized = ?').get(identifierNorm);
  }

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    recordLoginFailure(clientIp);
    metrics.log('warn', 'auth_fail', { event: 'login', reason: 'invalid_credentials', ip: clientIp });
    metrics.recordError();
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }

  if (user.status === 'disabled') {
    metrics.log('warn', 'auth_fail', { event: 'login', reason: 'account_disabled', ip: clientIp, userId: user.id });
    metrics.recordError();
    return res.status(403).json({ error: 'Аккаунт заблокирован. Обратитесь в поддержку.' });
  }

  clearLoginFailures(clientIp);

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Ошибка сервера' });
    req.session.userId = user.id;
    req.session.csrfToken = generateCsrfToken();
    db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    res.json({
      success: true,
      user: { id: user.id, username: user.username, status: user.status },
      csrfToken: req.session.csrfToken,
    });
  });
});

app.post('/api/auth/logout', csrfMiddleware, (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// General API rate limiter for authenticated read endpoints
const apiReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
  keyGenerator: (req) => req.ip,
  skip: () => process.env.NODE_ENV === 'test',
});

app.get('/api/auth/me', apiReadLimiter, (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = db
    .prepare('SELECT id, username, email, avatar_path, status, created_at FROM users WHERE id = ?')
    .get(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.json({ user: null });
  }
  res.json({ user });
});

// --- Email verification ---
app.get('/api/auth/verify-email', apiReadLimiter, (req, res) => {
  const rawToken = req.query.token;
  if (!rawToken || typeof rawToken !== 'string') {
    return res.status(400).json({ error: 'Токен отсутствует или недействителен' });
  }
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const record = db
    .prepare('SELECT * FROM email_verification_tokens WHERE token_hash = ?')
    .get(tokenHash);

  if (!record) return res.status(400).json({ error: 'Ссылка подтверждения недействительна или уже использована' });
  if (new Date(record.expires_at) < new Date()) {
    db.prepare('DELETE FROM email_verification_tokens WHERE id = ?').run(record.id);
    return res.status(400).json({ error: 'Ссылка подтверждения истекла. Запросите новую.' });
  }

  db.transaction(() => {
    db.prepare("UPDATE users SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(record.user_id);
    db.prepare('DELETE FROM email_verification_tokens WHERE id = ?').run(record.id);
  })();

  res.json({ success: true, message: 'Email подтверждён! Теперь вы можете арендовать машины и участвовать в гонках.' });
});

const verifyResendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте через минуту.' },
  keyGenerator: (req) => req.ip,
  skip: () => process.env.NODE_ENV === 'test',
});

app.post('/api/auth/resend-verification', requireAuth, verifyResendLimiter, csrfMiddleware, (req, res) => {
  const user = db
    .prepare('SELECT id, email, email_normalized, status FROM users WHERE id = ?')
    .get(req.session.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.status !== 'pending') return res.status(400).json({ error: 'Ваш email уже подтверждён' });

  const token = createVerificationToken(user.id);
  sendVerificationEmail(user.email_normalized || user.email, token, req);
  res.json({ success: true, message: 'Письмо с подтверждением отправлено.' });
});

// --- Password reset ---
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте через 15 минут.' },
  keyGenerator: (req) => req.ip,
  skip: () => process.env.NODE_ENV === 'test',
});

app.post('/api/auth/forgot-password', forgotPasswordLimiter, csrfMiddleware, (req, res) => {
  const body = req.body || {};
  const rawEmail = typeof body.email === 'string' ? body.email : '';

  // Always respond with success to prevent email enumeration
  const successResponse = () =>
    res.json({ success: true, message: 'Если этот email зарегистрирован, вы получите письмо со ссылкой для сброса пароля.' });

  if (!rawEmail) return successResponse();

  const emailNorm = rawEmail.trim().toLowerCase();
  const user = db
    .prepare('SELECT id, email, email_normalized FROM users WHERE email_normalized = ?')
    .get(emailNorm);

  if (user) {
    const token = createPasswordResetToken(user.id);
    sendPasswordResetEmail(user.email_normalized || user.email, token, req);
  }

  successResponse();
});

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте через 15 минут.' },
  keyGenerator: (req) => req.ip,
  skip: () => process.env.NODE_ENV === 'test',
});

app.post('/api/auth/reset-password', resetPasswordLimiter, csrfMiddleware, (req, res) => {
  const body = req.body || {};
  const rawToken = typeof body.token === 'string' ? body.token : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const confirmPassword = typeof body.confirm_password === 'string' ? body.confirm_password : undefined;

  if (!rawToken) return res.status(400).json({ error: 'Токен отсутствует или недействителен' });

  const passwordErr = validatePassword(password, confirmPassword);
  if (passwordErr) return res.status(400).json({ error: passwordErr });

  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const record = db
    .prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ?')
    .get(tokenHash);

  if (!record) return res.status(400).json({ error: 'Ссылка для сброса пароля недействительна или уже использована' });
  if (new Date(record.expires_at) < new Date()) {
    db.prepare('DELETE FROM password_reset_tokens WHERE id = ?').run(record.id);
    return res.status(400).json({ error: 'Ссылка для сброса пароля истекла. Запросите новую.' });
  }

  const newHash = bcrypt.hashSync(password, 12);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newHash, record.user_id);
    db.prepare('DELETE FROM password_reset_tokens WHERE id = ?').run(record.id);
  })();

  res.json({ success: true, message: 'Пароль успешно изменён. Теперь вы можете войти с новым паролем.' });
});

// --- Profile routes ---
app.get('/api/profile', requireAuth, apiReadLimiter, (req, res) => {
  const userId = req.session.userId;
  const user = db
    .prepare('SELECT id, username, email, avatar_path, status, created_at FROM users WHERE id = ?')
    .get(userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const totalLaps = db.prepare('SELECT COUNT(*) as cnt FROM lap_times WHERE user_id = ?').get(userId).cnt;
  const totalRaces = db
    .prepare('SELECT COUNT(DISTINCT race_id) as cnt FROM lap_times WHERE user_id = ? AND race_id IS NOT NULL')
    .get(userId).cnt;
  const totalSessions = db
    .prepare('SELECT COUNT(*) as cnt FROM rental_sessions WHERE user_id = ?')
    .get(userId).cnt;
  const totalTimeSec = db
    .prepare('SELECT COALESCE(SUM(duration_seconds),0) as total FROM rental_sessions WHERE user_id = ?')
    .get(userId).total;
  const bestLap = db
    .prepare('SELECT * FROM lap_times WHERE user_id = ? ORDER BY lap_time_ms ASC LIMIT 1')
    .get(userId);
  const recentLaps = db
    .prepare('SELECT * FROM lap_times WHERE user_id = ? ORDER BY created_at DESC LIMIT 10')
    .all(userId);

  res.json({
    user,
    stats: { totalLaps, totalRaces, totalSessions, totalTimeSec, bestLap: bestLap || null, recentLaps },
  });
});

const avatarUploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много загрузок. Попробуйте через минуту.' },
  keyGenerator: (req) => req.ip,
  skip: () => process.env.NODE_ENV === 'test',
});

app.post('/api/profile/avatar', requireAuth, avatarUploadLimiter, csrfMiddleware, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен или неверный формат' });
  const avatarPath = '/uploads/' + req.file.filename;
  const existing = db.prepare('SELECT avatar_path FROM users WHERE id = ?').get(req.session.userId);
  if (existing && existing.avatar_path) {
    const oldPath = path.join(uploadsDir, path.basename(existing.avatar_path));
    if (fs.existsSync(oldPath)) {
      try { fs.unlinkSync(oldPath); } catch (_) {}
    }
  }
  db.prepare('UPDATE users SET avatar_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(avatarPath, req.session.userId);
  res.json({ success: true, avatarPath });
});

app.get('/api/cars', (req, res) => {
  const activeCars = new Set([...activeSessions.values()].map((s) => s.carId));
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
  const races = [...raceRooms.values()].map((r) => ({
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

// End session via HTTP (used by navigator.sendBeacon on page unload)
app.post('/api/session/end', (req, res) => {
  const { sessionId, dbUserId } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ ended: false, message: 'Invalid sessionId.' });
  }
  const session = activeSessions.get(sessionId);
  if (!session) {
    return res.json({ ended: false, message: 'No active session found.' });
  }
  clearInactivityTimeout(sessionId);
  const endTime = new Date();
  const durationMs = endTime - session.startTime;
  const durationSeconds = Math.floor(durationMs / 1000);
  const durationMinutes = durationMs / 60000;
  const cost = durationMinutes * RATE_PER_MINUTE;
  activeSessions.delete(sessionId);
  const effectiveDbUserId = session.dbUserId || (Number.isInteger(dbUserId) ? dbUserId : null);
  saveRentalSession(effectiveDbUserId, session.carId, durationSeconds, cost);
  broadcastCarsUpdate();
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

app.get('/garage', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'garage.html'));
});

// Socket.io events for real-time car control
io.on('connection', (socket) => {
  metrics.log('debug', 'socket_connect', { socketId: socket.id });

  socket.on('start_session', (data) => {
    const { carId, dbUserId } = data;

    // Require authenticated & verified user
    if (!Number.isInteger(dbUserId)) {
      metrics.log('warn', 'auth_fail', { event: 'start_session', code: 'auth_required', socketId: socket.id });
      metrics.recordError();
      socket.emit('session_error', { message: 'Требуется авторизация.', code: 'auth_required' });
      return;
    }
    const user = db.prepare('SELECT username, status FROM users WHERE id = ?').get(dbUserId);
    if (!user) {
      metrics.log('warn', 'auth_fail', { event: 'start_session', code: 'user_not_found', socketId: socket.id });
      metrics.recordError();
      socket.emit('session_error', { message: 'Пользователь не найден.', code: 'auth_required' });
      return;
    }
    if (user.status === 'pending') {
      metrics.log('warn', 'auth_fail', { event: 'start_session', code: 'pending_verification', userId: dbUserId });
      metrics.recordError();
      socket.emit('session_error', { message: 'Подтвердите email для аренды машины.', code: 'pending_verification' });
      return;
    }
    if (user.status === 'disabled') {
      metrics.log('warn', 'auth_fail', { event: 'start_session', code: 'account_disabled', userId: dbUserId });
      metrics.recordError();
      socket.emit('session_error', { message: 'Аккаунт заблокирован.', code: 'account_disabled' });
      return;
    }

    // Validate that the requested car exists
    if (!CARS.some((c) => c.id === carId)) {
      socket.emit('session_error', { message: 'Неверный идентификатор машины.' });
      return;
    }

    const carAlreadyActive = [...activeSessions.values()].some((s) => s.carId === carId);
    if (carAlreadyActive) {
      socket.emit('session_error', { message: 'Эта машина уже занята. Выберите другую.' });
      return;
    }
    activeSessions.set(socket.id, {
      carId,
      userId: user.username,
      dbUserId,
      startTime: new Date(),
    });
    socket.emit('session_started', {
      carId,
      sessionId: socket.id,
      sessionMaxDurationMs: SESSION_MAX_DURATION_MS,
      inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
    });
    setInactivityTimeout(socket);
    setSessionDurationTimeout(socket);
    broadcastCarsUpdate();
    metrics.log('info', 'session_start', { userId: user.username, dbUserId, carId, socketId: socket.id });
  });

  socket.on('control_command', (data) => {
    // Only forward commands from sockets that own an active rental session
    if (!activeSessions.has(socket.id)) {
      return;
    }
    if (!checkControlRateLimit(socket.id)) {
      metrics.recordError();
      socket.emit('control_error', { message: 'Слишком много команд. Подождите немного.', code: 'rate_limited' });
      return;
    }
    setInactivityTimeout(socket);
    const t0 = performance.now();
    socket.broadcast.emit('control_command', data);
    metrics.recordCommand();
    metrics.recordLatency(socket.id, performance.now() - t0);
  });

  socket.on('end_session', (data) => {
    clearInactivityTimeout(socket.id);
    clearSessionDurationTimeout(socket.id);
    const session = activeSessions.get(socket.id);
    if (!session) {
      socket.emit('session_error', { message: 'No active session found.' });
      return;
    }
    const endTime = new Date();
    const durationMs = endTime - session.startTime;
    const durationSeconds = Math.floor(durationMs / 1000);
    const durationMinutes = durationMs / 60000;
    const cost = durationMinutes * RATE_PER_MINUTE;
    activeSessions.delete(socket.id);
    saveRentalSession(session.dbUserId, session.carId, durationSeconds, cost);
    socket.emit('session_ended', { carId: session.carId, durationSeconds, cost });
    broadcastCarsUpdate();
    metrics.log('info', 'session_end', {
      userId: session.userId,
      dbUserId: session.dbUserId,
      carId: session.carId,
      durationSeconds,
      cost: parseFloat(cost.toFixed(4)),
      reason: 'user',
    });
  });

  socket.on('disconnect', () => {
    clearInactivityTimeout(socket.id);
    clearSessionDurationTimeout(socket.id);
    controlCommandCounters.delete(socket.id);
    metrics.clearLatency(socket.id);
    const hadSession = activeSessions.has(socket.id);
    activeSessions.delete(socket.id);
    removeFromRace(socket);
    if (hadSession) broadcastCarsUpdate();
    broadcastRacesUpdate();
    metrics.log('debug', 'socket_disconnect', { socketId: socket.id, hadSession });
  });

  // --- Race events ---

  socket.on('join_race', (data) => {
    const { raceId, carId, carName, dbUserId } = data || {};

    // Require authenticated & verified user
    if (!Number.isInteger(dbUserId)) {
      metrics.log('warn', 'auth_fail', { event: 'join_race', code: 'auth_required', socketId: socket.id });
      metrics.recordError();
      socket.emit('race_error', { message: 'Требуется авторизация.', code: 'auth_required' });
      return;
    }
    const user = db.prepare('SELECT username, status FROM users WHERE id = ?').get(dbUserId);
    if (!user) {
      metrics.log('warn', 'auth_fail', { event: 'join_race', code: 'user_not_found', socketId: socket.id });
      metrics.recordError();
      socket.emit('race_error', { message: 'Пользователь не найден.', code: 'auth_required' });
      return;
    }
    if (user.status === 'pending') {
      metrics.log('warn', 'auth_fail', { event: 'join_race', code: 'pending_verification', userId: dbUserId });
      metrics.recordError();
      socket.emit('race_error', { message: 'Подтвердите email для участия в гонках.', code: 'pending_verification' });
      return;
    }
    if (user.status === 'disabled') {
      metrics.log('warn', 'auth_fail', { event: 'join_race', code: 'account_disabled', userId: dbUserId });
      metrics.recordError();
      socket.emit('race_error', { message: 'Аккаунт заблокирован.', code: 'account_disabled' });
      return;
    }

    removeFromRace(socket);

    let race;
    if (raceId && raceRooms.has(raceId)) {
      race = raceRooms.get(raceId);
    } else {
      const newId = createRaceId();
      race = {
        id: newId,
        name: 'Гонка #' + (raceRooms.size + 1),
        players: [],
        status: 'racing',
        createdAt: new Date().toISOString(),
      };
      raceRooms.set(newId, race);
    }

    const player = {
      socketId: socket.id,
      userId: user.username,
      dbUserId,
      carId: carId || null,
      carName: carName || ('Машина #' + (carId || '?')),
      lapCount: 0,
      bestLapTime: null,
      currentLapStart: null,
    };
    race.players.push(player);
    socket.join(race.id);

    socket.emit('race_joined', {
      raceId: race.id,
      raceName: race.name,
      players: race.players.map(serializePlayer),
      leaderboard: leaderboard.slice(0, 10),
    });

    io.to(race.id).emit('race_updated', {
      raceId: race.id,
      raceName: race.name,
      players: race.players.map(serializePlayer),
    });

    broadcastRacesUpdate();

    metrics.log('info', 'race_join', { userId: user.username, dbUserId, raceId: race.id, socketId: socket.id });
  });

  socket.on('leave_race', () => {
    const race = findRaceBySocketId(socket.id);
    const raceId = race ? race.id : null;
    removeFromRace(socket);
    socket.emit('race_left');
    broadcastRacesUpdate();
    if (raceId) metrics.log('info', 'race_leave', { socketId: socket.id, raceId });
  });

  socket.on('start_lap', () => {
    const race = findRaceBySocketId(socket.id);
    if (!race) return;
    const player = race.players.find((p) => p.socketId === socket.id);
    if (!player) return;
    player.currentLapStart = Date.now();
    socket.emit('lap_started', { startTime: player.currentLapStart });
  });

  socket.on('end_lap', () => {
    const race = findRaceBySocketId(socket.id);
    if (!race) return;
    const player = race.players.find((p) => p.socketId === socket.id);
    if (!player || !player.currentLapStart) return;

    const lapTimeMs = Date.now() - player.currentLapStart;
    player.currentLapStart = null;
    player.lapCount++;

    const isPersonalBest = !player.bestLapTime || lapTimeMs < player.bestLapTime;
    if (isPersonalBest) player.bestLapTime = lapTimeMs;

    leaderboard.push({
      userId: player.userId,
      carName: player.carName,
      lapTimeMs,
      date: new Date().toISOString(),
    });
    leaderboard.sort((a, b) => a.lapTimeMs - b.lapTimeMs);
    if (leaderboard.length > MAX_LEADERBOARD) leaderboard.length = MAX_LEADERBOARD;

    if (player.dbUserId) {
      try {
        db.prepare(
          'INSERT INTO lap_times (user_id, car_id, car_name, lap_time_ms, race_id) VALUES (?, ?, ?, ?, ?)'
        ).run(player.dbUserId, player.carId, player.carName, lapTimeMs, race.id);
        metrics.log('info', 'lap_save_success', {
          userId: player.userId,
          dbUserId: player.dbUserId,
          carName: player.carName,
          lapTimeMs,
          raceId: race.id,
          isPersonalBest,
        });
      } catch (e) {
        metrics.log('error', 'lap_save_fail', { userId: player.userId, error: e.message });
        metrics.recordError();
      }
    }

    const isGlobalRecord = leaderboard[0].lapTimeMs === lapTimeMs && leaderboard[0].userId === player.userId;

    io.to(race.id).emit('lap_recorded', {
      userId: player.userId,
      carName: player.carName,
      lapTimeMs,
      isPersonalBest,
      isGlobalRecord,
      leaderboard: leaderboard.slice(0, 10),
    });

    io.to(race.id).emit('race_updated', {
      raceId: race.id,
      raceName: race.name,
      players: race.players.map(serializePlayer),
    });

    metrics.log('info', 'lap_recorded', {
      userId: player.userId,
      carName: player.carName,
      lapTimeMs,
      isPersonalBest,
      isGlobalRecord,
      raceId: race.id,
    });
  });
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

  app.post('/api/dev/reset-db', (req, res) => {
    try {
      db.transaction(() => {
        db.exec('DELETE FROM email_verification_tokens');
        db.exec('DELETE FROM password_reset_tokens');
        db.exec('DELETE FROM lap_times');
        db.exec('DELETE FROM rental_sessions');
        db.exec('DELETE FROM users');
        // Reset autoincrement counters
        db.exec("DELETE FROM sqlite_sequence WHERE name IN ('users','lap_times','rental_sessions','email_verification_tokens','password_reset_tokens')");
      })();
      req.session.destroy((err) => { if (err) console.error('Session destroy error:', err); });
      if (_devVerificationLinks) _devVerificationLinks.clear();
      console.log('[DEV] Database reset: all users and sessions deleted.');
      res.json({ success: true, message: 'Database reset: all users, sessions and tokens deleted.' });
    } catch (e) {
      console.error('Dev reset error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });
}

server.listen(PORT, () => {
  metrics.log('info', 'server_start', { port: PORT, nodeEnv: process.env.NODE_ENV || 'development' });
});
