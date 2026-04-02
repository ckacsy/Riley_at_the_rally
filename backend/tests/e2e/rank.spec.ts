import { test, expect } from '@playwright/test';

async function resetDb(request: import('@playwright/test').APIRequestContext): Promise<void> {
  await request.post('/api/dev/reset-db');
}

async function getCsrfToken(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.get('/api/csrf-token');
  const body = await res.json();
  return body.csrfToken as string;
}

async function registerUser(
  request: import('@playwright/test').APIRequestContext,
  username: string,
  email: string,
  password: string,
): Promise<{ id: number; username: string; status: string }> {
  const csrfToken = await getCsrfToken(request);
  const res = await request.post('/api/auth/register', {
    data: { username, email, password, confirm_password: password },
    headers: { 'X-CSRF-Token': csrfToken },
  });
  expect(res.status(), `register failed: ${await res.text()}`).toBe(200);
  const body = await res.json();
  return body.user;
}

async function activateUser(request: import('@playwright/test').APIRequestContext, username: string): Promise<void> {
  const res = await request.post('/api/dev/activate-user', { data: { username } });
  expect(res.status(), `activateUser failed: ${await res.text()}`).toBe(200);
}

async function loginUser(request: import('@playwright/test').APIRequestContext, identifier: string, password: string): Promise<void> {
  const csrfToken = await getCsrfToken(request);
  const res = await request.post('/api/auth/login', {
    data: { identifier, password },
    headers: { 'X-CSRF-Token': csrfToken },
  });
  expect(res.status(), `login failed: ${await res.text()}`).toBe(200);
}

/**
 * Rank API smoke tests.
 * Validates GET /api/profile/rank and GET /api/rankings response shapes.
 */

test.describe('GET /api/profile/rank', () => {
  test('requires authentication — returns 401 when not logged in', async ({ request }) => {
    const res = await request.get('/api/profile/rank');
    expect(res.status()).toBe(401);
  });

  test('returns rank data with expected shape for authenticated user', async ({ request }) => {
    await resetDb(request);
    const user = await registerUser(request, 'rankuser', 'rankuser@example.com', 'Secure#Pass1');
    await activateUser(request, user.username);
    await loginUser(request, user.username, 'Secure#Pass1');

    const res = await request.get('/api/profile/rank');
    expect(res.status()).toBe(200);
    const body = await res.json();

    // Required fields
    expect(typeof body.rank).toBe('number');
    expect(typeof body.stars).toBe('number');
    expect(typeof body.isLegend).toBe('boolean');
    expect(typeof body.duelsWon).toBe('number');
    expect(typeof body.duelsLost).toBe('number');

    // Default values for a brand-new user
    expect(body.rank).toBe(15);
    expect(body.stars).toBe(0);
    expect(body.isLegend).toBe(false);
    expect(body.legendPosition).toBeNull();
    expect(body.duelsWon).toBe(0);
    expect(body.duelsLost).toBe(0);

    // Display object
    expect(body.display).toHaveProperty('label');
    expect(body.display).toHaveProperty('emoji');
    expect(body.display).toHaveProperty('starsDisplay');
    expect(body.display).toHaveProperty('text');

    // Default rank 15 display
    expect(body.display.label).toBe('15');
    expect(body.display.starsDisplay).toBe('☆☆☆');
  });
});

test.describe('GET /api/rankings', () => {
  test('returns ladder and legend arrays', async ({ request }) => {
    const res = await request.get('/api/rankings');
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty('ladder');
    expect(body).toHaveProperty('legend');
    expect(Array.isArray(body.ladder)).toBe(true);
    expect(Array.isArray(body.legend)).toBe(true);
  });

  test('ladder entries have expected shape', async ({ request }) => {
    await resetDb(request);
    const user = await registerUser(request, 'ladderuser', 'ladderuser@example.com', 'Secure#Pass1');
    await activateUser(request, user.username);

    const res = await request.get('/api/rankings');
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.ladder.length).toBeGreaterThan(0);
    const entry = body.ladder[0];

    expect(entry).toHaveProperty('id');
    expect(entry).toHaveProperty('username');
    expect(entry).toHaveProperty('rank');
    expect(entry).toHaveProperty('stars');
    expect(entry).toHaveProperty('duelsWon');
    expect(entry).toHaveProperty('duelsLost');
    expect(entry).toHaveProperty('display');
    expect(entry.display).toHaveProperty('text');
  });

  test('legend list is empty when no legend players exist', async ({ request }) => {
    await resetDb(request);
    const res = await request.get('/api/rankings');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.legend).toEqual([]);
  });
});

