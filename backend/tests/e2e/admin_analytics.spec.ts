import { test, expect } from '@playwright/test';

const TEST_BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:5000';

/**
 * PR 8 — Admin analytics dashboard API and UI e2e tests.
 *
 * Covers:
 *  - GET /api/admin/analytics/overview: admin can fetch; moderator/unauthenticated blocked
 *  - GET /api/admin/analytics/timeseries: admin can fetch; moderator/unauthenticated blocked
 *  - Period presets: 7d, 30d, 90d, all
 *  - Custom date range
 *  - Invalid period / invalid dates return 400
 *  - Overview returns correct shape with seeded data
 *  - Timeseries returns correct shape
 *  - KPI values match seeded data
 *  - byCarId matches seeded sessions
 *  - topUsersBySpend is ordered correctly
 *  - Empty DB / empty range returns zeros and empty arrays
 *  - UI: admin can open analytics page
 *  - UI: moderator is redirected/blocked
 *  - UI: KPI cards render
 *  - UI: period selector updates data
 *  - UI: bar rows render
 *  - UI: admin landing page shows Analytics card only for admin
 */

// ---------------------------------------------------------------------------
// Helpers
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
  password = 'Secure#Pass1',
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
  const res = await page.request.post('/api/dev/activate-user', { data: { username } });
  expect(res.status(), `activate failed: ${await res.text()}`).toBe(200);
}

async function loginUser(
  page: import('@playwright/test').Page,
  identifier: string,
  password = 'Secure#Pass1',
): Promise<void> {
  const csrfToken = await getCsrfToken(page);
  const res = await page.request.post('/api/auth/login', {
    data: { identifier, password },
    headers: { 'X-CSRF-Token': csrfToken },
  });
  expect(res.status(), `login failed: ${await res.text()}`).toBe(200);
}

async function setUserRole(
  page: import('@playwright/test').Page,
  username: string,
  role: 'user' | 'moderator' | 'admin',
): Promise<void> {
  const res = await page.request.post('/api/dev/set-user-role', { data: { username, role } });
  expect(res.status(), `set-user-role failed: ${await res.text()}`).toBe(200);
}

async function insertSession(
  page: import('@playwright/test').Page,
  userId: number,
  carId: number,
  durationSeconds: number,
  cost: number,
  carName?: string,
): Promise<{ id: number }> {
  const res = await page.request.post('/api/dev/rental-sessions/insert', {
    data: { user_id: userId, car_id: carId, duration_seconds: durationSeconds, cost, car_name: carName },
  });
  expect(res.status(), `insert session failed: ${await res.text()}`).toBe(200);
  const body = await res.json();
  return body.session;
}

async function insertTransaction(
  page: import('@playwright/test').Page,
  userId: number,
  type: string,
  amount: number,
  balanceAfter: number,
): Promise<{ id: number }> {
  const res = await page.request.post('/api/dev/transactions/insert', {
    data: { user_id: userId, type, amount, balance_after: balanceAfter },
  });
  expect(res.status(), `insert transaction failed: ${await res.text()}`).toBe(200);
  const body = await res.json();
  return body.transaction;
}

// ---------------------------------------------------------------------------
// API Tests: GET /api/admin/analytics/overview
// ---------------------------------------------------------------------------

