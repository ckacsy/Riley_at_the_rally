import { test, expect } from '@playwright/test';
import path from 'path';

/**
 * CTA button role-state tests.
 *
 * Validates that the /garage CTA button displays the correct label and
 * behaviour for three distinct user roles:
 *  - Guest (unauthenticated)
 *  - Pending user (registered but email not verified)
 *  - Active user  (email verified / status forced to 'active')
 *
 * Each test resets the database via /api/dev/reset-db so it starts clean.
 * User activation is performed directly against the SQLite file using
 * better-sqlite3 running inside the test process (separate DB connection).
 */

const DB_PATH = path.join(__dirname, '../../riley.sqlite');

/** Milliseconds to wait for the CTA button to settle after /api/auth/me. */
const CTA_TIMEOUT = 20_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reset the database and destroy the current session.
 * The endpoint is only available when NODE_ENV !== 'production'.
 */
async function resetDb(page: import('@playwright/test').Page): Promise<void> {
  await page.request.post('/api/dev/reset-db');
}

/**
 * Obtain a fresh CSRF token for the current browser context / session.
 */
async function getCsrfToken(page: import('@playwright/test').Page): Promise<string> {
  const res = await page.request.get('/api/csrf-token');
  const body = await res.json();
  return body.csrfToken as string;
}

/**
 * Register a new user via the API (uses the page's cookie jar so the
 * resulting session is shared with the browser).
 */
async function registerUser(
  page: import('@playwright/test').Page,
  username: string,
  email: string,
  password: string,
): Promise<{ id: number; username: string; status: string }> {
  const csrfToken = await getCsrfToken(page);
  const res = await page.request.post('/api/auth/register', {
    data: { username, email, password, confirm_password: password },
    headers: { 'X-CSRF-Token': csrfToken },
  });
  expect(res.status(), `register failed: ${await res.text()}`).toBe(200);
  const body = await res.json();
  return body.user;
}

/**
 * Flip a user's status to 'active' directly in the SQLite database.
 * This bypasses the email-verification flow, matching what the problem
 * statement specifies ("open backend/riley.sqlite via better-sqlite3").
 *
 * better-sqlite3 is a native CommonJS module; require() is intentional here
 * because dynamic import() does not work reliably with native add-ons.
 */
function activateUser(username: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3');
  const db = new BetterSqlite3(DB_PATH);
  try {
    db.prepare("UPDATE users SET status = 'active' WHERE username = ?").run(username);
  } finally {
    db.close();
  }
}

/**
 * Wait for the CTA button to leave its initial "Загрузка…" state and settle
 * on the text driven by the auth check (/api/auth/me response).
 */
async function waitForCta(
  page: import('@playwright/test').Page,
  expectedText: string,
  timeout = CTA_TIMEOUT,
): Promise<void> {
  await expect(page.locator('#cta-btn')).toContainText(expectedText, { timeout });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test.describe('CTA button states by role', () => {
  // Give each test its own browser context so cookies / sessions are isolated
  test.use({ storageState: { cookies: [], origins: [] } });

  test('guest: CTA shows "Только просмотр / Войти"', async ({ page }) => {
    // No cookies, no session — pure guest
    await page.goto('/garage?forceFallback=1');
    await waitForCta(page, 'Только просмотр');
    await expect(page.locator('#cta-btn')).toContainText('Войти');
    await expect(page.locator('#cta-btn')).toHaveClass(/observer/);
  });

  test('guest: CTA click redirects to /login', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');
    await waitForCta(page, 'Только просмотр');

    // The visible center CTA button ('Войти') redirects guests to /login
    await page.locator('#center-cta-btn').click();

    await expect(page).toHaveURL(/\/login/, { timeout: 5_000 });
  });

  test('pending user: CTA shows "Подтвердите email"', async ({ page }) => {
    await resetDb(page);

    // Register creates user with status='pending' and logs them in
    await registerUser(page, 'testpending', 'testpending@example.com', 'Secure#Pass1');

    await page.goto('/garage?forceFallback=1');
    await waitForCta(page, 'Подтвердите email');
  });

  test('active user: CTA shows "НА ТРЕК"', async ({ page }) => {
    await resetDb(page);

    const user = await registerUser(
      page,
      'testactive',
      'testactive@example.com',
      'Secure#Pass1',
    );

    // Directly set status to 'active' in the database (bypasses email flow)
    activateUser(user.username);

    // Navigate to garage — /api/auth/me will now return status='active'
    await page.goto('/garage?forceFallback=1');
    await waitForCta(page, 'НА ТРЕК');
    await expect(page.locator('#cta-btn')).not.toHaveClass(/observer/);
  });
});