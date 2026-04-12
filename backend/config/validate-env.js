'use strict';

// backend/config/validate-env.js
// Validates environment configuration at server startup.
// In production: missing critical config → process.exit(1)
// In development: missing config → console.warn

function validateEnv() {
  const errors = [];   // Fatal in production
  const warnings = []; // Always logged, non-fatal
  const isProduction = process.env.NODE_ENV === 'production';

  // --- NODE_ENV ---
  if (!process.env.NODE_ENV) {
    warnings.push('NODE_ENV is not set — defaulting to "development".');
  }

  // --- SESSION_SECRET ---
  // This check already exists in server.js — move it here
  if (!process.env.SESSION_SECRET) {
    if (isProduction) {
      errors.push(
        'SESSION_SECRET is required in production. ' +
        'Generate one: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
      );
    } else {
      warnings.push('SESSION_SECRET not set — using random secret (sessions will not persist across restarts).');
    }
  }

  // --- YooKassa credentials must be paired ---
  const hasShopId = !!process.env.YOOKASSA_SHOP_ID;
  const hasSecretKey = !!process.env.YOOKASSA_SECRET_KEY;
  if (hasShopId !== hasSecretKey) {
    errors.push(
      'YooKassa config incomplete: both YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY must be set together, or both omitted.'
    );
  }

  // --- SMTP consistency ---
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const emailDisabled = process.env.DISABLE_EMAIL === 'true' || process.env.NODE_ENV === 'test';

  if (!emailDisabled) {
    if (smtpHost && (!smtpUser || !smtpPass)) {
      warnings.push('SMTP_HOST is set but SMTP_USER or SMTP_PASS is missing — email sending will likely fail.');
    }
    if (isProduction && !smtpHost) {
      warnings.push('SMTP_HOST not configured in production — email features will not work.');
    }
  }

  // --- DB_PATH accessibility ---
  // Only warn — the DB will be created if it doesn't exist, but the directory must be writable
  const dbPath = process.env.DB_PATH;
  if (dbPath) {
    const path = require('path');
    const fs = require('fs');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      errors.push(`DB_PATH directory does not exist: ${dir}`);
    }
  }

  // --- APP_BASE_URL in production ---
  if (isProduction && !process.env.APP_BASE_URL) {
    warnings.push('APP_BASE_URL not set in production — CORS and email links may not work correctly.');
  }

  // --- PORT validation ---
  if (process.env.PORT) {
    const port = parseInt(process.env.PORT, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      errors.push(`Invalid PORT value: "${process.env.PORT}" — must be a number between 1 and 65535.`);
    }
  }

  // --- SESSION_SECRET strength (production) ---
  if (isProduction && process.env.SESSION_SECRET) {
    const secret = process.env.SESSION_SECRET;
    if (secret.length < 32) {
      errors.push(
        `SESSION_SECRET is too short (${secret.length} chars). ` +
        'Minimum 32 characters required in production.'
      );
    }
    // Reject common placeholder values from .env.example
    const PLACEHOLDER_SECRETS = [
      'your-session-secret-here',
      'change-me',
      'secret',
      'session-secret',
      'mysecret',
    ];
    if (PLACEHOLDER_SECRETS.includes(secret.toLowerCase())) {
      errors.push(
        'SESSION_SECRET appears to be a placeholder value. ' +
        'Generate a real secret: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
      );
    }
  }

  // --- TRUST_PROXY in production ---
  if (isProduction && !process.env.TRUST_PROXY) {
    warnings.push(
      'TRUST_PROXY is not set in production. If behind a reverse proxy (nginx/Cloudflare), ' +
      'rate limiting will not work correctly (all requests share one IP bucket). ' +
      'Set TRUST_PROXY=1 or to your proxy IP/subnet.'
    );
  }

  // --- APP_BASE_URL format ---
  if (process.env.APP_BASE_URL) {
    const baseUrl = process.env.APP_BASE_URL;
    if (!/^https?:\/\/.+/.test(baseUrl)) {
      errors.push(
        `APP_BASE_URL must start with http:// or https:// — got: "${baseUrl}"`
      );
    }
    if (baseUrl.endsWith('/')) {
      warnings.push(
        'APP_BASE_URL has a trailing slash — this may cause double-slash issues in generated URLs. ' +
        `Consider: "${baseUrl.replace(/\/+$/, '')}"`
      );
    }
  }

  // --- ADMIN_USERNAMES in production ---
  if (isProduction && !process.env.ADMIN_USERNAMES) {
    warnings.push(
      'ADMIN_USERNAMES is not set in production — no users will have chat moderation rights. ' +
      'Set to a comma-separated list of admin usernames.'
    );
  }

  // --- SESSION_MAX_DURATION_MS format ---
  if (process.env.SESSION_MAX_DURATION_MS) {
    const val = parseInt(process.env.SESSION_MAX_DURATION_MS, 10);
    if (isNaN(val) || val <= 0) {
      errors.push(
        `Invalid SESSION_MAX_DURATION_MS value: "${process.env.SESSION_MAX_DURATION_MS}" — must be a positive integer (milliseconds).`
      );
    }
  }

  // --- CONTROL_RATE_LIMIT_MAX format ---
  if (process.env.CONTROL_RATE_LIMIT_MAX) {
    const val = parseInt(process.env.CONTROL_RATE_LIMIT_MAX, 10);
    if (isNaN(val) || val <= 0) {
      errors.push(
        `Invalid CONTROL_RATE_LIMIT_MAX value: "${process.env.CONTROL_RATE_LIMIT_MAX}" — must be a positive integer.`
      );
    }
  }

  // --- Log warnings ---
  for (const w of warnings) {
    console.warn(`[config] ⚠️  ${w}`);
  }

  // --- Handle errors ---
  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`[config] ❌ ${e}`);
    }
    if (isProduction) {
      console.error(`[config] ${errors.length} critical configuration error(s). Server cannot start in production.`);
      process.exit(1);
    } else {
      console.warn(`[config] ${errors.length} configuration error(s) detected (non-fatal in development).`);
    }
  }

  return { errors, warnings };
}

module.exports = { validateEnv };
