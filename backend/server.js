const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const socketIo = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
require('dotenv').config();

const {
  validateDisplayName,
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
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
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
`);

// --- DB Migrations (add new columns to existing databases) ---
(function runMigrations() {
  const userCols = new Set(db.pragma('table_info(users)').map((c) => c.name));

  if (!userCols.has('display_name')) db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
  if (!userCols.has('username_normalized')) db.exec('ALTER TABLE users ADD COLUMN username_normalized TEXT');
  if (!userCols.has('email_normalized')) db.exec('ALTER TABLE users ADD COLUMN email_normalized TEXT');
  if (!userCols.has('status')) {
    // Existing users are considered active
    db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
  if (!userCols.has('updated_at')) db.exec('ALTER TABLE users ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP');
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

const verifyEmailLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте через минуту.' },
  keyGenerator: (req) => req.ip,
  skip: () => process.env.NODE_ENV === 'test',
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

// --- Dev mailer (logs verification link to console) ---
// NOTE: In production, replace with a real SMTP/transactional email sender (Epic D).
function sendVerificationEmail(email, token, req) {
  const baseUrl = process.env.APP_BASE_URL ||
    (req ? `${req.protocol}://${req.get('host')}` : `http://localhost:${PORT}`);
  const verifyUrl = `${baseUrl}/verify-email?token=${token}`;
  console.log('\n=== [DEV] Email Verification ===');
  console.log(`To: ${email}`);
  console.log(`Verification URL: ${verifyUrl}`);
  console.log('================================\n');
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
    saveRentalSession(session.dbUserId, session.carId, durationSeconds, cost);
    socket.emit('session_ended', { carId: session.carId, durationSeconds, cost, reason: 'inactivity' });
    // Bug 2: Notify all clients that the car is now available
    broadcastCarsUpdate();
    console.log(`Session auto-ended (inactivity): Car ${session.carId}, duration ${durationSeconds}s, cost $${cost.toFixed(2)}`);
  }, INACTIVITY_TIMEOUT_MS);
  inactivityTimeouts.set(socket.id, timeout);
}

// --- Routes ---

app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

// --- CSRF token endpoint ---
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
  const rawDisplayName = typeof body.display_name === 'string' ? body.display_name : '';
  const rawEmail = typeof body.email === 'string' ? body.email : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const confirmPassword = typeof body.confirm_password === 'string' ? body.confirm_password : undefined;

  // Field-specific validation
  const errors = {};

  const usernameErr = validateUsername(rawUsername);
  if (usernameErr) errors.username = usernameErr;

  const displayNameErr = validateDisplayName(rawDisplayName || rawUsername);
  if (displayNameErr) errors.display_name = displayNameErr;

  const emailErr = validateEmail(rawEmail);
  if (emailErr) errors.email = emailErr;

  const passwordErr = validatePassword(password, confirmPassword);
  if (passwordErr) errors.password = passwordErr;

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ errors, error: Object.values(errors)[0] });
  }

  const username = normalizeText(rawUsername);
  const displayName = normalizeText(rawDisplayName || rawUsername);
  const emailNorm = normalizeEmail(rawEmail);
  const usernameNorm = normalizeUsername(rawUsername);

  try {
    const hash = bcrypt.hashSync(password, 12);

    const insertUser = db.prepare(
      `INSERT INTO users
         (username, username_normalized, display_name, email, email_normalized, password_hash, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`
    );

    let userId;
    db.transaction(() => {
      const result = insertUser.run(username, usernameNorm, displayName, rawEmail.trim(), emailNorm, hash);
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
        user: { id: userId, username, display_name: displayName, status: 'pending' },
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
  const rawEmail = typeof body.email === 'string' ? body.email : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!rawEmail || !password) {
    return res.status(400).json({ error: 'Email и пароль обязательны' });
  }

  const clientIp = req.ip;
  const lockoutMsg = getLoginLockout(clientIp);
  if (lockoutMsg) return res.status(429).json({ error: lockoutMsg });

  const emailNorm = normalizeEmail(rawEmail);
  const user = db
    .prepare('SELECT * FROM users WHERE email_normalized = ?')
    .get(emailNorm);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    recordLoginFailure(clientIp);
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }

  if (user.status === 'disabled') {
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
      user: { id: user.id, username: user.username, display_name: user.display_name, status: user.status },
      csrfToken: req.session.csrfToken,
    });
  });
});

app.post('/api/auth/logout', csrfMiddleware, (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = db
    .prepare('SELECT id, username, display_name, email, avatar_path, status, created_at FROM users WHERE id = ?')
    .get(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.json({ user: null });
  }
  res.json({ user });
});