test.describe('GET /api/admin/analytics/overview', () => {
  test('admin can fetch overview', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'ana_admin1', 'ana_admin1@test.com');
    await activateUser(page, 'ana_admin1');
    await setUserRole(page, 'ana_admin1', 'admin');
    await loginUser(page, 'ana_admin1');

    const res = await page.request.get('/api/admin/analytics/overview');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('period');
    expect(body).toHaveProperty('kpi');
    expect(body).toHaveProperty('byTransactionType');
    expect(body).toHaveProperty('byCarId');
    expect(body).toHaveProperty('topUsersBySpend');
    expect(typeof body.kpi.totalUsers).toBe('number');
    expect(typeof body.kpi.totalSessions).toBe('number');
    expect(typeof body.kpi.totalRevenue).toBe('number');
    expect(typeof body.kpi.avgSessionDuration).toBe('number');
    expect(typeof body.kpi.avgSessionCost).toBe('number');
    expect(Array.isArray(body.byTransactionType)).toBe(true);
    expect(Array.isArray(body.byCarId)).toBe(true);
    expect(Array.isArray(body.topUsersBySpend)).toBe(true);
  });

  test('moderator gets 403 on overview', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'ana_mod1', 'ana_mod1@test.com');
    await activateUser(page, 'ana_mod1');
    await setUserRole(page, 'ana_mod1', 'moderator');
    await loginUser(page, 'ana_mod1');

    const res = await page.request.get('/api/admin/analytics/overview');
    expect(res.status()).toBe(403);
  });

  test('unauthenticated gets 401 on overview', async ({ page }) => {
    await resetDb(page);
    const res = await page.request.get('/api/admin/analytics/overview');
    expect(res.status()).toBe(401);
  });

  test('period=7d works', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'ana_admin2', 'ana_admin2@test.com');
    await activateUser(page, 'ana_admin2');
    await setUserRole(page, 'ana_admin2', 'admin');
    await loginUser(page, 'ana_admin2');

    const res = await page.request.get('/api/admin/analytics/overview?period=7d');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.period).toHaveProperty('from');
    expect(body.period).toHaveProperty('to');
  });

  test('period=30d works', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'ana_admin3', 'ana_admin3@test.com');
    await activateUser(page, 'ana_admin3');
    await setUserRole(page, 'ana_admin3', 'admin');
    await loginUser(page, 'ana_admin3');

    const res = await page.request.get('/api/admin/analytics/overview?period=30d');
    expect(res.status()).toBe(200);
  });

  test('period=90d works', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'ana_admin4', 'ana_admin4@test.com');
    await activateUser(page, 'ana_admin4');
    await setUserRole(page, 'ana_admin4', 'admin');
    await loginUser(page, 'ana_admin4');

    const res = await page.request.get('/api/admin/analytics/overview?period=90d');
    expect(res.status()).toBe(200);
  });

  test('period=all works', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'ana_admin5', 'ana_admin5@test.com');
    await activateUser(page, 'ana_admin5');
    await setUserRole(page, 'ana_admin5', 'admin');
    await loginUser(page, 'ana_admin5');

    const res = await page.request.get('/api/admin/analytics/overview?period=all');
    expect(res.status()).toBe(200);
  });

  test('invalid period returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'ana_admin6', 'ana_admin6@test.com');
    await activateUser(page, 'ana_admin6');
    await setUserRole(page, 'ana_admin6', 'admin');
    await loginUser(page, 'ana_admin6');

    const res = await page.request.get('/api/admin/analytics/overview?period=badperiod');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  test('custom date range works', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'ana_admin7', 'ana_admin7@test.com');
    await activateUser(page, 'ana_admin7');
    await setUserRole(page, 'ana_admin7', 'admin');
    await loginUser(page, 'ana_admin7');

    const today = new Date().toISOString().slice(0, 10);
    const res = await page.request.get(`/api/admin/analytics/overview?date_from=2026-01-01&date_to=${today}`);
    expect(res.status()).toBe(200);
  });

  test('invalid date_from returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'ana_admin8', 'ana_admin8@test.com');
    await activateUser(page, 'ana_admin8');
    await setUserRole(page, 'ana_admin8', 'admin');
    await loginUser(page, 'ana_admin8');

    const res = await page.request.get('/api/admin/analytics/overview?date_from=not-a-date&date_to=2026-03-30');
    expect(res.status()).toBe(400);
  });

  test('invalid date_to returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'ana_admin9', 'ana_admin9@test.com');
    await activateUser(page, 'ana_admin9');
    await setUserRole(page, 'ana_admin9', 'admin');
    await loginUser(page, 'ana_admin9');

    const res = await page.request.get('/api/admin/analytics/overview?date_from=2026-01-01&date_to=notadate');
    expect(res.status()).toBe(400);
  });

  test('KPI values match seeded data', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'ana_kpi_admin', 'ana_kpi_admin@test.com');
    const user1 = await registerUser(page, 'ana_kpi_u1', 'ana_kpi_u1@test.com');
    const user2 = await registerUser(page, 'ana_kpi_u2', 'ana_kpi_u2@test.com');
    await activateUser(page, 'ana_kpi_admin');
    await activateUser(page, 'ana_kpi_u1');
    await activateUser(page, 'ana_kpi_u2');
    await setUserRole(page, 'ana_kpi_admin', 'admin');
    await loginUser(page, 'ana_kpi_admin');

    // Insert 2 sessions: cost 100 + 200 = 300 total, durations 60s + 120s
    await insertSession(page, user1.id, 1, 60, 100);
    await insertSession(page, user2.id, 1, 120, 200);

    const res = await page.request.get('/api/admin/analytics/overview?period=all');
    expect(res.status()).toBe(200);
    const body = await res.json();

    // 3 users total (admin + u1 + u2)
    expect(body.kpi.totalUsers).toBe(3);
    expect(body.kpi.totalSessions).toBe(2);
    expect(body.kpi.totalRevenue).toBe(300);
    expect(body.kpi.avgSessionDuration).toBe(90);
    expect(body.kpi.avgSessionCost).toBe(150);
  });

  test('byCarId matches seeded sessions', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'ana_car_admin', 'ana_car_admin@test.com');
    const user1 = await registerUser(page, 'ana_car_u1', 'ana_car_u1@test.com');
    await activateUser(page, 'ana_car_admin');
    await activateUser(page, 'ana_car_u1');
    await setUserRole(page, 'ana_car_admin', 'admin');
    await loginUser(page, 'ana_car_admin');

    await insertSession(page, user1.id, 1, 60, 50);
    await insertSession(page, user1.id, 1, 120, 100);
    await insertSession(page, user1.id, 2, 90, 75);

    const res = await page.request.get('/api/admin/analytics/overview?period=all');
    expect(res.status()).toBe(200);
    const body = await res.json();

    const car1 = body.byCarId.find((c: { car_id: number }) => c.car_id === 1);
    const car2 = body.byCarId.find((c: { car_id: number }) => c.car_id === 2);
    expect(car1).toBeTruthy();
    expect(car1.sessionCount).toBe(2);
    expect(car1.totalRevenue).toBe(150);
    expect(car2).toBeTruthy();
    expect(car2.sessionCount).toBe(1);
    expect(car2.totalRevenue).toBe(75);
  });

  test('topUsersBySpend is ordered descending', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'ana_top_admin', 'ana_top_admin@test.com');
    const user1 = await registerUser(page, 'ana_top_u1', 'ana_top_u1@test.com');
    const user2 = await registerUser(page, 'ana_top_u2', 'ana_top_u2@test.com');
    await activateUser(page, 'ana_top_admin');
    await activateUser(page, 'ana_top_u1');
    await activateUser(page, 'ana_top_u2');
    await setUserRole(page, 'ana_top_admin', 'admin');
    await loginUser(page, 'ana_top_admin');

    // user2 spends more
    await insertSession(page, user1.id, 1, 60, 50);
    await insertSession(page, user2.id, 1, 60, 200);

    const res = await page.request.get('/api/admin/analytics/overview?period=all');
    expect(res.status()).toBe(200);
    const body = await res.json();

    const topUsers = body.topUsersBySpend;
    expect(topUsers.length).toBeGreaterThanOrEqual(2);
    // First entry should have higher or equal spend
    expect(topUsers[0].totalSpend).toBeGreaterThanOrEqual(topUsers[1].totalSpend);
  });

  test('empty DB returns zeros and empty arrays', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'ana_empty_admin', 'ana_empty_admin@test.com');
    await activateUser(page, 'ana_empty_admin');
    await setUserRole(page, 'ana_empty_admin', 'admin');
    await loginUser(page, 'ana_empty_admin');

    const res = await page.request.get('/api/admin/analytics/overview?period=all');
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.kpi.totalSessions).toBe(0);
    expect(body.kpi.totalRevenue).toBe(0);
    expect(body.byCarId).toEqual([]);
    expect(body.topUsersBySpend).toEqual([]);
    expect(body.byTransactionType).toEqual([]);
  });

  test('empty date range returns zeros and empty arrays', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'ana_range_admin', 'ana_range_admin@test.com');
    const user1 = await registerUser(page, 'ana_range_u1', 'ana_range_u1@test.com');
    await activateUser(page, 'ana_range_admin');
    await activateUser(page, 'ana_range_u1');
    await setUserRole(page, 'ana_range_admin', 'admin');
    await loginUser(page, 'ana_range_admin');

    await insertSession(page, user1.id, 1, 60, 100);

    // Use a date range far in the past
    const res = await page.request.get('/api/admin/analytics/overview?date_from=2000-01-01&date_to=2000-01-02');
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.kpi.totalSessions).toBe(0);
    expect(body.kpi.totalRevenue).toBe(0);
    expect(body.byCarId).toEqual([]);
    expect(body.topUsersBySpend).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// API Tests: GET /api/admin/analytics/timeseries
