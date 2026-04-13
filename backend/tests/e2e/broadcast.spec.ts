import { test, expect } from '@playwright/test';
import { resetDb, getCsrfToken, registerUser, activateUser } from './helpers';

/**
 * /broadcast page tests.
 *
 * Validates:
 *  1. Unauthenticated users are redirected to /login.
 *  2. Authenticated users can access /broadcast and see the viewport placeholder.
 *  3. Fullscreen toggle adds/removes the `is-fullscreen` class on the viewport.
 */

// ---------------------------------------------------------------------------
// Helpers (shared with other e2e specs)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('/broadcast page', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('unauthenticated: /broadcast redirects to /login', async ({ page }) => {
    const response = await page.goto('/broadcast');
    // Should land on /login (redirect)
    await expect(page).toHaveURL(/\/login/, { timeout: 5_000 });
    expect(response?.status()).not.toBe(500);
  });

  test('authenticated: /broadcast loads and shows viewport placeholder', async ({ page }) => {
    await resetDb(page);

    const user = await registerUser(page, 'broadcastuser', 'broadcast@example.com', 'Secure#Pass1');
    await activateUser(page, user.username);

    const response = await page.goto('/broadcast');
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/broadcast/);

    // Viewport container must be present
    const viewport = page.locator('#broadcast-viewport');
    await expect(viewport).toBeVisible({ timeout: 5_000 });

    // Overlay text must contain the placeholder label
    const overlay = page.locator('.overlay-label');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('ТРАНСЛЯЦИЯ');
  });

  test('fullscreen toggle: clicking "Развернуть" adds is-fullscreen class', async ({ page }) => {
    await resetDb(page);

    const user = await registerUser(page, 'fsuser', 'fsuser@example.com', 'Secure#Pass1');
    await activateUser(page, user.username);

    await page.goto('/broadcast');

    const viewport = page.locator('#broadcast-viewport');
    await expect(viewport).toBeVisible({ timeout: 5_000 });

    // Class must NOT be present initially
    await expect(viewport).not.toHaveClass(/is-fullscreen/);

    // Click the fullscreen button (outside the viewport)
    const fullscreenBtn = page.locator('#fullscreen-btn');
    await expect(fullscreenBtn).toBeVisible();
    await fullscreenBtn.click();

    // is-fullscreen class must be added
    await expect(viewport).toHaveClass(/is-fullscreen/, { timeout: 3_000 });

    // The exit button inside the viewport should now be visible
    const exitBtn = page.locator('#exit-fullscreen-btn');
    await expect(exitBtn).toBeVisible();
  });

  test('fullscreen toggle: clicking "Свернуть" removes is-fullscreen class', async ({ page }) => {
    await resetDb(page);

    const user = await registerUser(page, 'fsuser2', 'fsuser2@example.com', 'Secure#Pass1');
    await activateUser(page, user.username);

    await page.goto('/broadcast');

    const viewport = page.locator('#broadcast-viewport');
    await expect(viewport).toBeVisible({ timeout: 5_000 });

    // Enter fullscreen via button
    await page.locator('#fullscreen-btn').click();
    await expect(viewport).toHaveClass(/is-fullscreen/, { timeout: 3_000 });

    // Exit fullscreen via the in-viewport exit button
    const exitBtn = page.locator('#exit-fullscreen-btn');
    await expect(exitBtn).toBeVisible();
    await exitBtn.click();

    // is-fullscreen class must be removed
    await expect(viewport).not.toHaveClass(/is-fullscreen/, { timeout: 3_000 });
  });
});

// ---------------------------------------------------------------------------
// /api/config/video endpoint tests
// ---------------------------------------------------------------------------

test.describe('GET /api/config/video', () => {
  test('returns { streamUrl: null, type: null } when VIDEO_STREAM_URL is not set', async ({ page }) => {
    // In the test environment VIDEO_STREAM_URL is not set
    const res = await page.request.get('/api/config/video');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ streamUrl: null, type: null });
  });
});
