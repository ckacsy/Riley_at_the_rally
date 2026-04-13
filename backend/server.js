// Must be first: override DNS so Node.js can resolve hostnames in VPN/Docker/WSL
// environments where the system resolver is broken for the Node.js process.
// Configurable via DNS_SERVERS env var (comma-separated IPs).
{
  const dns = require('dns');
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

// Load environment variables from backend/.env; falls back to repo-root .env.
{
  const backendEnvPath = path.join(__dirname, '.env');
  const rootEnvPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(backendEnvPath)) {
    const result = require('dotenv').config({ path: backendEnvPath });
    if (result.error) console.warn(`[dotenv] Failed to parse ${backendEnvPath}:`, result.error.message);
    else console.log(`[dotenv] Loaded env from: ${backendEnvPath}`);
  } else if (fs.existsSync(rootEnvPath)) {
    const result = require('dotenv').config({ path: rootEnvPath });
    if (result.error) console.warn(`[dotenv] Failed to parse ${rootEnvPath}:`, result.error.message);
    else console.log(`[dotenv] Loaded env from fallback: ${rootEnvPath}`);
  } else {
    console.warn(`[dotenv] No .env file found at ${backendEnvPath} or ${rootEnvPath}; relying on process environment.`);
  }
}

const { validateEnv } = require('./config/validate-env');
validateEnv();

const {
  RATE_PER_MINUTE, INACTIVITY_TIMEOUT_MS, SESSION_MAX_DURATION_MS,
  CONTROL_RATE_LIMIT_MAX, CONTROL_RATE_LIMIT_WINDOW_MS, CARS,
} = require('./config/constants');

const metrics = require('./metrics');
const mailer = require('./mailer');
const { isKnownRole, STATUSES } = require('./middleware/roles');
const { logAdminAudit } = require('./utils/adminAudit');
const { normalizeEmail, normalizeUsername } = require('./validators');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Trust first proxy (nginx/Cloudflare) so req.ip returns the real client IP.
if (process.env.TRUST_PROXY) {
  const trustValue = process.env.TRUST_PROXY;
  const numVal = parseInt(trustValue, 10);
  if (!isNaN(numVal)) {
    app.set('trust proxy', numVal);
  } else if (trustValue === 'true') {
    app.set('trust proxy', 1);
  } else {
    app.set('trust proxy', trustValue);
  }
  console.log('[server] trust proxy set to:', app.get('trust proxy'));
}

const corsOrigin = process.env.NODE_ENV === 'production'
  ? (process.env.APP_BASE_URL || false)
  : true;
app.use(cors({ origin: corsOrigin, credentials: true }));

app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "blob:", "*"],
    mediaSrc: ["'self'", "*"],
    connectSrc: ["'self'", "ws:", "wss:"],
    fontSrc: ["'self'"], objectSrc: ["'none'"], frameSrc: ["'none'"],
    frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
  }},
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginEmbedderPolicy: false,
}));

app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  next();
});

// Redirect HTTP → HTTPS in production when behind a trusted proxy.
if (process.env.NODE_ENV === 'production' && process.env.TRUST_PROXY) {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

const { requestLogger } = require('./middleware/request-logger');
app.use(requestLogger(metrics));

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
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});
app.use(sessionMiddleware);

const PORT = process.env.PORT || 5000;
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

const { upload, uploadsDir } = require('./middleware/upload');
app.use('/uploads', express.static(uploadsDir, { dotfiles: 'deny', index: false, redirect: false }));

// Prevent caching of sensitive API responses (auth, admin, payment).
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

const apiReadLimiter = createRateLimiter({ max: 60 });

// Mount all auth & profile routes; get back shared middleware and dev maps
const mountAuthRoutes = require('./routes/auth');
const {
  requireAuth,
  requireActiveUser,
  loadCurrentUser,
  requireRole,
  invalidateUserSessions,
  _devVerificationLinks,
  _devMagicLinks,
  _devResetLinks,
} = mountAuthRoutes(app, db, { csrfMiddleware, generateCsrfToken, apiReadLimiter, PORT });

const adminRouteDeps = {
  requireAuth,
  requireActiveUser,
  loadCurrentUser,
  requireRole,
  csrfMiddleware,
  logAdminAudit: (auditData) => logAdminAudit(db, auditData),
  invalidateUserSessions,
};

const mountPaymentRoutes = require('./routes/payment');
mountPaymentRoutes(app, db, {
  requireAuth, requireActiveUser, csrfMiddleware, apiReadLimiter,
  getActiveSessions: () => socketState && socketState.activeSessions,
});

const mountDailyBonusRoutes = require('./routes/daily-bonus');
mountDailyBonusRoutes(app, db, { requireAuth, requireActiveUser, csrfMiddleware, apiReadLimiter });

