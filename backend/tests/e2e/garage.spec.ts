import { test, expect } from '@playwright/test';

/**
 * Garage UI tests.
 *
 * Validates that the /garage page renders the car title element and that
 * the livery carousel switches the displayed title when a thumbnail is clicked.
 * These tests run against the DOM/HTML layer and do not depend on WebGL rendering.
 *
 * Also covers car availability guard: status badge display and CTA button
 * gating when car status is busy or offline.
 */

const CAROUSEL_TIMEOUT = 20_000;
const TITLE_TIMEOUT = 20_000;
const BADGE_TIMEOUT = 10_000;

test.describe('Garage UI', () => {
  test('page loads and shows initial car title', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');

    // The car title element must exist in the DOM
    const title = page.locator('#car-title');
    await expect(title).toBeVisible({ timeout: CAROUSEL_TIMEOUT });

    // Initial title: just ensure it becomes non-empty (some builds append livery later)
    await expect(title).toHaveText(/.+/, { timeout: TITLE_TIMEOUT });
  });

  test('carousel switches livery — title updates on thumbnail click', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');

    // Wait for the carousel to be rendered by JavaScript
    await page.waitForSelector('.car-thumb', { timeout: CAROUSEL_TIMEOUT });

    const title = page.locator('#car-title');
    await expect(title).toBeVisible();

    // Click the second thumbnail (index 1 → variant "Синий")
    const thumbs = page.locator('.car-thumb');
    await thumbs.nth(1).click();

    // Title must now reflect the selected variant
    await expect(title).toContainText('Синий', { timeout: TITLE_TIMEOUT });
    await expect(title).toContainText('Riley-X1');
  });

  test('carousel shows five livery thumbnails', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');
    await page.waitForSelector('.car-thumb', { timeout: CAROUSEL_TIMEOUT });
    const thumbs = page.locator('.car-thumb');
    await expect(thumbs).toHaveCount(5);
  });

  // Verify all five variants update the title correctly
  const VARIANTS: Array<{ index: number; name: string }> = [
    { index: 0, name: 'Алый' },
    { index: 1, name: 'Синий' },
    { index: 2, name: 'Зелёный' },
    { index: 3, name: 'Золотой' },
    { index: 4, name: 'Чёрный' },
  ];

  for (const { index, name } of VARIANTS) {
    test(`clicking thumbnail ${index} sets ${name} variant`, async ({ page }) => {
      await page.goto('/garage?forceFallback=1');
      await page.waitForSelector('.car-thumb', { timeout: CAROUSEL_TIMEOUT });
      await page.locator('.car-thumb').nth(index).click();
      await expect(page.locator('#car-title')).toContainText(name, { timeout: TITLE_TIMEOUT });
    });
  }
});

test.describe('Garage availability badge', () => {
  test('status badge is visible in fallback mode when car is available', async ({ page }) => {
    await page.route('/api/car-status', (route) =>
      route.fulfill({ json: { status: 'available', lastUpdated: new Date().toISOString() } }),
    );
    await page.goto('/garage?forceFallback=1');

    const badge = page.locator('#fallback-availability-badge');
    await expect(badge).toBeVisible({ timeout: BADGE_TIMEOUT });
    await expect(page.locator('#fallback-availability-text')).toHaveText('Доступна', { timeout: BADGE_TIMEOUT });
    await expect(badge).toHaveClass(/status-available/);
  });

  test('status badge shows "Занята" when car is busy', async ({ page }) => {
    await page.route('/api/car-status', (route) =>
      route.fulfill({ json: { status: 'busy', lastUpdated: new Date().toISOString() } }),
    );
    await page.goto('/garage?forceFallback=1');

    const badge = page.locator('#fallback-availability-badge');
    await expect(badge).toBeVisible({ timeout: BADGE_TIMEOUT });
    await expect(page.locator('#fallback-availability-text')).toHaveText('Занята', { timeout: BADGE_TIMEOUT });
    await expect(badge).toHaveClass(/status-busy/);
  });

  test('status badge shows "Недоступна" when car is offline', async ({ page }) => {
    await page.route('/api/car-status', (route) =>
      route.fulfill({ json: { status: 'offline', lastUpdated: new Date().toISOString() } }),
    );
    await page.goto('/garage?forceFallback=1');

    const badge = page.locator('#fallback-availability-badge');
    await expect(badge).toBeVisible({ timeout: BADGE_TIMEOUT });
    await expect(page.locator('#fallback-availability-text')).toHaveText('Недоступна', { timeout: BADGE_TIMEOUT });
    await expect(badge).toHaveClass(/status-offline/);
  });
});

test.describe('Garage CTA button gating', () => {
  // Use a fresh context (no session) so auth always resolves to guest.
  // Guest CTA is "Только просмотр / Войти" and should NOT be disabled by
  // availability (guest is always redirected to login regardless).
  // We test an active user (mock /api/auth/me) to isolate availability gating.

  test('CTA disabled and shows "Машина занята" when status=busy (fallback mode)', async ({ page }) => {
    await page.route('/api/car-status', (route) =>
      route.fulfill({ json: { status: 'busy', lastUpdated: new Date().toISOString() } }),
    );
    await page.route('/api/auth/me', (route) =>
      route.fulfill({ json: { user: { id: 1, username: 'tester', status: 'active' } } }),
    );

    await page.goto('/garage?forceFallback=1');

    const fallbackBtn = page.locator('#fallback-cta-btn');
    await expect(fallbackBtn).toBeVisible({ timeout: BADGE_TIMEOUT });
    await expect(fallbackBtn).toContainText('Машина занята', { timeout: BADGE_TIMEOUT });
    await expect(fallbackBtn).toBeDisabled();
  });

  test('CTA disabled and shows "Машина недоступна" when status=offline (fallback mode)', async ({ page }) => {
    await page.route('/api/car-status', (route) =>
      route.fulfill({ json: { status: 'offline', lastUpdated: new Date().toISOString() } }),
    );
    await page.route('/api/auth/me', (route) =>
      route.fulfill({ json: { user: { id: 1, username: 'tester', status: 'active' } } }),
    );

    await page.goto('/garage?forceFallback=1');

    const fallbackBtn = page.locator('#fallback-cta-btn');
    await expect(fallbackBtn).toBeVisible({ timeout: BADGE_TIMEOUT });
    await expect(fallbackBtn).toContainText('Машина недоступна', { timeout: BADGE_TIMEOUT });
    await expect(fallbackBtn).toBeDisabled();
  });

  test('CTA enabled and shows "Старт / Подключиться" when status=available (fallback mode)', async ({ page }) => {
    await page.route('/api/car-status', (route) =>
      route.fulfill({ json: { status: 'available', lastUpdated: new Date().toISOString() } }),
    );
    await page.route('/api/auth/me', (route) =>
      route.fulfill({ json: { user: { id: 1, username: 'tester', status: 'active' } } }),
    );

    await page.goto('/garage?forceFallback=1');

    const fallbackBtn = page.locator('#fallback-cta-btn');
    await expect(fallbackBtn).toBeVisible({ timeout: BADGE_TIMEOUT });
    await expect(fallbackBtn).toContainText('Старт / Подключиться', { timeout: BADGE_TIMEOUT });
    await expect(fallbackBtn).toBeEnabled();
  });
});
