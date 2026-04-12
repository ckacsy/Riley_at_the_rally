'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

describe('validate-env', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    delete require.cache[require.resolve('../../config/validate-env')];
  });

  it('passes with no errors in development with defaults', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.SESSION_SECRET;
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const { errors } = validateEnv();
    // No fatal errors in development
    assert.ok(errors.length === 0, 'Should have no fatal errors in development');
  });

  it('reports error for mismatched YooKassa credentials', () => {
    process.env.NODE_ENV = 'development';
    process.env.YOOKASSA_SHOP_ID = '12345';
    delete process.env.YOOKASSA_SECRET_KEY;
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const { errors } = validateEnv();
    const hasYookassaError = errors.some(e => e.includes('YooKassa'));
    assert.ok(hasYookassaError, 'Should report YooKassa config error');
  });

  it('reports error for invalid PORT', () => {
    process.env.NODE_ENV = 'development';
    process.env.PORT = 'not-a-number';
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const { errors } = validateEnv();
    const hasPortError = errors.some(e => e.includes('PORT'));
    assert.ok(hasPortError, 'Should report invalid PORT error');
  });

  it('reports no error when both YooKassa credentials are set', () => {
    process.env.NODE_ENV = 'development';
    process.env.YOOKASSA_SHOP_ID = '12345';
    process.env.YOOKASSA_SECRET_KEY = 'secret';
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const { errors } = validateEnv();
    const hasYookassaError = errors.some(e => e.includes('YooKassa'));
    assert.ok(!hasYookassaError, 'Should not report YooKassa error when both credentials are set');
  });

  it('reports no error when both YooKassa credentials are omitted', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.YOOKASSA_SHOP_ID;
    delete process.env.YOOKASSA_SECRET_KEY;
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const { errors } = validateEnv();
    const hasYookassaError = errors.some(e => e.includes('YooKassa'));
    assert.ok(!hasYookassaError, 'Should not report YooKassa error when both credentials are omitted');
  });

  it('reports no error for valid PORT', () => {
    process.env.NODE_ENV = 'development';
    process.env.PORT = '3000';
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const { errors } = validateEnv();
    const hasPortError = errors.some(e => e.includes('PORT'));
    assert.ok(!hasPortError, 'Should not report error for valid PORT');
  });

  it('warns about SMTP misconfiguration when SMTP_HOST set without credentials', () => {
    process.env.NODE_ENV = 'development';
    process.env.SMTP_HOST = 'smtp.example.com';
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.DISABLE_EMAIL;
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const { warnings } = validateEnv();
    const hasSmtpWarning = warnings.some(w => w.includes('SMTP_HOST') && w.includes('SMTP_USER'));
    assert.ok(hasSmtpWarning, 'Should warn about SMTP misconfiguration');
  });

  it('skips email checks when NODE_ENV=test', () => {
    process.env.NODE_ENV = 'test';
    process.env.SMTP_HOST = 'smtp.example.com';
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.DISABLE_EMAIL;
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const { warnings } = validateEnv();
    const hasSmtpWarning = warnings.some(w => w.includes('SMTP'));
    assert.ok(!hasSmtpWarning, 'Should skip SMTP checks in test environment');
  });

  it('returns both errors and warnings arrays', () => {
    process.env.NODE_ENV = 'development';
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const result = validateEnv();
    assert.ok(Array.isArray(result.errors), 'errors should be an array');
    assert.ok(Array.isArray(result.warnings), 'warnings should be an array');
  });

  // --- New tests for 5.2 ---

  it('reports error for short SESSION_SECRET in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'short';
    // Set other required production vars to avoid unrelated errors
    delete process.env.YOOKASSA_SHOP_ID;
    delete process.env.YOOKASSA_SECRET_KEY;
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    // Override process.exit to prevent test process from dying
    const origExit = process.exit;
    let exitCalled = false;
    process.exit = () => { exitCalled = true; };
    try {
      const { errors } = validateEnv();
      const hasSecretLengthError = errors.some(e => e.includes('too short'));
      assert.ok(hasSecretLengthError, 'Should report SESSION_SECRET too short');
    } finally {
      process.exit = origExit;
    }
  });

  it('reports error for placeholder SESSION_SECRET in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'your-session-secret-here';
    delete process.env.YOOKASSA_SHOP_ID;
    delete process.env.YOOKASSA_SECRET_KEY;
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const origExit = process.exit;
    process.exit = () => {};
    try {
      const { errors } = validateEnv();
      const hasPlaceholderError = errors.some(e => e.includes('placeholder'));
      assert.ok(hasPlaceholderError, 'Should report placeholder SESSION_SECRET');
    } finally {
      process.exit = origExit;
    }
  });

  it('accepts long SESSION_SECRET in production without strength errors', () => {
    const longSecret = require('crypto').randomBytes(48).toString('hex');
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = longSecret;
    delete process.env.YOOKASSA_SHOP_ID;
    delete process.env.YOOKASSA_SECRET_KEY;
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const origExit = process.exit;
    process.exit = () => {};
    try {
      const { errors } = validateEnv();
      const hasSecretError = errors.some(e => e.includes('SESSION_SECRET') && (e.includes('too short') || e.includes('placeholder')));
      assert.ok(!hasSecretError, 'Should not report errors for a strong SESSION_SECRET');
    } finally {
      process.exit = origExit;
    }
  });

  it('does not check SESSION_SECRET strength in development', () => {
    process.env.NODE_ENV = 'development';
    process.env.SESSION_SECRET = 'short';
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const { errors } = validateEnv();
    const hasSecretLengthError = errors.some(e => e.includes('too short'));
    assert.ok(!hasSecretLengthError, 'Should not check SESSION_SECRET length in development');
  });

  it('warns about missing TRUST_PROXY in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = require('crypto').randomBytes(48).toString('hex');
    delete process.env.TRUST_PROXY;
    delete process.env.YOOKASSA_SHOP_ID;
    delete process.env.YOOKASSA_SECRET_KEY;
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const origExit = process.exit;
    process.exit = () => {};
    try {
      const { warnings } = validateEnv();
      const hasTrustProxyWarning = warnings.some(w => w.includes('TRUST_PROXY'));
      assert.ok(hasTrustProxyWarning, 'Should warn about missing TRUST_PROXY in production');
    } finally {
      process.exit = origExit;
    }
  });

  it('does not warn about TRUST_PROXY in development', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.TRUST_PROXY;
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const { warnings } = validateEnv();
    const hasTrustProxyWarning = warnings.some(w => w.includes('TRUST_PROXY'));
    assert.ok(!hasTrustProxyWarning, 'Should not warn about TRUST_PROXY in development');
  });

  it('reports error for APP_BASE_URL without protocol', () => {
    process.env.NODE_ENV = 'development';
    process.env.APP_BASE_URL = 'example.com';
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const { errors } = validateEnv();
    const hasUrlError = errors.some(e => e.includes('APP_BASE_URL') && e.includes('http'));
    assert.ok(hasUrlError, 'Should report APP_BASE_URL without protocol');
  });

  it('warns about APP_BASE_URL trailing slash', () => {
    process.env.NODE_ENV = 'development';
    process.env.APP_BASE_URL = 'https://example.com/';
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const { warnings } = validateEnv();
    const hasTrailingSlashWarning = warnings.some(w => w.includes('trailing slash'));
    assert.ok(hasTrailingSlashWarning, 'Should warn about trailing slash in APP_BASE_URL');
  });

  it('accepts valid APP_BASE_URL without errors', () => {
    process.env.NODE_ENV = 'development';
    process.env.APP_BASE_URL = 'https://example.com';
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const { errors, warnings } = validateEnv();
    const hasUrlError = errors.some(e => e.includes('APP_BASE_URL'));
    const hasUrlWarning = warnings.some(w => w.includes('APP_BASE_URL') && w.includes('trailing'));
    assert.ok(!hasUrlError, 'Should not report error for valid APP_BASE_URL');
    assert.ok(!hasUrlWarning, 'Should not warn about trailing slash for valid URL');
  });

  it('warns about missing ADMIN_USERNAMES in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = require('crypto').randomBytes(48).toString('hex');
    delete process.env.ADMIN_USERNAMES;
    delete process.env.YOOKASSA_SHOP_ID;
    delete process.env.YOOKASSA_SECRET_KEY;
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const origExit = process.exit;
    process.exit = () => {};
    try {
      const { warnings } = validateEnv();
      const hasAdminWarning = warnings.some(w => w.includes('ADMIN_USERNAMES'));
      assert.ok(hasAdminWarning, 'Should warn about missing ADMIN_USERNAMES in production');
    } finally {
      process.exit = origExit;
    }
  });

  it('reports error for invalid SESSION_MAX_DURATION_MS', () => {
    process.env.NODE_ENV = 'development';
    process.env.SESSION_MAX_DURATION_MS = 'abc';
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const { errors } = validateEnv();
    const hasDurationError = errors.some(e => e.includes('SESSION_MAX_DURATION_MS'));
    assert.ok(hasDurationError, 'Should report invalid SESSION_MAX_DURATION_MS');
  });

  it('reports error for invalid CONTROL_RATE_LIMIT_MAX', () => {
    process.env.NODE_ENV = 'development';
    process.env.CONTROL_RATE_LIMIT_MAX = 'xyz';
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const { errors } = validateEnv();
    const hasRateLimitError = errors.some(e => e.includes('CONTROL_RATE_LIMIT_MAX'));
    assert.ok(hasRateLimitError, 'Should report invalid CONTROL_RATE_LIMIT_MAX');
  });

  it('accepts valid SESSION_MAX_DURATION_MS and CONTROL_RATE_LIMIT_MAX', () => {
    process.env.NODE_ENV = 'development';
    process.env.SESSION_MAX_DURATION_MS = '300000';
    process.env.CONTROL_RATE_LIMIT_MAX = '30';
    delete require.cache[require.resolve('../../config/validate-env')];
    const { validateEnv } = require('../../config/validate-env');
    const { errors } = validateEnv();
    const hasDurationError = errors.some(e => e.includes('SESSION_MAX_DURATION_MS'));
    const hasRateLimitError = errors.some(e => e.includes('CONTROL_RATE_LIMIT_MAX'));
    assert.ok(!hasDurationError, 'Should not report error for valid SESSION_MAX_DURATION_MS');
    assert.ok(!hasRateLimitError, 'Should not report error for valid CONTROL_RATE_LIMIT_MAX');
  });
});