require('./routes/admin')(app, db, adminRouteDeps);
require('./routes/news')(app, db, adminRouteDeps);
require('./routes/admin-sessions')(app, db, {
  ...adminRouteDeps,
  getActiveSessions: () => socketState && socketState.activeSessions,
  getCars: () => CARS,
  getRatePerMinute: () => RATE_PER_MINUTE,
  forceEndSession: (carId, ctx) => socketState && socketState.forceEndSession(carId, ctx),
});
require('./routes/admin-transactions')(app, db, {
  ...adminRouteDeps,
  getActiveSessions: () => socketState && socketState.activeSessions,
});
require('./routes/admin-analytics')(app, db, {
  ...adminRouteDeps,
  getCars: () => CARS,
});
require('./routes/admin-cars')(app, db, {
  ...adminRouteDeps,
  getActiveSessions: () => socketState && socketState.activeSessions,
  broadcastCarsUpdate: () => socketState && socketState.broadcastCarsUpdate(),
}, { CARS });
require('./routes/admin-devices')(app, db, adminRouteDeps, {
  CARS,
  getDeviceSockets: () => socketState && socketState.deviceSockets,
});
require('./routes/admin-investigation')(app, db, adminRouteDeps);
require('./routes/admin-chat')(app, db, adminRouteDeps, { io });
require('./routes/admin-dashboard')(app, db, {
  requireRole,
  getActiveSessions: () => socketState && socketState.activeSessions,
  CARS,
});
require('./routes/rank')(app, db, { requireAuth, apiReadLimiter });
require('./routes/duel')(app, db, {
  requireAuth, requireActiveUser, apiReadLimiter,
  getDuelManager: () => socketState && socketState.duelManager,
});

function saveRentalSession(dbUserId, carId, durationSeconds, cost, sessionRef, terminationReason) {
  if (!dbUserId) return;
  const carName = CARS.find((c) => c.id === carId)?.name || ('Машина #' + carId);
  try {
    const t0 = Date.now();
    db.prepare(
      'INSERT INTO rental_sessions (user_id, car_id, car_name, duration_seconds, cost, session_ref, termination_reason) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(dbUserId, carId, carName, durationSeconds, cost, sessionRef || null, terminationReason || null);
    metrics.recordDbLatency(Date.now() - t0);
  } catch (e) {
    console.error('Failed to save rental session:', e.message);
  }
}

// NOTE: ADMIN_USERNAMES is kept for backward compatibility and env validation
// (config/validate-env.js warns when it is absent in production).
// It is NO LONGER used for runtime authorization — admin auth is now unified
// under the DB-based RBAC system (users.role column).
const ADMIN_USERNAMES = new Set(
  (process.env.ADMIN_USERNAMES || '').split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

// ---------------------------------------------------------------------------
// Periodic cleanup of expired tokens and stale data
// ---------------------------------------------------------------------------
const createTokenCleanup = require('./lib/token-cleanup');
const runTokenCleanup = createTokenCleanup(db, metrics, __dirname);
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
});

// --- Mount route modules ---
const mountCarsRoutes = require('./routes/cars');
mountCarsRoutes(app, db, { socketState, CARS, RATE_PER_MINUTE, apiReadLimiter });

const mountHealthRoutes = require('./routes/health');
mountHealthRoutes(app, { io, metrics, socketState, db, https, http, createRateLimiter });

const mountMetricsRoutes = require('./routes/metrics');
mountMetricsRoutes(app, { metrics, socketState, io, requireAuth, createRateLimiter, db });

const mountLeaderboardRoutes = require('./routes/leaderboard');
mountLeaderboardRoutes(app, db, { apiReadLimiter });

const mountConfigRoutes = require('./routes/config');
mountConfigRoutes(app, { SESSION_MAX_DURATION_MS, INACTIVITY_TIMEOUT_MS });

const mountSessionEndRoute = require('./routes/session-end');
mountSessionEndRoute(app, { socketState, saveRentalSession, metrics, RATE_PER_MINUTE });

const mountPageRoutes = require('./routes/pages');
mountPageRoutes(app, { frontendDir, createRateLimiter });

const mountDevRoutes = require('./routes/dev');
mountDevRoutes(app, db, {
  socketState,
  normalizeEmail,
  normalizeUsername,
  isKnownRole,
  STATUSES,
  _devVerificationLinks,
  _devMagicLinks,
  _devResetLinks,
  invalidateUserSessions,
  adminRouteDeps,
  csrfMiddleware,
  createRateLimiter,
  DB_PATH,
});

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

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const createStartServer = require('./lib/start-server');
const BASE_PORT = parseInt(PORT, 10) || 5000;
const startServer = createStartServer(server, metrics, mailer, BASE_PORT);
startServer(BASE_PORT);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
const createGracefulShutdown = require('./lib/graceful-shutdown');
const gracefulShutdown = createGracefulShutdown({
  server,
  io,
  db,
  socketState,
  metrics,
  RATE_PER_MINUTE,
  saveRentalSession,
  getTokenCleanupInterval: () => TOKEN_CLEANUP_INTERVAL,
});

// PM2 graceful shutdown message
process.on('message', (msg) => {
  if (msg === 'shutdown') gracefulShutdown('PM2_SHUTDOWN');
});

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