// --- Email verification ---
app.get('/api/auth/verify-email', verifyEmailLimiter, (req, res) => {
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

app.post('/api/auth/resend-verification', verifyEmailLimiter, requireAuth, csrfMiddleware, (req, res) => {
  const user = db
    .prepare('SELECT id, email, email_normalized, status FROM users WHERE id = ?')
    .get(req.session.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.status !== 'pending') return res.status(400).json({ error: 'Ваш email уже подтверждён' });

  const token = createVerificationToken(user.id);
  sendVerificationEmail(user.email_normalized || user.email, token, req);
  res.json({ success: true, message: 'Письмо с подтверждением отправлено. Проверьте консоль сервера (dev-режим).' });
});

// --- Profile routes ---
app.get('/api/profile', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const user = db
    .prepare('SELECT id, username, display_name, email, avatar_path, status, created_at FROM users WHERE id = ?')
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

app.post('/api/profile/avatar', avatarUploadLimiter, requireAuth, csrfMiddleware, upload.single('avatar'), (req, res) => {
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

// API: Get global leaderboard (top 10 best lap times)
app.get('/api/leaderboard', (req, res) => {
  res.json({ leaderboard: leaderboard.slice(0, 10) });
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
  // Bug 2: Notify all clients that the car is now available
  broadcastCarsUpdate();
  console.log(`Session ended via HTTP: Car ${session.carId}, duration ${durationSeconds}s, cost $${cost.toFixed(2)}`);
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

// Socket.io events for real-time car control
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('start_session', (data) => {
    const { carId, userId, dbUserId } = data;

    // Block pending users from renting
    if (Number.isInteger(dbUserId)) {
      const user = db.prepare('SELECT status FROM users WHERE id = ?').get(dbUserId);
      if (user && user.status === 'pending') {
        socket.emit('session_error', { message: 'Подтвердите email для аренды машины.', code: 'pending_verification' });
        return;
      }
    }

    // Bug 5: Prevent multiple users controlling the same car
    const carAlreadyActive = [...activeSessions.values()].some((s) => s.carId === carId);
    if (carAlreadyActive) {
      socket.emit('session_error', { message: 'Эта машина уже занята. Выберите другую.' });
      return;
    }
    activeSessions.set(socket.id, {
      carId,
      userId,
      dbUserId: Number.isInteger(dbUserId) ? dbUserId : null,
      startTime: new Date(),
    });
    socket.emit('session_started', { carId, sessionId: socket.id });
    setInactivityTimeout(socket);
    // Bug 2: Notify all clients of updated car availability in real time
    broadcastCarsUpdate();
    console.log(`Session started: User ${userId} connected to Car ${carId}`);
  });

  socket.on('control_command', (data) => {
    const { direction, speed, steering_angle } = data;
    console.log(
      `Control command received: direction=${direction}, speed=${speed}, steering_angle=${steering_angle}`
    );
    // Reset inactivity timer on every command
    if (activeSessions.has(socket.id)) {
      setInactivityTimeout(socket);
    }
    // Forward full command to Pi (and other clients) so the Pi can act on it
    socket.broadcast.emit('control_command', data);
  });

  socket.on('end_session', (data) => {
    clearInactivityTimeout(socket.id);
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
    // Bug 2: Notify all clients that the car is now available
    broadcastCarsUpdate();
    console.log(`Session ended: Car ${session.carId}, duration ${durationSeconds}s, cost $${cost.toFixed(2)}`);
  });

  socket.on('disconnect', () => {
    clearInactivityTimeout(socket.id);
    const hadSession = activeSessions.has(socket.id);
    activeSessions.delete(socket.id);
    removeFromRace(socket);
    if (hadSession) broadcastCarsUpdate();
    broadcastRacesUpdate();
    console.log('Client disconnected:', socket.id);
  });

  // --- Race events ---

  socket.on('join_race', (data) => {
    const { raceId, userId, carId, carName, dbUserId } = data || {};
    if (!userId) return;

    // Block pending users from joining races
    if (Number.isInteger(dbUserId)) {
      const user = db.prepare('SELECT status FROM users WHERE id = ?').get(dbUserId);
      if (user && user.status === 'pending') {
        socket.emit('race_error', { message: 'Подтвердите email для участия в гонках.', code: 'pending_verification' });
        return;
      }
    }

    // Leave current race before joining a new one
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
      userId,
      dbUserId: Number.isInteger(dbUserId) ? dbUserId : null,
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

    // Bug 4: Notify all clients instantly of updated race list
    broadcastRacesUpdate();

    console.log(`User ${userId} joined race ${race.id}`);
  });

  socket.on('leave_race', () => {
    removeFromRace(socket);
    socket.emit('race_left');
    // Bug 4: Keep race list up to date for all clients
    broadcastRacesUpdate();
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

    // Save lap time to database if user is authenticated
    if (player.dbUserId) {
      try {
        db.prepare(
          'INSERT INTO lap_times (user_id, car_id, car_name, lap_time_ms, race_id) VALUES (?, ?, ?, ?, ?)'
        ).run(player.dbUserId, player.carId, player.carName, lapTimeMs, race.id);
      } catch (e) {
        console.error('Failed to save lap time:', e.message);
      }
    }

    // After sorting, the new entry is a global record if it sits at position 0
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

    console.log(`Lap recorded: ${player.carName}, ${lapTimeMs}ms, personal best: ${isPersonalBest}`);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