/**
 * Rank UI smoke tests — verify rank elements appear on pages.
 */

const UI_TIMEOUT = 10_000;

test.describe('Rank UI — garage page', () => {
  test('rank badge element exists in profile card as guest', async ({ page }) => {
    await page.route('/api/auth/me', (route) =>
      route.fulfill({ json: { user: null } }),
    );
    await page.goto('/garage?forceFallback=1');
    const badge = page.locator('#profile-rank-badge');
    await expect(badge).toBeAttached({ timeout: UI_TIMEOUT });
  });

  test('rank badge shows live data for authenticated user', async ({ page }) => {
    await page.route('/api/auth/me', (route) =>
      route.fulfill({ json: { user: { id: 1, username: 'tester', status: 'active' } } }),
    );
    await page.route('/api/profile/rank', (route) =>
      route.fulfill({
        json: {
          rank: 15, stars: 0, isLegend: false, legendPosition: null,
          duelsWon: 0, duelsLost: 0,
          display: { label: '15', emoji: '🛻', starsDisplay: '☆☆☆', text: '🛻 15 ☆☆☆' },
        },
      }),
    );
    await page.goto('/garage?forceFallback=1');
    const badge = page.locator('#profile-rank-badge');
    await expect(badge).toBeAttached({ timeout: UI_TIMEOUT });
    await expect(badge).toContainText('15', { timeout: UI_TIMEOUT });
  });

  test('ratings tab shows rankings container', async ({ page }) => {
    await page.route('/api/rankings', (route) =>
      route.fulfill({ json: { ladder: [], legend: [] } }),
    );
    await page.goto('/garage?forceFallback=1');
    await page.locator('.tab-btn[data-tab="ratings"]').click();
    const container = page.locator('#rankings-container');
    await expect(container).toBeVisible({ timeout: UI_TIMEOUT });
  });

  test('ratings tab renders legend section heading', async ({ page }) => {
    await page.route('/api/rankings', (route) =>
      route.fulfill({ json: { ladder: [], legend: [] } }),
    );
    await page.goto('/garage?forceFallback=1');
    await page.locator('.tab-btn[data-tab="ratings"]').click();
    const container = page.locator('#rankings-container');
    await expect(container).toContainText('Легенды', { timeout: UI_TIMEOUT });
  });
});

test.describe('Rank UI — profile page', () => {
  test('rank section is hidden when API fails', async ({ page }) => {
    await page.route('/api/profile', (route) => route.abort());
    await page.route('/api/profile/rank', (route) => route.abort());
    await page.goto('/profile');
    const section = page.locator('#rank-section');
    // Section starts hidden and stays hidden on error
    await expect(section).toBeHidden({ timeout: UI_TIMEOUT });
  });

  test('rank section appears with live rank data', async ({ page }) => {
    await page.route('/api/profile', (route) =>
      route.fulfill({
        json: {
          user: { id: 1, username: 'tester', email: 'tester@example.com', created_at: '2024-01-01', status: 'active', avatar_path: null },
          stats: { totalSessions: 0, totalRaces: 0, totalLaps: 0, totalTimeSec: 0, bestLap: null, recentLaps: [] },
        },
      }),
    );
    await page.route('/api/profile/rank', (route) =>
      route.fulfill({
        json: {
          rank: 15, stars: 0, isLegend: false, legendPosition: null,
          duelsWon: 0, duelsLost: 0,
          display: { label: '15', emoji: '🛻', starsDisplay: '☆☆☆', text: '🛻 15 ☆☆☆' },
        },
      }),
    );
    await page.goto('/profile');
    const section = page.locator('#rank-section');
    await expect(section).toBeVisible({ timeout: UI_TIMEOUT });
    await expect(section).toContainText('Ранг 15', { timeout: UI_TIMEOUT });
  });
});
