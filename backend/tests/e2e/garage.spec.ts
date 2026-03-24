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
 *
 * WoT-style UI blocks: profile card, news panel, characteristics, upgrades grid,
 * center CTA button, and 5 carousel cards.
 */

const CAROUSEL_TIMEOUT = 20_000;
const TITLE_TIMEOUT = 20_000;
const BADGE_TIMEOUT = 10_000;
const UI_TIMEOUT = 15_000;

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

test.describe('Garage WoT-style UI blocks', () => {
  test('profile card is visible', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');
    const profileCard = page.locator('#profile-card');
    await expect(profileCard).toBeVisible({ timeout: UI_TIMEOUT });
  });

  test('news panel is visible', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');
    const newsPanel = page.locator('#news-panel');
    await expect(newsPanel).toBeVisible({ timeout: UI_TIMEOUT });
  });

  test('characteristics section is visible', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');
    const chars = page.locator('#characteristics-section');
    await expect(chars).toBeVisible({ timeout: UI_TIMEOUT });
  });

  test('upgrades grid is visible and has 6 items', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');
    const grid = page.locator('#upgrades-grid');
    await expect(grid).toBeVisible({ timeout: UI_TIMEOUT });
    const items = grid.locator('.upgrade-item');
    await expect(items).toHaveCount(6);
  });

  test('center CTA button is visible in fallback mode', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');
    const centerCta = page.locator('#center-cta-btn');
    await expect(centerCta).toBeVisible({ timeout: UI_TIMEOUT });
  });

  test('carousel shows five livery cards (duplicate guard)', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');
    await page.waitForSelector('.car-thumb', { timeout: CAROUSEL_TIMEOUT });
    const thumbs = page.locator('.car-thumb');
    await expect(thumbs).toHaveCount(5);
  });

  test('carousel prev/next arrows are present with aria-labels', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');
    const prev = page.locator('#carousel-prev');
    const next = page.locator('#carousel-next');
    await expect(prev).toBeVisible({ timeout: UI_TIMEOUT });
    await expect(next).toBeVisible({ timeout: UI_TIMEOUT });
    await expect(prev).toHaveAttribute('aria-label', /[Пп]редыдущ/);
    await expect(next).toHaveAttribute('aria-label', /[Сс]ледующ/);
  });

  test('balance section is visible in right panel', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');
    const balance = page.locator('#balance-section');
    await expect(balance).toBeVisible({ timeout: UI_TIMEOUT });
  });

  test('bonuses section is visible in right panel', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');
    const bonuses = page.locator('#bonuses-section');
    await expect(bonuses).toBeVisible({ timeout: UI_TIMEOUT });
  });
});
