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
