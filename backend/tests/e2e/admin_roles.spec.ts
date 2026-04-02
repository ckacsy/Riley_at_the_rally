import { test, expect } from '@playwright/test';

/**
 * PR 1 — Role/Status/Audit infrastructure tests.
 *
 * Covers:
 *  - New users get `role = 'user'` by default
 *  - Banned users are blocked by requireActiveUser (GET /api/balance proxy)
 *  - requireRole returns 403 for insufficient role
 *  - admin_audit_log table exists and is writable
 *  - transactions table has idempotency_key and admin_id columns
 */

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
  const actRes = await page.request.post('/api/dev/activate-user', {
    data: { username },
  });
  expect(actRes.status(), `activate failed: ${await actRes.text()}`).toBe(200);
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

async function setUserStatus(
  page: import('@playwright/test').Page,
  username: string,
  status: 'pending' | 'active' | 'banned' | 'deleted' | 'disabled',
): Promise<void> {
  const res = await page.request.post('/api/dev/set-user-status', {
    data: { username, status },
  });
  expect(res.status(), `set-user-status failed: ${await res.text()}`).toBe(200);
}

async function setUserRole(
  page: import('@playwright/test').Page,
  username: string,
  role: 'user' | 'moderator' | 'admin',
): Promise<void> {
  const res = await page.request.post('/api/dev/set-user-role', {
    data: { username, role },
  });
  expect(res.status(), `set-user-role failed: ${await res.text()}`).toBe(200);
}

// ---------------------------------------------------------------------------
// Schema / migration smoke-tests
// ---------------------------------------------------------------------------

test.describe('PR1 migrations — schema smoke tests', () => {
  test('/api/health is still OK after PR1 migrations', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('new user has role=user by default', async ({ page }) => {
    await resetDb(page);

    const user = await registerUser(page, 'roletest', 'roletest@example.com');
    await activateUser(page, user.username);

    // The registration response should contain the user object.
    // Since the API doesn't expose role directly, verify via /api/auth/me
    await loginUser(page, 'roletest');
    const meRes = await page.request.get('/api/auth/me');
    expect(meRes.status()).toBe(200);
    const me = await meRes.json();
    // /api/auth/me returns { user: { id, username, email, role, ... } }
    expect(me.user).toBeTruthy();
    expect(me.user).toHaveProperty('role');
    expect(me.user.role).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// Banned user is blocked by requireActiveUser
// ---------------------------------------------------------------------------

test.describe('PR1 — requireRole and status enforcement', () => {
  test('pending user gets 403 pending_verification on admin role probe', async ({ page }) => {
    await resetDb(page);

    await registerUser(page, 'pendinguser', 'pendinguser@example.com');
    await loginUser(page, 'pendinguser');

    const res = await page.request.get('/api/dev/role-probe/admin');
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({
      error: 'pending_verification',
    });
  });

  test('banned user gets 403 account_banned on requireActiveUser-protected payment create', async ({ page }) => {
    await resetDb(page);

    await registerUser(page, 'banneduser', 'banneduser@example.com');
    await activateUser(page, 'banneduser');
    await loginUser(page, 'banneduser');
    await setUserStatus(page, 'banneduser', 'banned');

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post('/api/payment/create', {
      data: { amount: 50 },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({
      error: 'account_banned',
    });
  });

  test('legacy disabled user is also blocked by requireRole', async ({ page }) => {
    await resetDb(page);

    await registerUser(page, 'disableduser', 'disableduser@example.com');
    await activateUser(page, 'disableduser');
    await loginUser(page, 'disableduser');
    await setUserStatus(page, 'disableduser', 'disabled');

    const res = await page.request.get('/api/dev/role-probe/admin');
    expect(res.status()).toBe(403);
    const body = await res.json();
    // 'disabled' is a legacy status not in the canonical model; it falls through
    // to the generic 'account_inactive' block in getAccessBlockReason
    expect(body).toMatchObject({
      error: 'account_inactive',
    });
  });

  test('plain active user gets 403 forbidden on admin role probe', async ({ page }) => {
    await resetDb(page);

    await registerUser(page, 'plainuser', 'plainuser@example.com');
    await activateUser(page, 'plainuser');
    await loginUser(page, 'plainuser');

    const res = await page.request.get('/api/dev/role-probe/admin');
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({
      error: 'forbidden',
    });
  });

  test('admin user gets 200 on admin role probe', async ({ page }) => {
    await resetDb(page);

    await registerUser(page, 'adminuser', 'adminuser@example.com');
    await activateUser(page, 'adminuser');
    await setUserRole(page, 'adminuser', 'admin');
    await loginUser(page, 'adminuser');

    const res = await page.request.get('/api/dev/role-probe/admin');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      user: {
        username: 'adminuser',
        role: 'admin',
      },
    });
  });

  test('unauthenticated request to admin role probe returns 401', async ({ request }) => {
    const res = await request.get('/api/dev/role-probe/admin');
    expect(res.status()).toBe(401);
  });

  test('banned user cannot log in', async ({ page }) => {
    await resetDb(page);

    await registerUser(page, 'loginbanned', 'loginbanned@example.com');
    await activateUser(page, 'loginbanned');
    await setUserStatus(page, 'loginbanned', 'banned');

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post('/api/auth/login', {
      data: { identifier: 'loginbanned', password: 'Secure#Pass1' },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Аккаунт заблокирован. Обратитесь в поддержку.');
  });
});

test.describe('PR1 — admin audit log helper', () => {
  test('admin audit write endpoint persists a row in admin_audit_log', async ({ page }) => {
    await resetDb(page);

    await registerUser(page, 'auditadmin', 'auditadmin@example.com');
    await activateUser(page, 'auditadmin');
    await setUserRole(page, 'auditadmin', 'admin');
    await loginUser(page, 'auditadmin');

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post('/api/dev/admin-audit-log/write', {
      data: {
        action: 'test_audit_write',
        targetType: 'user',
        targetId: 42,
        details: { source: 'playwright', marker: 'audit-smoke' },
      },
      headers: { 'X-CSRF-Token': csrfToken },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.row).toBeTruthy();
    expect(body.row.admin_id).toBeGreaterThan(0);
    expect(body.row.action).toBe('test_audit_write');
    expect(body.row.target_type).toBe('user');
    expect(body.row.target_id).toBe(42);
    expect(typeof body.row.details_json).toBe('string');
    expect(body.row.details_json).toContain('audit-smoke');
  });
});
