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
});
