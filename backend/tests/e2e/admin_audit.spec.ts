import { test, expect } from '@playwright/test';
import path from 'path';
import Database from 'better-sqlite3';

const DB_PATH = path.resolve(__dirname, '..', '..', 'riley.sqlite');
const TEST_BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:5000';

/**
 * PR 5 — Admin audit log API and UI e2e tests.
 *
 * Covers:
 *  - GET /api/admin/audit-log: admin can fetch; moderator cannot
 *  - Filter by action
 *  - Pagination: page/limit params
 *  - Validation: invalid page/limit/date returns 400
 *  - UI: admin can open audit page
 *  - UI: moderator is redirected
 *  - UI: audit table renders rows
 *  - UI: action filter narrows results
 *  - UI: details viewer shows JSON safely
 *  - UI: admin landing page shows Audit Log card only for admin
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

/** Write an audit log entry via the dev endpoint (requires admin session). */
async function writeAuditEntry(
  page: import('@playwright/test').Page,
  action: string,
  targetType: string,
  targetId: number,
  details: object = {},
): Promise<void> {
  const csrfToken = await getCsrfToken(page);
  const res = await page.request.post('/api/dev/admin-audit-log/write', {
    data: { action, targetType, targetId, details },
    headers: { 'X-CSRF-Token': csrfToken },
  });
  expect(res.status(), `writeAuditEntry failed: ${await res.text()}`).toBe(200);
}

// ---------------------------------------------------------------------------
// API Tests
// ---------------------------------------------------------------------------

