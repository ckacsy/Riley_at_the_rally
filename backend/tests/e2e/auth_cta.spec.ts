import { test, expect } from '@playwright/test';
import { resetDb, getCsrfToken, registerUser, activateUser } from './helpers';

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
 * User activation is performed via the /api/dev/activate-user endpoint.
 */

/** Milliseconds to wait for the CTA button to settle after /api/auth/me. */
const CTA_TIMEOUT = 20_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    // After PR#159, /garage requires a session. Register to satisfy the auth guard,
    // then mock /api/auth/me to return null so the client-side JS treats the page
    // visitor as a guest (no authenticated user).
    await resetDb(page);
    await page.route('/api/auth/me', (route) =>
      route.fulfill({ json: { user: null } }),
    );
    await registerUser(page, 'guestaccess', 'guestaccess@test.com', 'Secure#Pass1');
    await page.goto('/garage?forceFallback=1');
    await waitForCta(page, 'Только просмотр');
    await expect(page.locator('#cta-btn')).toContainText('Войти');
    await expect(page.locator('#cta-btn')).toHaveClass(/observer/);
  });

  test('guest: CTA click redirects to /login', async ({ page }) => {
    // After PR#159, /garage requires a session. Register to satisfy the auth guard,
    // then mock /api/auth/me to return null so the client-side JS treats the page
    // visitor as a guest and the center CTA shows "Войти" → /login redirect.
    await resetDb(page);
    await page.route('/api/auth/me', (route) =>
      route.fulfill({ json: { user: null } }),
    );
    await registerUser(page, 'guestclick', 'guestclick@test.com', 'Secure#Pass1');
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

    // Ensure car status is 'available' regardless of server state
    await page.route('/api/car-status', (route) =>
      route.fulfill({ json: { status: 'available', lastUpdated: new Date().toISOString() } }),
    );
    await page.route('/api/cars', (route) =>
      route.fulfill({
        json: {
          ratePerMinute: 0.5,
          cars: [
            { id: 1, name: 'Riley-X1 · Алый', model: 'Drift Car', status: 'available' },
            { id: 2, name: 'Riley-X1 · Синий', model: 'Drift Car', status: 'available' },
            { id: 3, name: 'Riley-X1 · Зелёный', model: 'Drift Car', status: 'available' },
            { id: 4, name: 'Riley-X1 · Золотой', model: 'Drift Car', status: 'available' },
            { id: 5, name: 'Riley-X1 · Чёрный', model: 'Drift Car', status: 'available' },
          ],
        },
      }),
    );

    const user = await registerUser(
      page,
      'testactive',
      'testactive@example.com',
      'Secure#Pass1',
    );

    // Directly set status to 'active' in the database (bypasses email flow)
    await activateUser(page, user.username);

    // Navigate to garage — /api/auth/me will now return status='active'
    await page.goto('/garage?forceFallback=1');
    await waitForCta(page, 'НА ТРЕК');
    await expect(page.locator('#cta-btn')).not.toHaveClass(/observer/);
  });
});