// ---------------------------------------------------------------------------

test.describe('GET /api/admin/analytics/timeseries', () => {
  test('admin can fetch timeseries', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'ana_ts_admin1', 'ana_ts_admin1@test.com');
    await activateUser(page, 'ana_ts_admin1');
    await setUserRole(page, 'ana_ts_admin1', 'admin');
    await loginUser(page, 'ana_ts_admin1');

    const res = await page.request.get('/api/admin/analytics/timeseries');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('period');
    expect(body).toHaveProperty('days');
    expect(Array.isArray(body.days)).toBe(true);
  });

  test('moderator gets 403 on timeseries', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'ana_ts_mod1', 'ana_ts_mod1@test.com');
    await activateUser(page, 'ana_ts_mod1');
    await setUserRole(page, 'ana_ts_mod1', 'moderator');
    await loginUser(page, 'ana_ts_mod1');

    const res = await page.request.get('/api/admin/analytics/timeseries');
    expect(res.status()).toBe(403);
  });

  test('unauthenticated gets 401 on timeseries', async ({ page }) => {
    await resetDb(page);
    const res = await page.request.get('/api/admin/analytics/timeseries');
    expect(res.status()).toBe(401);
  });

  test('timeseries returns correct shape with seeded data', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'ana_ts_admin2', 'ana_ts_admin2@test.com');
    const user1 = await registerUser(page, 'ana_ts_u1', 'ana_ts_u1@test.com');
    await activateUser(page, 'ana_ts_admin2');
    await activateUser(page, 'ana_ts_u1');
    await setUserRole(page, 'ana_ts_admin2', 'admin');
    await loginUser(page, 'ana_ts_admin2');

    await insertSession(page, user1.id, 1, 60, 100);
    await insertTransaction(page, user1.id, 'topup', 500, 700);

    const res = await page.request.get('/api/admin/analytics/timeseries?period=all');
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.days.length).toBeGreaterThanOrEqual(1);
    const day = body.days[0];
    expect(day).toHaveProperty('date');
    expect(day).toHaveProperty('sessions');
    expect(day).toHaveProperty('revenue');
    expect(day).toHaveProperty('topups');
    expect(typeof day.date).toBe('string');
    expect(typeof day.sessions).toBe('number');
    expect(typeof day.revenue).toBe('number');
    expect(typeof day.topups).toBe('number');
  });

  test('timeseries days are ordered ascending', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'ana_ts_admin3', 'ana_ts_admin3@test.com');
    const user1 = await registerUser(page, 'ana_ts_u2', 'ana_ts_u2@test.com');
    await activateUser(page, 'ana_ts_admin3');
    await activateUser(page, 'ana_ts_u2');
    await setUserRole(page, 'ana_ts_admin3', 'admin');
    await loginUser(page, 'ana_ts_admin3');

    await insertSession(page, user1.id, 1, 60, 100);
    await insertSession(page, user1.id, 2, 120, 200);

    const res = await page.request.get('/api/admin/analytics/timeseries?period=all');
    expect(res.status()).toBe(200);
    const body = await res.json();

    if (body.days.length >= 2) {
      for (let i = 1; i < body.days.length; i++) {
        expect(body.days[i].date >= body.days[i - 1].date).toBe(true);
      }
    }
  });

  test('empty range returns empty days array', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'ana_ts_admin4', 'ana_ts_admin4@test.com');
    await activateUser(page, 'ana_ts_admin4');
    await setUserRole(page, 'ana_ts_admin4', 'admin');
    await loginUser(page, 'ana_ts_admin4');

    const res = await page.request.get('/api/admin/analytics/timeseries?date_from=2000-01-01&date_to=2000-01-02');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.days).toEqual([]);
    expect(body.period.from).toBe('2000-01-01');
  });

  test('invalid period returns 400 for timeseries', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'ana_ts_admin5', 'ana_ts_admin5@test.com');
    await activateUser(page, 'ana_ts_admin5');
    await setUserRole(page, 'ana_ts_admin5', 'admin');
    await loginUser(page, 'ana_ts_admin5');

    const res = await page.request.get('/api/admin/analytics/timeseries?period=invalid');
    expect(res.status()).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// UI Tests