test.describe('GET /api/admin/audit-log', () => {
  test('admin can fetch audit log', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'auditadmin1', 'auditadmin1@test.com');
    await activateUser(page, 'auditadmin1');
    await setUserRole(page, 'auditadmin1', 'admin');
    await loginUser(page, 'auditadmin1');

    const res = await page.request.get('/api/admin/audit-log');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('items');
    expect(body).toHaveProperty('pagination');
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.pagination).toHaveProperty('page', 1);
    expect(body.pagination).toHaveProperty('limit', 50);
    expect(typeof body.pagination.total).toBe('number');
    expect(typeof body.pagination.pages).toBe('number');
  });

  test('moderator cannot fetch audit log', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'auditmoderator1', 'auditmoderator1@test.com');
    await activateUser(page, 'auditmoderator1');
    await setUserRole(page, 'auditmoderator1', 'moderator');
    await loginUser(page, 'auditmoderator1');

    const res = await page.request.get('/api/admin/audit-log');
    expect(res.status()).toBe(403);
  });

  test('unauthenticated user cannot fetch audit log', async ({ page }) => {
    await resetDb(page);
    const res = await page.request.get('/api/admin/audit-log');
    expect(res.status()).toBe(401);
  });

  test('filter by action works', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'auditadmin2', 'auditadmin2@test.com');
    await activateUser(page, 'auditadmin2');
    await setUserRole(page, 'auditadmin2', 'admin');
    await loginUser(page, 'auditadmin2');

    // Write a ban_user and a balance_adjust entry
    await writeAuditEntry(page, 'ban_user', 'user', 99, { reason: 'test' });
    await writeAuditEntry(page, 'balance_adjust', 'user', 99, { amount: 10 });

    const res = await page.request.get('/api/admin/audit-log?action=ban_user');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    body.items.forEach((item: { action: string }) => {
      expect(item.action).toBe('ban_user');
    });
  });

  test('pagination works', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'auditadmin3', 'auditadmin3@test.com');
    await activateUser(page, 'auditadmin3');
    await setUserRole(page, 'auditadmin3', 'admin');
    await loginUser(page, 'auditadmin3');

    // Write 3 entries
    for (let i = 0; i < 3; i++) {
      await writeAuditEntry(page, 'ban_user', 'user', 100 + i, {});
    }

    const res = await page.request.get('/api/admin/audit-log?page=1&limit=2');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeLessThanOrEqual(2);
    expect(body.pagination.limit).toBe(2);
    expect(body.pagination.page).toBe(1);
  });

  test('invalid page returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'auditadmin4', 'auditadmin4@test.com');
    await activateUser(page, 'auditadmin4');
    await setUserRole(page, 'auditadmin4', 'admin');
    await loginUser(page, 'auditadmin4');

    const res = await page.request.get('/api/admin/audit-log?page=0');
    expect(res.status()).toBe(400);
  });

  test('invalid page (non-integer) returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'auditadmin5', 'auditadmin5@test.com');
    await activateUser(page, 'auditadmin5');
    await setUserRole(page, 'auditadmin5', 'admin');
    await loginUser(page, 'auditadmin5');

    const res = await page.request.get('/api/admin/audit-log?page=abc');
    expect(res.status()).toBe(400);
  });

  test('invalid limit returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'auditadmin6', 'auditadmin6@test.com');
    await activateUser(page, 'auditadmin6');
    await setUserRole(page, 'auditadmin6', 'admin');
    await loginUser(page, 'auditadmin6');

    // limit > 100
    const res1 = await page.request.get('/api/admin/audit-log?limit=200');
    expect(res1.status()).toBe(400);

    // limit = 0
    const res2 = await page.request.get('/api/admin/audit-log?limit=0');
    expect(res2.status()).toBe(400);
  });

  test('invalid date_from format returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'auditadmin7', 'auditadmin7@test.com');
    await activateUser(page, 'auditadmin7');
    await setUserRole(page, 'auditadmin7', 'admin');
    await loginUser(page, 'auditadmin7');

    const res = await page.request.get('/api/admin/audit-log?date_from=29-03-2026');
    expect(res.status()).toBe(400);
  });

  test('invalid date_to format returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'auditadmin8', 'auditadmin8@test.com');
    await activateUser(page, 'auditadmin8');
    await setUserRole(page, 'auditadmin8', 'admin');
    await loginUser(page, 'auditadmin8');

    const res = await page.request.get('/api/admin/audit-log?date_to=2026/03/29');
    expect(res.status()).toBe(400);
  });

  test('response includes admin_username via LEFT JOIN', async ({ page }) => {
    await resetDb(page);
    const adminUser = await registerUser(page, 'auditadmin9', 'auditadmin9@test.com');
    await activateUser(page, 'auditadmin9');
    await setUserRole(page, 'auditadmin9', 'admin');
    await loginUser(page, 'auditadmin9');

    await writeAuditEntry(page, 'news_create', 'news', 1, { title: 'test' });

    const res = await page.request.get('/api/admin/audit-log?action=news_create&limit=1');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    const item = body.items[0];
    expect(item).toHaveProperty('admin_username', 'auditadmin9');
    expect(item).toHaveProperty('admin_id', adminUser.id);
  });
});

// ---------------------------------------------------------------------------
// UI Tests
// ---------------------------------------------------------------------------

