import { test, expect } from '@playwright/test';
import { resetDb, getCsrfToken, registerUser, activateUser } from './helpers';

/**
 * Password reset flow e2e tests.
 *
 * Tests cover:
 *  - forgot-password page renders and submits
 *  - forgot-password is non-enumerating (always succeeds)
 *  - reset-password with a valid token updates the password
 *  - reset-password token is single-use
 *  - reset-password with an expired/invalid token returns an error
 *  - reset-password page shows error when no token in URL
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a password reset token via the dev API endpoint.
 * Returns the raw token.
 */
async function insertPasswordResetToken(
  page: import('@playwright/test').Page,
  userEmail: string,
  expiresAt: string,
): Promise<string> {
  const res = await page.request.post('/api/dev/insert-reset-token', {
    data: { email: userEmail, expiresAt },
  });
  expect(res.status(), `insertPasswordResetToken failed: ${await res.text()}`).toBe(200);
  const body = await res.json();
  return body.token as string;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Password reset flow', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('forgot-password page renders correctly', async ({ page }) => {
    await page.goto('/forgot-password');
    await expect(page.locator('h1')).toContainText('Восстановление пароля');
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#submit-btn')).toBeVisible();
  });

  test('forgot-password: unknown email still returns success (non-enumerating)', async ({ page }) => {
    await resetDb(page);
    await page.goto('/forgot-password');
    await page.fill('#email', 'nonexistent@example.com');
    await page.click('#submit-btn');
    await expect(page.locator('#success-box')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#success-box')).toContainText('Если этот email зарегистрирован');
  });

  test('forgot-password: known email returns success message', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'pwresetuser', 'pwreset@example.com', 'Secure#Pass1');
    await page.goto('/forgot-password');
    await page.fill('#email', 'pwreset@example.com');
    await page.click('#submit-btn');
    await expect(page.locator('#success-box')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#success-box')).toContainText('Если этот email зарегистрирован');
  });

  test('reset-password page shows error when no token in URL', async ({ page }) => {
    await page.goto('/reset-password');
    await expect(page.locator('#error-box')).toBeVisible();
    await expect(page.locator('#error-box')).toContainText('недействительна');
    await expect(page.locator('#reset-form')).not.toBeVisible();
  });

  test('reset-password: valid token allows password change', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'pwchangeuser', 'pwchange@example.com', 'Secure#Pass1');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const rawToken = await insertPasswordResetToken(page, 'pwchange@example.com', expiresAt);

    await page.goto(`/reset-password?token=${rawToken}`);
    await expect(page.locator('#reset-form')).toBeVisible();
    await page.fill('#password', 'NewSecure#Pass2');
    await page.fill('#confirm-password', 'NewSecure#Pass2');
    await page.click('#submit-btn');
    await expect(page.locator('#success-box')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#success-box')).toContainText('Пароль успешно изменён');
  });

  test('reset-password: token is single-use (second use fails)', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'pwsingleuser', 'pwsingle@example.com', 'Secure#Pass1');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const rawToken = await insertPasswordResetToken(page, 'pwsingle@example.com', expiresAt);

    // First use — should succeed
    const csrfToken = await getCsrfToken(page);
    const res1 = await page.request.post('/api/auth/reset-password', {
      data: { token: rawToken, password: 'NewSecure#Pass2', confirm_password: 'NewSecure#Pass2' },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    expect(body1.success).toBe(true);

    // Second use — should fail
    const csrfToken2 = await getCsrfToken(page);
    const res2 = await page.request.post('/api/auth/reset-password', {
      data: { token: rawToken, password: 'AnotherPass#3', confirm_password: 'AnotherPass#3' },
      headers: { 'X-CSRF-Token': csrfToken2 },
    });
    expect(res2.status()).toBe(400);
    const body2 = await res2.json();
    expect(body2.error).toMatch(/недействительна|использована/i);
  });

  test('reset-password: expired token returns error', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'pwexpireduser', 'pwexpired@example.com', 'Secure#Pass1');
    const expiresAt = new Date(Date.now() - 1000).toISOString(); // already expired
    const rawToken = await insertPasswordResetToken(page, 'pwexpired@example.com', expiresAt);

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post('/api/auth/reset-password', {
      data: { token: rawToken, password: 'NewSecure#Pass2', confirm_password: 'NewSecure#Pass2' },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/истекла/i);
  });

  test('reset-password: user can login with new password after reset', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'pwlogintest', 'pwlogintest@example.com', 'Secure#Pass1');

    // Activate user
    await activateUser(page, 'pwlogintest');

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const rawToken = await insertPasswordResetToken(page, 'pwlogintest@example.com', expiresAt);

    // Reset password
    const csrfToken = await getCsrfToken(page);
    const resetRes = await page.request.post('/api/auth/reset-password', {
      data: { token: rawToken, password: 'NewSecure#Pass2', confirm_password: 'NewSecure#Pass2' },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(resetRes.status()).toBe(200);

    // Login with new password
    const csrfToken2 = await getCsrfToken(page);
    const loginRes = await page.request.post('/api/auth/login', {
      data: { identifier: 'pwlogintest@example.com', password: 'NewSecure#Pass2' },
      headers: { 'X-CSRF-Token': csrfToken2 },
    });
    expect(loginRes.status()).toBe(200);
    const loginBody = await loginRes.json();
    expect(loginBody.success).toBe(true);

    // Old password should no longer work
    const csrfToken3 = await getCsrfToken(page);
    const loginOldRes = await page.request.post('/api/auth/login', {
      data: { identifier: 'pwlogintest@example.com', password: 'Secure#Pass1' },
      headers: { 'X-CSRF-Token': csrfToken3 },
    });
    expect(loginOldRes.status()).toBe(401);
  });
});