// ---------------------------------------------------------------------------

test.describe('Analytics UI', () => {
  test('admin can open analytics page', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'ana_ui_admin1', 'ana_ui_admin1@test.com');
    await activateUser(page, 'ana_ui_admin1');
    await setUserRole(page, 'ana_ui_admin1', 'admin');
    await loginUser(page, 'ana_ui_admin1');

    await page.goto(TEST_BASE_URL + '/admin-analytics');
    await page.waitForSelector('#main-content:not([hidden])', { timeout: 10000 });
    const header = await page.textContent('h1');
    expect(header).toContain('Аналитика');
  });

  test('moderator is redirected away from analytics page', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'ana_ui_mod1', 'ana_ui_mod1@test.com');
    await activateUser(page, 'ana_ui_mod1');
    await setUserRole(page, 'ana_ui_mod1', 'moderator');
    await loginUser(page, 'ana_ui_mod1');

    await page.goto(TEST_BASE_URL + '/admin-analytics');
    // Should be redirected away (to login or admin or garage)
    await page.waitForTimeout(2000);
    expect(page.url()).not.toContain('/admin-analytics');
  });

  test('KPI cards render after load', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'ana_ui_admin2', 'ana_ui_admin2@test.com');
    const user1 = await registerUser(page, 'ana_ui_u1', 'ana_ui_u1@test.com');
    await activateUser(page, 'ana_ui_admin2');
    await activateUser(page, 'ana_ui_u1');
    await setUserRole(page, 'ana_ui_admin2', 'admin');
    await loginUser(page, 'ana_ui_admin2');

    await insertSession(page, user1.id, 1, 60, 100);

    await page.goto(TEST_BASE_URL + '/admin-analytics');
    await page.waitForSelector('#analytics-content:not([hidden])', { timeout: 10000 });

    const kpiCards = await page.$$('.kpi-card');
    expect(kpiCards.length).toBeGreaterThan(0);

    // Check at least one KPI label is visible
    const kpiText = await page.textContent('#kpi-grid');
    expect(kpiText).toBeTruthy();
  });

  test('period selector updates data', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'ana_ui_admin3', 'ana_ui_admin3@test.com');
    await activateUser(page, 'ana_ui_admin3');
    await setUserRole(page, 'ana_ui_admin3', 'admin');
    await loginUser(page, 'ana_ui_admin3');

    await page.goto(TEST_BASE_URL + '/admin-analytics');
    await page.waitForSelector('#main-content:not([hidden])', { timeout: 10000 });

    // Click the 7d preset
    await page.click('[data-preset="7d"]');
    await page.waitForTimeout(500);

    // URL should now contain period=7d
    expect(page.url()).toContain('period=7d');
    // Active button class
    const is7dActive = await page.$eval('[data-preset="7d"]', (el) => el.classList.contains('active'));
    expect(is7dActive).toBe(true);
  });

  test('bar rows render for cars section', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'ana_ui_admin4', 'ana_ui_admin4@test.com');
    const user1 = await registerUser(page, 'ana_ui_u2', 'ana_ui_u2@test.com');
    await activateUser(page, 'ana_ui_admin4');
    await activateUser(page, 'ana_ui_u2');
    await setUserRole(page, 'ana_ui_admin4', 'admin');
    await loginUser(page, 'ana_ui_admin4');

    await insertSession(page, user1.id, 1, 60, 100);
    await insertSession(page, user1.id, 2, 120, 200);

    await page.goto(TEST_BASE_URL + '/admin-analytics?period=all');
    await page.waitForSelector('#analytics-content:not([hidden])', { timeout: 10000 });

    const barRows = await page.$$('#cars-bar-list .bar-row');
    expect(barRows.length).toBeGreaterThan(0);
  });

  test('admin landing page shows Analytics card only for admin', async ({ page }) => {
    await resetDb(page);
    // Moderator: card should be hidden
    await registerUser(page, 'ana_ui_mod2', 'ana_ui_mod2@test.com');
    await activateUser(page, 'ana_ui_mod2');
    await setUserRole(page, 'ana_ui_mod2', 'moderator');
    await loginUser(page, 'ana_ui_mod2');

    await page.goto(TEST_BASE_URL + '/admin');
    await page.waitForSelector('#admin-content:not([hidden])', { timeout: 10000 });

    const analyticsCardHidden = await page.$eval('#card-analytics', (el) => (el as HTMLElement).hidden);
    expect(analyticsCardHidden).toBe(true);

    // Admin: card should be visible
    await registerUser(page, 'ana_ui_admin5', 'ana_ui_admin5@test.com');
    await activateUser(page, 'ana_ui_admin5');
    await setUserRole(page, 'ana_ui_admin5', 'admin');
    await loginUser(page, 'ana_ui_admin5');

    await page.goto(TEST_BASE_URL + '/admin');
    await page.waitForSelector('#admin-content:not([hidden])', { timeout: 10000 });

    const analyticsCardVisible = await page.$eval('#card-analytics', (el) => !(el as HTMLElement).hidden);
    expect(analyticsCardVisible).toBe(true);
  });
});