test('admin can open audit page', async ({ page }) => {
  await resetDb(page);
  await registerUser(page, 'auditui1', 'auditui1@test.com');
  await activateUser(page, 'auditui1');
  await setUserRole(page, 'auditui1', 'admin');
  await loginUser(page, 'auditui1');

  await page.goto(TEST_BASE_URL + '/admin-audit');
  await expect(page.locator('#admin-content')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#audit-table')).toBeAttached();
});

test('moderator is redirected from audit page', async ({ page }) => {
  await resetDb(page);
  await registerUser(page, 'auditmod1', 'auditmod1@test.com');
  await activateUser(page, 'auditmod1');
  await setUserRole(page, 'auditmod1', 'moderator');
  await loginUser(page, 'auditmod1');

  await page.goto(TEST_BASE_URL + '/admin-audit');
  await expect(page).toHaveURL(/garage/, { timeout: 8000 });
});

test('plain user is redirected from audit page', async ({ page }) => {
  await resetDb(page);
  await registerUser(page, 'auditplain1', 'auditplain1@test.com');
  await activateUser(page, 'auditplain1');
  await loginUser(page, 'auditplain1');

  await page.goto(TEST_BASE_URL + '/admin-audit');
  await expect(page).toHaveURL(/garage/, { timeout: 8000 });
});

test('audit table renders rows', async ({ page }) => {
  await resetDb(page);
  await registerUser(page, 'auditui2', 'auditui2@test.com');
  await activateUser(page, 'auditui2');
  await setUserRole(page, 'auditui2', 'admin');
  await loginUser(page, 'auditui2');

  // Write an entry via dev endpoint
  await writeAuditEntry(page, 'ban_user', 'user', 42, { old_status: 'active', new_status: 'banned' });

  await page.goto(TEST_BASE_URL + '/admin-audit');
  await expect(page.locator('#admin-content')).toBeVisible({ timeout: 8000 });

  // Table should have at least one row
  await expect(page.locator('#audit-tbody tr')).toHaveCount(1, { timeout: 8000 });
  const firstRow = page.locator('#audit-tbody tr').first();
  await expect(firstRow).toContainText('ban_user');
});

test('action filter narrows results', async ({ page }) => {
  await resetDb(page);
  await registerUser(page, 'auditui3', 'auditui3@test.com');
  await activateUser(page, 'auditui3');
  await setUserRole(page, 'auditui3', 'admin');
  await loginUser(page, 'auditui3');

  // Write two different action entries
  await writeAuditEntry(page, 'ban_user', 'user', 10, {});
  await writeAuditEntry(page, 'balance_adjust', 'user', 11, { amount: 50 });

  // Navigate with action filter applied
  await page.goto(TEST_BASE_URL + '/admin-audit?action=ban_user');
  await expect(page.locator('#admin-content')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#audit-tbody tr')).toHaveCount(1, { timeout: 8000 });
  await expect(page.locator('#audit-tbody tr').first()).toContainText('ban_user');
  // Verify filter select is hydrated from URL
  await expect(page.locator('#f-action')).toHaveValue('ban_user');
});

test('details viewer shows JSON safely', async ({ page }) => {
  await resetDb(page);
  await registerUser(page, 'auditui4', 'auditui4@test.com');
  await activateUser(page, 'auditui4');
  await setUserRole(page, 'auditui4', 'admin');
  await loginUser(page, 'auditui4');

  // Write an entry with potentially dangerous detail value
  await writeAuditEntry(page, 'ban_user', 'user', 5, {
    reason: '<script>alert("xss")</script>',
  });

  await page.goto(TEST_BASE_URL + '/admin-audit');
  await expect(page.locator('#admin-content')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#audit-tbody tr')).toHaveCount(1, { timeout: 8000 });

  // Click "Показать" to expand details
  const detailsBtn = page.locator('#audit-tbody .btn-details').first();
  await detailsBtn.click();

  // The pre element should show the text, not execute as HTML
  const preEl = page.locator('#audit-tbody pre').first();
  await expect(preEl).toBeVisible({ timeout: 4000 });
  const preText = await preEl.textContent();
  expect(preText).toContain('<script>');
  // Ensure no actual script tag was injected as HTML
  const preHtml = await preEl.innerHTML();
  expect(preHtml).not.toContain('<script>');
});

test('admin landing page shows Audit Log card only for admin', async ({ page }) => {
  await resetDb(page);

  // Admin sees audit card
  await registerUser(page, 'auditcard1', 'auditcard1@test.com');
  await activateUser(page, 'auditcard1');
  await setUserRole(page, 'auditcard1', 'admin');
  await loginUser(page, 'auditcard1');

  await page.goto(TEST_BASE_URL + '/admin');
  await expect(page.locator('#admin-content')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#card-audit')).toBeVisible({ timeout: 4000 });
});

test('admin landing page hides Audit Log card for moderator', async ({ page }) => {
  await resetDb(page);

  await registerUser(page, 'auditcard2', 'auditcard2@test.com');
  await activateUser(page, 'auditcard2');
  await setUserRole(page, 'auditcard2', 'moderator');
  await loginUser(page, 'auditcard2');

  await page.goto(TEST_BASE_URL + '/admin');
  await expect(page.locator('#admin-content')).toBeVisible({ timeout: 8000 });
  // Audit card should remain hidden for moderator
  await expect(page.locator('#card-audit')).toBeHidden({ timeout: 4000 });
});
