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
const { createRateLimiter } = require('./middleware/rateLimiter');
const { openDatabase } = require('./db/connection');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const cors = require('cors');
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

const { validateEnv } = require('./config/validate-env');
validateEnv();

const {
  RATE_PER_MINUTE,
  INACTIVITY_TIMEOUT_MS,
  SESSION_MAX_DURATION_MS,
  CONTROL_RATE_LIMIT_MAX,
  CONTROL_RATE_LIMIT_WINDOW_MS,
  CARS,
} = require('./config/constants');

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

// Trust first proxy (nginx/Cloudflare) so req.ip returns the real client IP.
// Without this, all rate limiters see the proxy IP and share one bucket.
// Set to specific number (not 'true') to prevent spoofing via X-Forwarded-For.
if (process.env.TRUST_PROXY) {
  const trustValue = process.env.TRUST_PROXY;
  // Accept numeric (e.g. "1"), boolean "true", or a subnet/IP string
  const numVal = parseInt(trustValue, 10);
  if (!isNaN(numVal)) {
    app.set('trust proxy', numVal);
  } else if (trustValue === 'true') {
    app.set('trust proxy', 1);
  } else {
    // Treat as IP/subnet string (e.g. "loopback", "10.0.0.0/8")
    app.set('trust proxy', trustValue);
  }
  console.log('[server] trust proxy set to:', app.get('trust proxy'));
}

const corsOrigin = process.env.NODE_ENV === 'production'
  ? (process.env.APP_BASE_URL || false)
  : true; // allow all in development
app.use(cors({
  origin: corsOrigin,
  credentials: true, // needed for session cookies
}));

app.use(express.json());

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // unsafe-inline is required: frontend HTML pages contain inline <script> blocks
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      // unsafe-inline is required: extensive use of inline styles across frontend pages
      styleSrc: ["'self'", "'unsafe-inline'"],
      // '*' retained for camera stream img sources embedded from car hardware URLs
      imgSrc: ["'self'", "data:", "blob:", "*"],
      mediaSrc: ["'self'", "*"],
      // ws:/wss: required for Socket.IO WebSocket connections
      connectSrc: ["'self'", "ws:", "wss:"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
      // Prevents this page from being embedded in iframes (clickjacking protection)
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  // HSTS: enforce HTTPS for 1 year, include subdomains, allow preload list submission
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  // Limit referrer information sent on cross-origin navigations
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginEmbedderPolicy: false, // Breaks camera stream embedding
}));

// Restrict browser features the app doesn't use
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  next();
});

// Redirect HTTP → HTTPS in production when behind a trusted proxy.
// Relies on the X-Forwarded-Proto header set by the reverse proxy.
if (process.env.NODE_ENV === 'production' && process.env.TRUST_PROXY) {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

// Structured HTTP request logging (generates / propagates X-Request-Id,
// logs every request as JSON via metrics.log).
const { requestLogger } = require('./middleware/request-logger');
app.use(requestLogger(metrics));

// Session middleware — uses connect-sqlite3 to persist sessions across server
// restarts, replacing the default in-memory store which lost sessions on restart.
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const sessionMiddleware = session({
  secret: sessionSecret,
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

// Serve frontend static files
const frontendDir = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendDir));

// --- SQLite Database ---
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'riley.sqlite');
const db = openDatabase(DB_PATH);
const { runMigrations } = require('./db/migrate');
runMigrations(db);

// --- Startup recovery: enforce state invariants after restart ---
{
  const startupRecovery = require('./lib/startup-recovery');
  startupRecovery(db, metrics);
}

// --- Orphan detection: check for unresolved recovery records ---
{
  try {
    const pending = db.prepare(
      "SELECT COUNT(*) as count FROM pending_recovery WHERE status = 'pending'"
    ).get();
    if (pending && pending.count > 0) {
      console.warn(`[startup] ⚠️  ${pending.count} pending recovery record(s) from previous shutdown. Review in admin panel.`);
      metrics.log('warn', 'orphan_recovery_pending', { count: pending.count });
    }
  } catch (e) {
    // Table may not exist yet on first run — ignore
  }
}

// --- File uploads (avatars) ---
const { upload, uploadsDir } = require('./middleware/upload');
app.use('/uploads', express.static(uploadsDir, { dotfiles: 'deny', index: false, redirect: false }));

