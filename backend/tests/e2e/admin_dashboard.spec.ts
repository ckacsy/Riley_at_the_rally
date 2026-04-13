import { test, expect } from '@playwright/test';
import { resetDb, getCsrfToken, registerUser, activateUser, loginUser, setUserRole } from './helpers';

const TEST_BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:5000';

/**
 * PR 14 — Admin Operations Hub dashboard e2e tests.
 *
 * Covers:
 *  - GET /api/admin/dashboard: unauthenticated → 401
 *  - GET /api/admin/dashboard: regular user → 403
 *  - GET /api/admin/dashboard: moderator → 200, only activeSessions
 *  - GET /api/admin/dashboard: admin → 200, all sections present
 *  - Counts are correct: active sessions, orphaned holds, maintenance cars, banned users
 *  - Recent audit actions include only high-impact actions
 *  - Admin page UI renders Operations Hub widgets
 *  - Manual refresh button triggers reload
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setUserStatus(
  page: import('@playwright/test').Page,
  username: string,
  status: string,
): Promise<void> {
  const res = await page.request.post('/api/dev/set-user-status', { data: { username, status } });
  expect(res.status(), `set-user-status failed: ${await res.text()}`).toBe(200);
}

async function injectActiveSession(
  page: import('@playwright/test').Page,
  carId: number,
): Promise<{ sessionId: string }> {
  const res = await page.request.post('/api/dev/inject-active-session', { data: { carId } });
  expect(res.status(), `inject-active-session failed: ${await res.text()}`).toBe(200);
  const body = await res.json();
  return { sessionId: body.sessionId };
}

async function toggleMaintenance(
  page: import('@playwright/test').Page,
  carId: number,
  enabled: boolean,
  reason?: string,
): Promise<void> {
  const csrfToken = await getCsrfToken(page);
  const body: Record<string, unknown> = { enabled };
  if (reason !== undefined) body.reason = reason;
  const res = await page.request.post(`/api/admin/cars/${carId}/maintenance`, {
    data: body,
    headers: { 'X-CSRF-Token': csrfToken },
  });
  expect(res.status(), `toggleMaintenance failed: ${await res.text()}`).toBe(200);
}

async function writeAuditAction(
  page: import('@playwright/test').Page,
  action: string,
  targetType: string,
  targetId?: number,
): Promise<void> {
  const csrfToken = await getCsrfToken(page);
  const res = await page.request.post('/api/dev/admin-audit-log/write', {
    data: { action, targetType, targetId: targetId ?? null },
    headers: { 'X-CSRF-Token': csrfToken },
  });
  expect(res.status(), `writeAuditAction failed: ${await res.text()}`).toBe(200);
}

async function insertTransaction(
  page: import('@playwright/test').Page,
  data: {
    user_id: number;
    type: string;
    amount: number;
    balance_after: number;
    reference_id?: string;
    description?: string;
    created_at?: string;
  },
): Promise<{ id: number }> {
  const res = await page.request.post('/api/dev/transactions/insert', { data });
  expect(res.status(), `insertTransaction failed: ${await res.text()}`).toBe(200);
  const body = await res.json();
  return body.transaction;
}

// ---------------------------------------------------------------------------
// API tests: GET /api/admin/dashboard
// ---------------------------------------------------------------------------

test.describe('GET /api/admin/dashboard — access control', () => {
  test('unauthenticated user gets 401', async ({ page }) => {
    await resetDb(page);
    const res = await page.request.get('/api/admin/dashboard');
    expect(res.status()).toBe(401);
  });

  test('regular user gets 403', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'dashuser1', 'dashuser1@test.com');
    await activateUser(page, 'dashuser1');
    await loginUser(page, 'dashuser1');

    const res = await page.request.get('/api/admin/dashboard');
    expect(res.status()).toBe(403);
  });

  test('moderator gets 200 and sees only activeSessions', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'dashmod1', 'dashmod1@test.com');
    await activateUser(page, 'dashmod1');
    await setUserRole(page, 'dashmod1', 'moderator');
    await loginUser(page, 'dashmod1');

    const res = await page.request.get('/api/admin/dashboard');
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty('activeSessions');
    expect(typeof body.activeSessions.count).toBe('number');
    expect(Array.isArray(body.activeSessions.items)).toBe(true);

    // Admin-only sections must not be present
    expect(body).not.toHaveProperty('orphanedHolds');
    expect(body).not.toHaveProperty('maintenanceCars');
    expect(body).not.toHaveProperty('bannedUsers');
    expect(body).not.toHaveProperty('recentAuditActions');
  });

  test('admin gets 200 and sees all sections', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'dashadmin1', 'dashadmin1@test.com');
    await activateUser(page, 'dashadmin1');
    await setUserRole(page, 'dashadmin1', 'admin');
    await loginUser(page, 'dashadmin1');

    const res = await page.request.get('/api/admin/dashboard');
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty('activeSessions');
    expect(body).toHaveProperty('orphanedHolds');
    expect(body).toHaveProperty('maintenanceCars');
    expect(body).toHaveProperty('bannedUsers');
    expect(body).toHaveProperty('recentAuditActions');

    expect(typeof body.activeSessions.count).toBe('number');
    expect(Array.isArray(body.activeSessions.items)).toBe(true);
    expect(typeof body.orphanedHolds.count).toBe('number');
    expect(typeof body.maintenanceCars.count).toBe('number');
    expect(Array.isArray(body.maintenanceCars.items)).toBe(true);
    expect(typeof body.bannedUsers.count).toBe('number');
    expect(Array.isArray(body.recentAuditActions)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// API tests: counts are correct
// ---------------------------------------------------------------------------

test.describe('GET /api/admin/dashboard — counts', () => {
  test('active sessions count reflects injected sessions', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'dashcount1', 'dashcount1@test.com');
    await activateUser(page, 'dashcount1');
    await setUserRole(page, 'dashcount1', 'admin');
    await loginUser(page, 'dashcount1');

    // Baseline — no active sessions
    const res1 = await page.request.get('/api/admin/dashboard');
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    const before = body1.activeSessions.count as number;

    // Inject one session
    await injectActiveSession(page, 1);

    const res2 = await page.request.get('/api/admin/dashboard');
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();
    expect(body2.activeSessions.count).toBe(before + 1);

    // Preview items include required fields
    const items = body2.activeSessions.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    const item = items[0];
    expect(item).toHaveProperty('carId');
    expect(item).toHaveProperty('carName');
    expect(item).toHaveProperty('startedAt');
  });

  test('maintenance cars count reflects enabled maintenance', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'dashmc1', 'dashmc1@test.com');
    await activateUser(page, 'dashmc1');
    await setUserRole(page, 'dashmc1', 'admin');
    await loginUser(page, 'dashmc1');

    const res1 = await page.request.get('/api/admin/dashboard');
    const body1 = await res1.json();
    const before = body1.maintenanceCars.count as number;

    // Enable maintenance for car 2
    await toggleMaintenance(page, 2, true, 'Тест обслуживания');

    const res2 = await page.request.get('/api/admin/dashboard');
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();
    expect(body2.maintenanceCars.count).toBe(before + 1);

    const items = body2.maintenanceCars.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    const item = items[0];
    expect(item).toHaveProperty('carId');
    expect(item).toHaveProperty('carName');
    expect(item).toHaveProperty('reason');
  });

  test('banned users count reflects bans', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'dashban1', 'dashban1@test.com');
    await activateUser(page, 'dashban1');
    await registerUser(page, 'dashadmin2', 'dashadmin2@test.com');
    await activateUser(page, 'dashadmin2');
    await setUserRole(page, 'dashadmin2', 'admin');
    await loginUser(page, 'dashadmin2');

    const res1 = await page.request.get('/api/admin/dashboard');
    const body1 = await res1.json();
    const before = body1.bannedUsers.count as number;

    // Ban the user via dev helper
    await setUserStatus(page, 'dashban1', 'banned');

    const res2 = await page.request.get('/api/admin/dashboard');
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();
    expect(body2.bannedUsers.count).toBe(before + 1);
  });

  test('orphaned holds count reflects hold older than grace period with no matching deduct', async ({ page }) => {
    await resetDb(page);

    // Create a regular user whose id will be used for the transaction
    const user = await registerUser(page, 'dashorph1', 'dashorph1@test.com');
    await activateUser(page, 'dashorph1');

    // Create admin and log in to call the dashboard
    await registerUser(page, 'dashadmin3', 'dashadmin3@test.com');
    await activateUser(page, 'dashadmin3');
    await setUserRole(page, 'dashadmin3', 'admin');
    await loginUser(page, 'dashadmin3');

    // Baseline — no orphaned holds yet
    const res1 = await page.request.get('/api/admin/dashboard');
    expect(res1.status()).toBe(200);
    const body1 = await res1.json();
    const before = body1.orphanedHolds.count as number;

    // Insert a hold transaction:
    //  - unique reference_id (no matching deduct transaction will exist)
    //  - created_at set 15 minutes in the past (well beyond the 10-min grace period)
    const refId = `test-orphan-${Date.now()}`;
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    await insertTransaction(page, {
      user_id: user.id,
      type: 'hold',
      amount: -50,
      balance_after: 150,
      reference_id: refId,
      description: 'orphaned hold test',
      created_at: fifteenMinutesAgo,
    });

    // Dashboard should now report one more orphaned hold
    const res2 = await page.request.get('/api/admin/dashboard');
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();
    expect(body2.orphanedHolds.count).toBe(before + 1);
    expect(body2.orphanedHolds.count).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// API tests: recent audit actions
// ---------------------------------------------------------------------------

test.describe('GET /api/admin/dashboard — recentAuditActions', () => {
  test('returns only high-impact audit actions', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'dashaudit1', 'dashaudit1@test.com');
    await activateUser(page, 'dashaudit1');
    await setUserRole(page, 'dashaudit1', 'admin');
    await loginUser(page, 'dashaudit1');

    // Write a high-impact action
    await writeAuditAction(page, 'ban_user', 'user');

    // Write a low-signal action (edit_news is NOT in whitelist)
    await writeAuditAction(page, 'edit_news', 'news');

    const res = await page.request.get('/api/admin/dashboard');
    expect(res.status()).toBe(200);
    const body = await res.json();

    const actions = body.recentAuditActions as Array<Record<string, unknown>>;
    const actions_list = actions.map((a) => a.action);

    // High-impact action must appear
    expect(actions_list).toContain('ban_user');
    // Low-signal action must not appear
    expect(actions_list).not.toContain('edit_news');
  });

  test('recent audit actions have required fields', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'dashaudit2', 'dashaudit2@test.com');
    await activateUser(page, 'dashaudit2');
    await setUserRole(page, 'dashaudit2', 'admin');
    await loginUser(page, 'dashaudit2');

    await writeAuditAction(page, 'force_end_session', 'session');

    const res = await page.request.get('/api/admin/dashboard');
    const body = await res.json();

    const actions = body.recentAuditActions as Array<Record<string, unknown>>;
    expect(actions.length).toBeGreaterThan(0);
    const action = actions[0];
    expect(action).toHaveProperty('action');
    expect(action).toHaveProperty('admin_username');
    expect(action).toHaveProperty('created_at');
  });
});

// ---------------------------------------------------------------------------
// UI tests
// ---------------------------------------------------------------------------

test.describe('Admin page UI — Operations Hub', () => {
  test('admin page renders operations hub section', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'dashui1', 'dashui1@test.com');
    await activateUser(page, 'dashui1');
    await setUserRole(page, 'dashui1', 'admin');
    await loginUser(page, 'dashui1');

    await page.goto(TEST_BASE_URL + '/admin');
    await expect(page.locator('#admin-content')).toBeVisible({ timeout: 8000 });

    // The ops-hub-section should be present
    await expect(page.locator('#ops-hub-section')).toBeVisible();

    // The ops-hub-grid should become visible after data loads
    await expect(page.locator('#ops-hub-grid')).toBeVisible({ timeout: 8000 });
  });

  test('admin page shows all widget titles', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'dashui2', 'dashui2@test.com');
    await activateUser(page, 'dashui2');
    await setUserRole(page, 'dashui2', 'admin');
    await loginUser(page, 'dashui2');

    await page.goto(TEST_BASE_URL + '/admin');
    await expect(page.locator('#ops-hub-grid')).toBeVisible({ timeout: 8000 });

    await expect(page.locator('#ops-hub-grid')).toContainText('Активные сессии');
    await expect(page.locator('#ops-hub-grid')).toContainText('Зависшие блокировки');
    await expect(page.locator('#ops-hub-grid')).toContainText('Машины на обслуживании');
    await expect(page.locator('#ops-hub-grid')).toContainText('Забаненные пользователи');
    await expect(page.locator('#ops-hub-grid')).toContainText('Последние важные действия');
  });

  test('moderator sees only active sessions widget', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'dashui3', 'dashui3@test.com');
    await activateUser(page, 'dashui3');
    await setUserRole(page, 'dashui3', 'moderator');
    await loginUser(page, 'dashui3');

    await page.goto(TEST_BASE_URL + '/admin');
    await expect(page.locator('#ops-hub-grid')).toBeVisible({ timeout: 8000 });

    await expect(page.locator('#ops-hub-grid')).toContainText('Активные сессии');
    await expect(page.locator('#ops-hub-grid')).not.toContainText('Зависшие блокировки');
    await expect(page.locator('#ops-hub-grid')).not.toContainText('Машины на обслуживании');
    await expect(page.locator('#ops-hub-grid')).not.toContainText('Забаненные пользователи');
    await expect(page.locator('#ops-hub-grid')).not.toContainText('Последние важные действия');
  });

  test('manual refresh button triggers reload', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'dashui4', 'dashui4@test.com');
    await activateUser(page, 'dashui4');
    await setUserRole(page, 'dashui4', 'admin');
    await loginUser(page, 'dashui4');

    await page.goto(TEST_BASE_URL + '/admin');
    await expect(page.locator('#ops-hub-grid')).toBeVisible({ timeout: 8000 });

    // Click refresh
    await page.locator('#ops-hub-refresh').click();

    // Skeleton loading text appears briefly, then grid reappears
    await expect(page.locator('#ops-hub-grid')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('#ops-hub-grid')).toContainText('Активные сессии');
  });
});
