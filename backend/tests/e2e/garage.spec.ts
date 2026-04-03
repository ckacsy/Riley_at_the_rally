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

// ---------------------------------------------------------------------------
// Auth helpers — /garage is auth-guarded (PR #159)
// ---------------------------------------------------------------------------

async function resetDb(page: import('@playwright/test').Page): Promise<void> {
  await page.request.post('/api/dev/reset-db');
}

async function getCsrfToken(page: import('@playwright/test').Page): Promise<string> {
  const res = await page.request.get('/api/csrf-token');
  const body = await res.json();
  return body.csrfToken as string;
}

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

async function activateUser(
  page: import('@playwright/test').Page,
  username: string,
): Promise<void> {
  const res = await page.request.post('/api/dev/activate-user', {
    data: { username },
  });
  expect(res.status(), `activateUser failed: ${await res.text()}`).toBe(200);
}

async function loginUser(
  page: import('@playwright/test').Page,
  identifier: string,
  password: string,
): Promise<void> {
  const csrfToken = await getCsrfToken(page);
  const res = await page.request.post('/api/auth/login', {
    data: { identifier, password },
    headers: { 'X-CSRF-Token': csrfToken },
  });
  expect(res.status(), `login failed: ${await res.text()}`).toBe(200);
}

test.describe('Garage UI', () => {
  // /garage is auth-guarded: authenticate before each test.
  test.beforeEach(async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'garageui', 'garageui@test.com', 'Secure#Pass1');
    await activateUser(page, user.username);
    await loginUser(page, user.username, 'Secure#Pass1');
  });

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
  // /garage is auth-guarded: authenticate before each test.
  test.beforeEach(async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'garagebadge', 'garagebadge@test.com', 'Secure#Pass1');
    await activateUser(page, user.username);
    await loginUser(page, user.username, 'Secure#Pass1');
  });

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
  // /garage is auth-guarded: authenticate before each test.
  // Tests mock /api/auth/me to return an active user for client-side CTA logic;
  // the real session is still needed so the server serves the page.
  test.beforeEach(async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'garagecta', 'garagecta@test.com', 'Secure#Pass1');
    await activateUser(page, user.username);
    await loginUser(page, user.username, 'Secure#Pass1');
  });

  test('CTA disabled and shows "Машина занята" when status=busy (fallback mode)', async ({ page }) => {
    await page.route('/api/cars', (route) =>
      route.fulfill({ json: { cars: [], ratePerMinute: 0.5 } }),
    );
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
    await page.route('/api/cars', (route) =>
      route.fulfill({ json: { cars: [], ratePerMinute: 0.5 } }),
    );
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

  test('CTA enabled and shows "НА ТРЕК" when status=available (fallback mode)', async ({ page }) => {
    await page.route('/api/cars', (route) =>
      route.fulfill({ json: { cars: [], ratePerMinute: 0.5 } }),
    );
    await page.route('/api/car-status', (route) =>
      route.fulfill({ json: { status: 'available', lastUpdated: new Date().toISOString() } }),
    );
    await page.route('/api/auth/me', (route) =>
      route.fulfill({ json: { user: { id: 1, username: 'tester', status: 'active' } } }),
    );

    await page.goto('/garage?forceFallback=1');

    const fallbackBtn = page.locator('#fallback-cta-btn');
    await expect(fallbackBtn).toBeVisible({ timeout: BADGE_TIMEOUT });
    await expect(fallbackBtn).toContainText('НА ТРЕК', { timeout: BADGE_TIMEOUT });
    await expect(fallbackBtn).toBeEnabled();
  });
});

test.describe('Garage WoT-style UI blocks', () => {
  // /garage is auth-guarded: authenticate before each test.
  test.beforeEach(async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'garagewot', 'garagewot@test.com', 'Secure#Pass1');
    await activateUser(page, user.username);
    await loginUser(page, user.username, 'Secure#Pass1');
  });

  test('profile card is visible', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');
    const profileCard = page.locator('#profile-card');
    await expect(profileCard).toBeVisible({ timeout: UI_TIMEOUT });
  });

  test('news panel is visible', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');
    const newsPanel = page.locator('#news-panel');
    await newsPanel.waitFor({ state: 'attached', timeout: UI_TIMEOUT });
    await newsPanel.scrollIntoViewIfNeeded();
    await expect(newsPanel).toBeVisible({ timeout: UI_TIMEOUT });
  });

  test('characteristics section is visible', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');
    const chars = page.locator('#characteristics-section');
    await expect(chars).toBeVisible({ timeout: UI_TIMEOUT });
  });

  test('upgrades tab section is present in DOM', async ({ page }) => {
    // #upgrades-grid was removed; upgrades are now a WIP tab in the left panel.
    await page.goto('/garage?forceFallback=1');
    const upgradesTab = page.locator('#tab-upgrades');
    await upgradesTab.waitFor({ state: 'attached', timeout: UI_TIMEOUT });
    await expect(upgradesTab).toBeAttached();
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

  test('upgrades tab has section heading "Апгрейды машины"', async ({ page }) => {
    // #upgrades-section and its .rp-title were removed; heading is now in #tab-upgrades.
    await page.goto('/garage?forceFallback=1');
    const heading = page.locator('#tab-upgrades h3');
    await heading.waitFor({ state: 'attached', timeout: UI_TIMEOUT });
    await expect(heading).toContainText('Апгрейды', { timeout: UI_TIMEOUT });
  });

  test('upgrade items have no level text (Ур.)', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');
    const levelSpans = page.locator('.upgrade-level');
    await expect(levelSpans).toHaveCount(0);
  });

  test('upgrade items have rarity classes', async ({ page }) => {
    // Upgrade items were removed from the main view (now a WIP tab).
    // All rarity counts are 0 until upgrades are implemented.
    await page.goto('/garage?forceFallback=1');
    await expect(page.locator('.upgrade-item.rarity-legendary')).toHaveCount(0);
    await expect(page.locator('.upgrade-item.rarity-epic')).toHaveCount(0);
    await expect(page.locator('.upgrade-item.rarity-rare')).toHaveCount(0);
    await expect(page.locator('.upgrade-item.rarity-common')).toHaveCount(0);
  });

  test('status bar has no gold credits element', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');
    const goldCredits = page.locator('.sb-credits');
    await expect(goldCredits).toHaveCount(0);
  });

  test('carousel is centered (carousel-wrap has symmetric left/right)', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');
    const wrap = page.locator('#carousel-wrap');
    await expect(wrap).toBeVisible({ timeout: UI_TIMEOUT });
    // Verify carousel-wrap has symmetric left/right (both 240px) for centered positioning
    const leftPx = await wrap.evaluate((el) => window.getComputedStyle(el).left);
    const rightPx = await wrap.evaluate((el) => window.getComputedStyle(el).right);
    expect(leftPx).toBe(rightPx);
    // Verify carousel-row has justify-content: center
    const row = page.locator('.carousel-row');
    const justifyContent = await row.evaluate((el) => window.getComputedStyle(el).justifyContent);
    expect(justifyContent).toBe('center');
  });
});
