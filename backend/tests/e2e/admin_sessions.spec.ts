import { test, expect } from '@playwright/test';
import path from 'path';

const TEST_BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:5000';

/**
 * PR 6 — Admin sessions dashboard API and UI e2e tests.
 *
 * Covers:
 *  - GET /api/admin/sessions: admin/moderator can fetch; unauthorized users blocked
 *  - Filters: user_id, car_id, date_from, date_to
 *  - Pagination
 *  - Validation: invalid params return 400
 *  - GET /api/admin/sessions/active: returns live sessions
 *  - GET /api/admin/sessions/:id: returns session details
 *  - UI: admin/moderator can open dashboard
 *  - UI: completed tab renders rows
 *  - UI: filters narrow results
 *  - UI: summary stats render
 *  - UI: active tab renders / empty state
 *  - UI: admin landing page shows Sessions card for allowed roles
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

async function insertRentalSession(
  page: import('@playwright/test').Page,
  userId: number,
  carId: number,
  durationSeconds: number,
  cost: number,
  carName?: string,
): Promise<{ id: number }> {
  const res = await page.request.post('/api/dev/rental-sessions/insert', {
    data: { user_id: userId, car_id: carId, car_name: carName || ('Car #' + carId), duration_seconds: durationSeconds, cost },
  });
  expect(res.status(), `insert session failed: ${await res.text()}`).toBe(200);
  const body = await res.json();
  return body.session;
}

// ---------------------------------------------------------------------------
// API Tests: GET /api/admin/sessions
// ---------------------------------------------------------------------------

test.describe('GET /api/admin/sessions', () => {
  test('admin can fetch completed sessions', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'sessadmin1', 'sessadmin1@test.com');
    await activateUser(page, 'sessadmin1');
    await setUserRole(page, 'sessadmin1', 'admin');
    await loginUser(page, 'sessadmin1');

    const res = await page.request.get('/api/admin/sessions');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('items');
    expect(body).toHaveProperty('pagination');
    expect(body).toHaveProperty('summary');
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.pagination).toHaveProperty('page', 1);
    expect(body.pagination).toHaveProperty('limit', 50);
    expect(typeof body.pagination.total).toBe('number');
    expect(typeof body.pagination.pages).toBe('number');
    expect(typeof body.summary.totalSessions).toBe('number');
    expect(typeof body.summary.totalRevenue).toBe('number');
  });

  test('moderator can fetch completed sessions', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'sessmod1', 'sessmod1@test.com');
    await activateUser(page, 'sessmod1');
    await setUserRole(page, 'sessmod1', 'moderator');
    await loginUser(page, 'sessmod1');

    const res = await page.request.get('/api/admin/sessions');
    expect(res.status()).toBe(200);
  });

  test('plain user cannot fetch sessions (403)', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'sessuser1', 'sessuser1@test.com');
    await activateUser(page, 'sessuser1');
    await loginUser(page, 'sessuser1');

    const res = await page.request.get('/api/admin/sessions');
    expect(res.status()).toBe(403);
  });

  test('unauthenticated user cannot fetch sessions (401)', async ({ page }) => {
    await resetDb(page);
    const res = await page.request.get('/api/admin/sessions');
    expect(res.status()).toBe(401);
  });

  test('filter by car_id works', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'sessadmin2', 'sessadmin2@test.com');
    await activateUser(page, 'sessadmin2');
    await setUserRole(page, 'sessadmin2', 'admin');
    await loginUser(page, 'sessadmin2');

    await insertRentalSession(page, user.id, 1, 120, 20.0, 'Car One');
    await insertRentalSession(page, user.id, 2, 180, 30.0, 'Car Two');

    const res = await page.request.get('/api/admin/sessions?car_id=1');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    body.items.forEach((item: { car_id: number }) => {
      expect(item.car_id).toBe(1);
    });
  });

  test('filter by user_id works', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'sessadmin3', 'sessadmin3@test.com');
    const other = await registerUser(page, 'sessother3', 'sessother3@test.com');
    await activateUser(page, 'sessadmin3');
    await activateUser(page, 'sessother3');
    await setUserRole(page, 'sessadmin3', 'admin');
    await loginUser(page, 'sessadmin3');

    await insertRentalSession(page, admin.id, 1, 60, 10.0);
    await insertRentalSession(page, other.id, 2, 60, 10.0);

    const res = await page.request.get('/api/admin/sessions?user_id=' + admin.id);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    body.items.forEach((item: { user_id: number }) => {
      expect(item.user_id).toBe(admin.id);
    });
  });

  test('pagination works', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'sessadmin4', 'sessadmin4@test.com');
    await activateUser(page, 'sessadmin4');
    await setUserRole(page, 'sessadmin4', 'admin');
    await loginUser(page, 'sessadmin4');

    // Insert 3 sessions
    for (let i = 0; i < 3; i++) {
      await insertRentalSession(page, user.id, 1, 60 + i, 10.0 + i);
    }

    const res = await page.request.get('/api/admin/sessions?page=1&limit=2');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeLessThanOrEqual(2);
    expect(body.pagination.limit).toBe(2);
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.total).toBeGreaterThanOrEqual(3);
    expect(body.pagination.pages).toBeGreaterThanOrEqual(2);
  });

  test('invalid page returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'sessadmin5', 'sessadmin5@test.com');
    await activateUser(page, 'sessadmin5');
    await setUserRole(page, 'sessadmin5', 'admin');
    await loginUser(page, 'sessadmin5');

    const res = await page.request.get('/api/admin/sessions?page=0');
    expect(res.status()).toBe(400);
  });

  test('invalid limit returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'sessadmin6', 'sessadmin6@test.com');
    await activateUser(page, 'sessadmin6');
    await setUserRole(page, 'sessadmin6', 'admin');
    await loginUser(page, 'sessadmin6');

    const res1 = await page.request.get('/api/admin/sessions?limit=200');
    expect(res1.status()).toBe(400);

    const res2 = await page.request.get('/api/admin/sessions?limit=0');
    expect(res2.status()).toBe(400);
  });

  test('invalid date_from format returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'sessadmin7', 'sessadmin7@test.com');
    await activateUser(page, 'sessadmin7');
    await setUserRole(page, 'sessadmin7', 'admin');
    await loginUser(page, 'sessadmin7');

    const res = await page.request.get('/api/admin/sessions?date_from=29-03-2026');
    expect(res.status()).toBe(400);
  });

  test('invalid date_to format returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'sessadmin8', 'sessadmin8@test.com');
    await activateUser(page, 'sessadmin8');
    await setUserRole(page, 'sessadmin8', 'admin');
    await loginUser(page, 'sessadmin8');

    const res = await page.request.get('/api/admin/sessions?date_to=2026/03/29');
    expect(res.status()).toBe(400);
  });

  test('invalid user_id returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'sessadmin9', 'sessadmin9@test.com');
    await activateUser(page, 'sessadmin9');
    await setUserRole(page, 'sessadmin9', 'admin');
    await loginUser(page, 'sessadmin9');

    const res = await page.request.get('/api/admin/sessions?user_id=abc');
    expect(res.status()).toBe(400);
  });

  test('summary stats are returned', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'sessadmin10', 'sessadmin10@test.com');
    await activateUser(page, 'sessadmin10');
    await setUserRole(page, 'sessadmin10', 'admin');
    await loginUser(page, 'sessadmin10');

    await insertRentalSession(page, user.id, 1, 120, 20.0);
    await insertRentalSession(page, user.id, 2, 60, 10.0);

    const res = await page.request.get('/api/admin/sessions');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.summary.totalSessions).toBeGreaterThanOrEqual(2);
    expect(body.summary.totalRevenue).toBeGreaterThanOrEqual(30);
    expect(body.summary.avgDurationSeconds).toBeGreaterThan(0);
    expect(body.summary.avgCost).toBeGreaterThan(0);
  });

  test('response includes username via LEFT JOIN', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'sessadmin11', 'sessadmin11@test.com');
    await activateUser(page, 'sessadmin11');
    await setUserRole(page, 'sessadmin11', 'admin');
    await loginUser(page, 'sessadmin11');

    await insertRentalSession(page, user.id, 1, 90, 15.0);

    const res = await page.request.get('/api/admin/sessions?user_id=' + user.id);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0]).toHaveProperty('username', 'sessadmin11');
  });
});

// ---------------------------------------------------------------------------
// API Tests: GET /api/admin/sessions/active
// ---------------------------------------------------------------------------

test.describe('GET /api/admin/sessions/active', () => {
  test('admin can fetch active sessions', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'actadmin1', 'actadmin1@test.com');
    await activateUser(page, 'actadmin1');
    await setUserRole(page, 'actadmin1', 'admin');
    await loginUser(page, 'actadmin1');

    const res = await page.request.get('/api/admin/sessions/active');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('items');
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.count).toBe('number');
  });

  test('moderator can fetch active sessions', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'actmod1', 'actmod1@test.com');
    await activateUser(page, 'actmod1');
    await setUserRole(page, 'actmod1', 'moderator');
    await loginUser(page, 'actmod1');

    const res = await page.request.get('/api/admin/sessions/active');
    expect(res.status()).toBe(200);
  });

  test('unauthenticated user cannot fetch active sessions', async ({ page }) => {
    await resetDb(page);
    const res = await page.request.get('/api/admin/sessions/active');
    expect(res.status()).toBe(401);
  });

  test('active sessions response does not expose socketId', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'actadmin2', 'actadmin2@test.com');
    await activateUser(page, 'actadmin2');
    await setUserRole(page, 'actadmin2', 'admin');
    await loginUser(page, 'actadmin2');

    const res = await page.request.get('/api/admin/sessions/active');
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Even if there are active sessions, socketId must not appear
    body.items.forEach((item: Record<string, unknown>) => {
      expect(item).not.toHaveProperty('socketId');
    });
  });
});

// ---------------------------------------------------------------------------
// API Tests: GET /api/admin/sessions/:id
// ---------------------------------------------------------------------------

test.describe('GET /api/admin/sessions/:id', () => {
  test('admin can fetch session details', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'detailadmin1', 'detailadmin1@test.com');
    await activateUser(page, 'detailadmin1');
    await setUserRole(page, 'detailadmin1', 'admin');
    await loginUser(page, 'detailadmin1');

    const session = await insertRentalSession(page, user.id, 1, 150, 25.0, 'Car One');

    const res = await page.request.get('/api/admin/sessions/' + session.id);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('session');
    expect(body.session).toHaveProperty('id', session.id);
    expect(body.session).toHaveProperty('user_id', user.id);
    expect(body.session).toHaveProperty('car_id', 1);
    expect(body.session).toHaveProperty('duration_seconds', 150);
    expect(body).toHaveProperty('transactions');
    expect(Array.isArray(body.transactions)).toBe(true);
  });

  test('404 for non-existent session', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'detailadmin2', 'detailadmin2@test.com');
    await activateUser(page, 'detailadmin2');
    await setUserRole(page, 'detailadmin2', 'admin');
    await loginUser(page, 'detailadmin2');

    const res = await page.request.get('/api/admin/sessions/99999');
    expect(res.status()).toBe(404);
  });

  test('invalid id returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'detailadmin3', 'detailadmin3@test.com');
    await activateUser(page, 'detailadmin3');
    await setUserRole(page, 'detailadmin3', 'admin');
    await loginUser(page, 'detailadmin3');

    const res = await page.request.get('/api/admin/sessions/abc');
    expect(res.status()).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// UI Tests
// ---------------------------------------------------------------------------

test('admin can open sessions dashboard', async ({ page }) => {
  await resetDb(page);
  await registerUser(page, 'uiadmin1', 'uiadmin1@test.com');
  await activateUser(page, 'uiadmin1');
  await setUserRole(page, 'uiadmin1', 'admin');
  await loginUser(page, 'uiadmin1');

  await page.goto(TEST_BASE_URL + '/admin-sessions');
  await expect(page.locator('#admin-content')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#sessions-table')).toBeAttached();
});

test('moderator can open sessions dashboard', async ({ page }) => {
  await resetDb(page);
  await registerUser(page, 'uimod1', 'uimod1@test.com');
  await activateUser(page, 'uimod1');
  await setUserRole(page, 'uimod1', 'moderator');
  await loginUser(page, 'uimod1');

  await page.goto(TEST_BASE_URL + '/admin-sessions');
  await expect(page.locator('#admin-content')).toBeVisible({ timeout: 8000 });
});

test('plain user is redirected from sessions dashboard', async ({ page }) => {
  await resetDb(page);
  await registerUser(page, 'uiplain1', 'uiplain1@test.com');
  await activateUser(page, 'uiplain1');
  await loginUser(page, 'uiplain1');

  await page.goto(TEST_BASE_URL + '/admin-sessions');
  await expect(page).toHaveURL(/garage/, { timeout: 8000 });
});

test('completed tab renders session rows', async ({ page }) => {
  await resetDb(page);
  const user = await registerUser(page, 'uiadmin2', 'uiadmin2@test.com');
  await activateUser(page, 'uiadmin2');
  await setUserRole(page, 'uiadmin2', 'admin');
  await loginUser(page, 'uiadmin2');

  await insertRentalSession(page, user.id, 1, 120, 20.0, 'Riley-X1 · Алый');

  await page.goto(TEST_BASE_URL + '/admin-sessions');
  await expect(page.locator('#admin-content')).toBeVisible({ timeout: 8000 });

  // Table should have at least one row
  await expect(page.locator('#sessions-tbody tr')).toHaveCount(1, { timeout: 8000 });
  const firstRow = page.locator('#sessions-tbody tr').first();
  await expect(firstRow).toContainText('Riley-X1 · Алый');
});

test('summary stats render', async ({ page }) => {
  await resetDb(page);
  const user = await registerUser(page, 'uiadmin3', 'uiadmin3@test.com');
  await activateUser(page, 'uiadmin3');
  await setUserRole(page, 'uiadmin3', 'admin');
  await loginUser(page, 'uiadmin3');

  await insertRentalSession(page, user.id, 1, 120, 20.0);

  await page.goto(TEST_BASE_URL + '/admin-sessions');
  await expect(page.locator('#admin-content')).toBeVisible({ timeout: 8000 });
  // Wait for data to load
  await expect(page.locator('#sessions-tbody tr')).toHaveCount(1, { timeout: 8000 });

  // Summary grid should be visible
  await expect(page.locator('#summary-grid')).toBeVisible({ timeout: 4000 });
  const totalText = await page.locator('#summary-total').textContent();
  expect(Number(totalText)).toBeGreaterThanOrEqual(1);
});

test('car filter dropdown is populated', async ({ page }) => {
  await resetDb(page);
  await registerUser(page, 'uiadmin4', 'uiadmin4@test.com');
  await activateUser(page, 'uiadmin4');
  await setUserRole(page, 'uiadmin4', 'admin');
  await loginUser(page, 'uiadmin4');

  await page.goto(TEST_BASE_URL + '/admin-sessions');
  await expect(page.locator('#admin-content')).toBeVisible({ timeout: 8000 });

  // Car filter should have at least some options loaded from /api/cars
  const optionCount = await page.locator('#f-car-id option').count();
  expect(optionCount).toBeGreaterThan(1); // "— Все —" plus at least one car
});

test('active tab shows empty state when no active sessions', async ({ page }) => {
  await resetDb(page);
  await registerUser(page, 'uiadmin5', 'uiadmin5@test.com');
  await activateUser(page, 'uiadmin5');
  await setUserRole(page, 'uiadmin5', 'admin');
  await loginUser(page, 'uiadmin5');

  await page.goto(TEST_BASE_URL + '/admin-sessions');
  await expect(page.locator('#admin-content')).toBeVisible({ timeout: 8000 });

  // Switch to active tab
  await page.locator('#tab-active').click();
  await expect(page.locator('#panel-active')).toBeVisible({ timeout: 4000 });

  // Should show empty state since no active sessions
  await expect(page.locator('#active-state-empty')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#active-state-empty')).toContainText('Сейчас никто не катается');
});

test('filters work and narrow results', async ({ page }) => {
  await resetDb(page);
  const user = await registerUser(page, 'uiadmin6', 'uiadmin6@test.com');
  await activateUser(page, 'uiadmin6');
  await setUserRole(page, 'uiadmin6', 'admin');
  await loginUser(page, 'uiadmin6');

  // Insert sessions for car 1 and car 2
  await insertRentalSession(page, user.id, 1, 60, 10.0, 'Riley-X1 · Алый');
  await insertRentalSession(page, user.id, 2, 90, 15.0, 'Riley-X1 · Синий');

  // Navigate with car_id=1 filter in URL
  await page.goto(TEST_BASE_URL + '/admin-sessions?car_id=1');
  await expect(page.locator('#admin-content')).toBeVisible({ timeout: 8000 });
  // Wait for table
  await expect(page.locator('#sessions-tbody tr')).toHaveCount(1, { timeout: 8000 });
  // Verify car filter is hydrated from URL
  await expect(page.locator('#f-car-id')).toHaveValue('1');
  // All rows should show car 1
  await expect(page.locator('#sessions-tbody tr').first()).toContainText('Riley-X1 · Алый');
});

test('admin landing page shows Sessions card for admin', async ({ page }) => {
  await resetDb(page);
  await registerUser(page, 'landingadmin1', 'landingadmin1@test.com');
  await activateUser(page, 'landingadmin1');
  await setUserRole(page, 'landingadmin1', 'admin');
  await loginUser(page, 'landingadmin1');

  await page.goto(TEST_BASE_URL + '/admin');
  await expect(page.locator('#admin-content')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#card-sessions')).toBeVisible({ timeout: 4000 });
});

test('admin landing page shows Sessions card for moderator', async ({ page }) => {
  await resetDb(page);
  await registerUser(page, 'landingmod2', 'landingmod2@test.com');
  await activateUser(page, 'landingmod2');
  await setUserRole(page, 'landingmod2', 'moderator');
  await loginUser(page, 'landingmod2');

  await page.goto(TEST_BASE_URL + '/admin');
  await expect(page.locator('#admin-content')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#card-sessions')).toBeVisible({ timeout: 4000 });
});