// Prevent caching of sensitive API responses (auth, admin, payment).
// Applied before route handlers so every response from these paths carries
// the header regardless of the individual route handler.
app.use((req, res, next) => {
  if (
    req.path.startsWith('/api/auth') ||
    req.path.startsWith('/api/admin') ||
    req.path.startsWith('/api/payment')
  ) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
  next();
});

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
const apiReadLimiter = createRateLimiter({ max: 60 });

// Mount all auth & profile routes; get back shared middleware and dev maps
const mountAuthRoutes = require('./routes/auth');
const { requireAuth, requireActiveUser, loadCurrentUser, requireRole, invalidateUserSessions, _devVerificationLinks, _devMagicLinks, _devResetLinks } = mountAuthRoutes(app, db, {
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
  invalidateUserSessions,
};
app.locals.adminRouteDeps = adminRouteDeps;

const mountPaymentRoutes = require('./routes/payment');
mountPaymentRoutes(app, db, { requireAuth, requireActiveUser, csrfMiddleware, apiReadLimiter, getActiveSessions: () => socketState && socketState.activeSessions });

const mountDailyBonusRoutes = require('./routes/daily-bonus');
mountDailyBonusRoutes(app, db, { requireAuth, requireActiveUser, csrfMiddleware, apiReadLimiter });

const mountAdminRoutes = require('./routes/admin');
mountAdminRoutes(app, db, adminRouteDeps);

const mountNewsRoutes = require('./routes/news');
mountNewsRoutes(app, db, adminRouteDeps);

const mountAdminSessionRoutes = require('./routes/admin-sessions');
mountAdminSessionRoutes(app, db, adminRouteDeps);

const mountAdminTransactionRoutes = require('./routes/admin-transactions');
mountAdminTransactionRoutes(app, db, {
  ...adminRouteDeps,
  getActiveSessions: () => socketState && socketState.activeSessions,
});

const mountAdminAnalyticsRoutes = require('./routes/admin-analytics');
mountAdminAnalyticsRoutes(app, db, adminRouteDeps);

const mountAdminCarsRoutes = require('./routes/admin-cars');
mountAdminCarsRoutes(app, db, adminRouteDeps, { CARS });

const mountAdminDevicesRoutes = require('./routes/admin-devices');
mountAdminDevicesRoutes(app, db, adminRouteDeps, {
  CARS,
  getDeviceSockets: () => socketState && socketState.deviceSockets,
});

const mountAdminInvestigationRoutes = require('./routes/admin-investigation');
mountAdminInvestigationRoutes(app, db, adminRouteDeps);

const mountAdminChatRoutes = require('./routes/admin-chat');
// io is created at line 72 (before this point), so it is always available when routes are called.
mountAdminChatRoutes(app, db, adminRouteDeps, { io });

const mountAdminDashboardRoutes = require('./routes/admin-dashboard');
mountAdminDashboardRoutes(app, db, {
  requireRole,
  getActiveSessions: () => socketState && socketState.activeSessions,
  CARS,
});

const mountRankRoutes = require('./routes/rank');
mountRankRoutes(app, db, { requireAuth, apiReadLimiter });

const mountDuelRoutes = require('./routes/duel');
// getDuelManager is a lazy accessor so the route module can always fetch the
// current DuelManager instance after socketState is initialized below.
mountDuelRoutes(app, db, {
  requireAuth,
  requireActiveUser,
  apiReadLimiter,
  getDuelManager: () => socketState && socketState.duelManager,
});

function saveRentalSession(dbUserId, carId, durationSeconds, cost, sessionRef, terminationReason) {
  if (!dbUserId) return;
  const carName = CARS.find((c) => c.id === carId)?.name || ('Машина #' + carId);
  try {
    db.prepare(
      'INSERT INTO rental_sessions (user_id, car_id, car_name, duration_seconds, cost, session_ref, termination_reason) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(dbUserId, carId, carName, durationSeconds, cost, sessionRef || null, terminationReason || null);
  } catch (e) {
    console.error('Failed to save rental session:', e.message);
  }
}

const ADMIN_USERNAMES = new Set(
  (process.env.ADMIN_USERNAMES || '').split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

// ---------------------------------------------------------------------------
// Periodic cleanup of expired tokens and stale data
// ---------------------------------------------------------------------------
function runTokenCleanup() {
  const now = new Date().toISOString();
  let totalDeleted = 0;

  // 1. Expired email verification tokens
  try {
    const r = db.prepare('DELETE FROM email_verification_tokens WHERE expires_at < ?').run(now);
    if (r.changes > 0) {
      totalDeleted += r.changes;
      metrics.log('debug', 'token_cleanup', { table: 'email_verification_tokens', deleted: r.changes });
    }
  } catch (e) {
    metrics.log('error', 'token_cleanup_error', { table: 'email_verification_tokens', error: e.message });
  }

  // 2. Expired password reset tokens
  try {
    const r = db.prepare('DELETE FROM password_reset_tokens WHERE expires_at < ?').run(now);
    if (r.changes > 0) {
      totalDeleted += r.changes;
      metrics.log('debug', 'token_cleanup', { table: 'password_reset_tokens', deleted: r.changes });
    }
  } catch (e) {
    metrics.log('error', 'token_cleanup_error', { table: 'password_reset_tokens', error: e.message });
  }

  // 3. Expired or used magic links (older than 24h past expiry for safety margin)
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const r = db.prepare('DELETE FROM magic_links WHERE expires_at < ?').run(cutoff);
    if (r.changes > 0) {
      totalDeleted += r.changes;
      metrics.log('debug', 'token_cleanup', { table: 'magic_links', deleted: r.changes });
    }
  } catch (e) {
    metrics.log('error', 'token_cleanup_error', { table: 'magic_links', error: e.message });
  }

  // 4. Expired HTTP sessions from sessions.sqlite
  try {
    const sessionsDbPath = path.join(__dirname, 'sessions.sqlite');
    if (fs.existsSync(sessionsDbPath)) {
      const sessDb = openDatabase(sessionsDbPath, { timeout: 5000 });
      try {
        // connect-sqlite3 stores: sid, expired (INTEGER epoch ms), sess (TEXT JSON)
        const r = sessDb.prepare('DELETE FROM sessions WHERE expired < ?').run(Date.now());
        if (r.changes > 0) {
          totalDeleted += r.changes;
          metrics.log('debug', 'token_cleanup', { table: 'sessions', deleted: r.changes });
        }
      } finally {
        sessDb.close();
      }
    }
  } catch (e) {
    metrics.log('error', 'token_cleanup_error', { table: 'sessions', error: e.message });
  }

  if (totalDeleted > 0) {
    metrics.log('info', 'token_cleanup_complete', { totalDeleted });
  }
}

// Run immediately on startup, then every hour.
// TOKEN_CLEANUP_INTERVAL is kept as a module-level const so tests can
// clear the interval via clearInterval(TOKEN_CLEANUP_INTERVAL) if needed.
runTokenCleanup();
const TOKEN_CLEANUP_INTERVAL = setInterval(runTokenCleanup, 60 * 60 * 1000);

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
app.locals.forceEndSession = (carId, adminContext) => socketState.forceEndSession(carId, adminContext);
app.locals.broadcastCarsUpdate = () => socketState.broadcastCarsUpdate();

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

const healthLimiter = createRateLimiter({ max: 30 });

app.get('/api/health', healthLimiter, async (req, res) => {
  const health = { ok: true, ts: new Date().toISOString(), details: {} };

  // DB connectivity check
  try {
    db.prepare('SELECT 1').get();
    health.details.db = { ok: true };
  } catch (e) {
    health.ok = false;
    metrics.log('error', 'health_check_db', { error: e.message });
    health.details.db = { ok: false };
  }

  // Socket subsystem check
  try {
    health.details.socket = { ok: true, connectedClients: io.engine.clientsCount };
  } catch (e) {
    health.ok = false;
    metrics.log('error', 'health_check_socket', { error: e.message });
    health.details.socket = { ok: false };
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
      metrics.log('warn', 'health_check_camera', { error: e.message });
      health.details.camera = { ok: false };
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

const metricsLimiter = createRateLimiter({ max: 30 });

app.get('/api/metrics', metricsLimiter, requireAuth, (req, res) => {
  // Access control: open in debug/dev mode; require METRICS_SECRET header in production
  const providedSecret = req.headers['x-metrics-key'];
  if (!IS_DEV_MODE && !(METRICS_SECRET && providedSecret === METRICS_SECRET)) {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  res.json(metrics.getMetrics(socketState.activeSessions, socketState.raceRooms));
});
app.get('/api/cars', apiReadLimiter, (req, res) => {
  const activeCars = new Set([...socketState.activeSessions.values()].map((s) => s.carId));
  const maintRows = db.prepare('SELECT car_id FROM car_maintenance WHERE enabled = 1').all();
  const maintenanceCars = new Set(maintRows.map((r) => r.car_id));
  res.json({
    ratePerMinute: RATE_PER_MINUTE,
    cars: CARS.map((c) => {
      let status;
      if (maintenanceCars.has(c.id)) {
        status = 'maintenance';
      } else if (activeCars.has(c.id)) {
        status = 'unavailable';
      } else {
        status = 'available';
      }
      return { ...c, status };
    }),
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
// CSRF audit note: csrfMiddleware intentionally omitted — navigator.sendBeacon()
// does not support custom request headers and cannot transmit a CSRF token.
// The endpoint is protected by session authentication (reqUserId check below)
// and requires the caller to supply the correct sessionId owned by that user.
app.post('/api/session/end', (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ ended: false, message: 'Invalid sessionId.' });
  }

  // Require authentication
  const reqUserId = req.session?.userId;
  if (!reqUserId) {
    return res.status(401).json({ ended: false, message: 'Authentication required.' });
  }

  const session = socketState.activeSessions.get(sessionId);
  if (!session) {
    return res.json({ ended: false, message: 'No active session found.' });
  }

  // Ownership check: only the session owner can end it via HTTP
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
  // Use server-side values only — no client-provided fallbacks
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

// Routes for frontend pages
const pageRateLimit = createRateLimiter({ max: 60 });

app.get('/', pageRateLimit, (req, res) => {
  res.redirect(302, '/garage');
});

app.get('/leaderboard', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'leaderboard.html'));
});

app.get('/control', pageRateLimit, (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/login');
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
  if (!req.session || !req.session.userId) return res.redirect('/login');
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

app.get('/admin-cars', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'admin-cars.html'));
});

app.get('/admin-investigation', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'admin-investigation.html'));
});

app.get('/admin-chat', pageRateLimit, (req, res) => {
  res.sendFile(path.join(frontendDir, 'admin-chat.html'));
});

// --- Dev-only: reset database (delete all users and sessions) ---
// Accessible only when NODE_ENV !== 'production'
if (process.env.NODE_ENV !== 'production') {
  const devLimiter = createRateLimiter({ max: 20, message: 'Too many requests from this IP, please try again later.' });

  const { MIN_LAP_TIME_MS } = require('./lib/rank-config');

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
        db.exec('DELETE FROM daily_checkins');
        db.exec('DELETE FROM users');
        db.exec('DELETE FROM car_maintenance');
        db.exec('DELETE FROM player_ranks');
        db.exec('DELETE FROM duel_results');
        db.exec('DELETE FROM pending_recovery');
        // Reset autoincrement counters
        db.exec("DELETE FROM sqlite_sequence WHERE name IN ('users','lap_times','rental_sessions','email_verification_tokens','password_reset_tokens','chat_messages','magic_links','transactions','payment_orders','news','admin_audit_log','daily_checkins','player_ranks','duel_results','pending_recovery')");
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
      // Clear in-memory duel state (queue, active duels)
      if (socketState.duelManager) socketState.duelManager.clear();
      // Broadcast clean car state to all connected sockets
      socketState.broadcastCarsUpdate();
      console.log('[DEV] Database reset: all users and sessions deleted.');
      res.json({ success: true, message: 'Database reset: all users, sessions and tokens deleted.' });
    } catch (e) {
      console.error('Dev reset error:', e.message);
      res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
    }
  });

  // Dev helper: insert a rental session directly for testing.
  app.post('/api/dev/rental-sessions/insert', devLimiter, (req, res) => {
    const { user_id, car_id, car_name, duration_seconds, cost, session_ref } = req.body || {};
    if (!user_id || !car_id) return res.status(400).json({ error: 'user_id and car_id required' });
    const result = db.prepare(
      'INSERT INTO rental_sessions (user_id, car_id, car_name, duration_seconds, cost, session_ref) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      Number(user_id),
      Number(car_id),
      car_name || ('Машина #' + car_id),
      Number(duration_seconds) || 0,
      Number(cost) || 0,
      session_ref || null
    );
    const row = db.prepare('SELECT * FROM rental_sessions WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, session: row });
  });

  // Dev helper: inject a fake active session into the in-memory activeSessions map.
  // Used by e2e tests to simulate a car with an ongoing session (e.g. to trigger the 409
  // conflict when trying to enable maintenance on a car that is in use).
  // Accepts optional dbUserId to associate the injected session with a real user (for duel tests).
  // Accepts optional socketId to key the session by socket ID so duel matching works correctly.
  app.post('/api/dev/inject-active-session', devLimiter, (req, res) => {
    const { carId, dbUserId: injectedDbUserId, socketId } = req.body || {};
    if (!carId) return res.status(400).json({ error: 'carId required' });
    const crypto = require('crypto');
    // If socketId provided, remove any existing dev-injected session for this dbUserId
    // to avoid session_already_active conflicts when control.js emits start_session.
    if (socketId && injectedDbUserId != null) {
      for (const [key, sess] of socketState.activeSessions) {
        if (sess.dbUserId === Number(injectedDbUserId) && key.startsWith('dev-injected-')) {
          socketState.activeSessions.delete(key);
        }
      }
    }
    const key = socketId || `dev-injected-${carId}-${Date.now()}`;
    socketState.activeSessions.set(key, {
      carId: Number(carId),
      userId: 'dev-test',
      dbUserId: injectedDbUserId != null ? Number(injectedDbUserId) : 0,
      startTime: new Date(),
      holdAmount: 0,
      sessionRef: crypto.randomUUID(),
    });
    res.json({ success: true, sessionId: key });
  });

  // Dev helper: insert a transaction directly for testing.
  app.post('/api/dev/transactions/insert', devLimiter, (req, res) => {
    const { user_id, type, amount, balance_after, description, reference_id, admin_id, created_at } = req.body || {};
    if (!user_id || !type || amount === undefined || balance_after === undefined) {
      return res.status(400).json({ error: 'user_id, type, amount, balance_after required' });
    }
    let result;
    if (created_at && typeof created_at === 'string') {
      result = db.prepare(
        'INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id, admin_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        Number(user_id),
        String(type),
        Number(amount),
        Number(balance_after),
        description || null,
        reference_id || null,
        admin_id ? Number(admin_id) : null,
        created_at,
      );
    } else {
      result = db.prepare(
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
    }
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

  // Inject a daily_checkins row for testing cycle-wrap scenarios.
  // Accepts { userId, checkinDate, streakCount, cycleDay, rewardAmount }.
  app.post('/api/dev/inject-checkin', devLimiter, (req, res) => {
    const { userId, checkinDate, streakCount, cycleDay, rewardAmount } = req.body || {};
    if (!userId || !checkinDate || streakCount == null || cycleDay == null || rewardAmount == null) {
      return res.status(400).json({ error: 'userId, checkinDate, streakCount, cycleDay, rewardAmount required' });
    }
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    try {
      db.prepare(
        `INSERT OR REPLACE INTO daily_checkins (user_id, checkin_date, cycle_day, streak_count, reward_amount, schedule_version)
         VALUES (?, ?, ?, ?, ?, 1)`
      ).run(userId, checkinDate, cycleDay, streakCount, rewardAmount);
      res.json({ success: true });
    } catch (err) {
      console.error('[DEV] set-daily-checkin error:', err.message);
      res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
    }
  });
  // Dev helper: set a user's rank state (rank, stars, is_legend, legend_position).
  // Used by e2e tests to set up specific rank scenarios.
  app.post('/api/dev/set-user-rank', devLimiter, (req, res) => {
    const { username, rank, stars, is_legend, legend_position } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username required' });
    const usernameNorm = normalizeUsername(username);
    const user = db.prepare('SELECT id FROM users WHERE username_normalized = ?').get(usernameNorm);
    if (!user) return res.status(404).json({ error: 'User not found' });
    db.prepare(
      `UPDATE users SET rank = ?, stars = ?, is_legend = ?, legend_position = ? WHERE id = ?`
    ).run(
      rank != null ? Number(rank) : 15,
      stars != null ? Number(stars) : 0,
      is_legend ? 1 : 0,
      legend_position != null ? Number(legend_position) : null,
      user.id,
    );
    res.json({ success: true });
  });

  // Dev helper: rewind the lap start time for a duel player so the MIN_LAP_TIME_MS
  // check passes immediately. Used by e2e tests to simulate a valid lap completion.
  app.post('/api/dev/rewind-lap-start', devLimiter, (req, res) => {
    const { dbUserId } = req.body || {};
    if (!dbUserId) return res.status(400).json({ error: 'dbUserId required' });
    const dm = socketState && socketState.duelManager;
    if (!dm) return res.status(503).json({ error: 'duel manager not ready' });
    const duel = dm.getDuelByUserId(Number(dbUserId));
    if (!duel) return res.status(404).json({ error: 'no active duel for user' });
    const player = duel.players.find((p) => p.dbUserId === Number(dbUserId));
    if (!player) return res.status(404).json({ error: 'player not found in duel' });
    if (!player.lapStarted) return res.status(409).json({ error: 'lap not started yet' });
    player.currentLapStart -= MIN_LAP_TIME_MS + 5000; // 5 s buffer ensures MIN_LAP_TIME_MS check always passes
    res.json({ success: true });
  });

  // Dev helper: force-trigger the duel timeout for a given user's active duel.
  // Used by e2e tests to verify timeout flow without waiting DUEL_TIMEOUT_MS.
  app.post('/api/dev/trigger-duel-timeout-for-user', devLimiter, (req, res) => {
    const { dbUserId } = req.body || {};
    if (!dbUserId) return res.status(400).json({ error: 'dbUserId required' });
    const dm = socketState && socketState.duelManager;
    if (!dm) return res.status(503).json({ error: 'duel manager not ready' });
    const duel = dm.getDuelByUserId(Number(dbUserId));
    if (!duel) return res.status(404).json({ error: 'no active duel for user' });
    dm._handleDuelTimeout(duel.id);
    res.json({ success: true });
  });
}

// ---------------------------------------------------------------------------
// 404 handler — must be after all routes
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'Не найдено.' });
});

// ---------------------------------------------------------------------------
// Global error handler — must be last middleware (4-argument signature)
// ---------------------------------------------------------------------------
const { errorHandler } = require('./middleware/error-handler');
app.use(errorHandler(metrics));

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

    // Signal PM2 that the app is ready to accept connections
    if (typeof process.send === 'function') {
      process.send('ready');
    }
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

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  metrics.log('info', 'shutdown_start', { signal });

  // 1. Stop accepting new connections
  server.close(() => {
    metrics.log('info', 'http_server_closed');
  });

  // 2. Stop the token cleanup interval
  clearInterval(TOKEN_CLEANUP_INTERVAL);

  // 3. Stop the device heartbeat check interval
  if (socketState && socketState.heartbeatCheckInterval) {
    clearInterval(socketState.heartbeatCheckInterval);
  }

  // 4. End all active rental sessions (save to DB, process hold/deduct)
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
        // Record for admin resolution
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

  // 5. Disconnect all sockets
  try {
    io.close();
    metrics.log('info', 'socketio_closed');
  } catch (e) {
    metrics.log('error', 'socketio_close_error', { error: e.message });
  }

  // 6. Close the database
  try {
    db.close();
    metrics.log('info', 'db_closed');
  } catch (e) {
    metrics.log('error', 'db_close_error', { error: e.message });
  }

  metrics.log('info', 'shutdown_complete', { signal });

  // 7. Force exit after timeout in case something hangs
  setTimeout(() => {
    process.stderr.write('[shutdown] Forced exit after timeout\n');
    process.exit(1);
  }, 5000).unref();

  process.exit(0);
}

// PM2 graceful shutdown message
process.on('message', (msg) => {
  if (msg === 'shutdown') {
    gracefulShutdown('PM2_SHUTDOWN');
  }
});

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
