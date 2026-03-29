import { test, expect } from '@playwright/test';
import path from 'path';
import Database from 'better-sqlite3';

const DB_PATH = path.resolve(__dirname, '..', '..', 'riley.sqlite');
const TEST_BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:5000';

/**
 * PR 2 — Admin user management e2e tests.
 *
 * Covers:
 *  - GET /api/admin/users (admin and moderator access, plain user rejected)
 *  - POST /api/admin/users/:id/ban (moderator can ban user, cannot ban admin, cannot ban self)
 *  - POST /api/admin/users/:id/unban
 *  - POST /api/admin/users/:id/delete (admin soft delete, cannot delete self)
 *  - POST /api/admin/users/:id/balance-adjust (idempotency, missing CSRF -> 403)
 *  - Audit log written for at least one admin action
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

function getLatestAdminAuditRow(adminId: number, action: string, targetId: number): {
  id: number;
  admin_id: number;
  action: string;
  target_id: number;
  details_json: string | null;
} | undefined {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db.prepare(
      `SELECT id, admin_id, action, target_id, details_json
         FROM admin_audit_log
        WHERE admin_id = ? AND action = ? AND target_id = ?
        ORDER BY id DESC
        LIMIT 1`
    ).get(adminId, action, targetId);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/users
// ---------------------------------------------------------------------------

test.describe('GET /api/admin/users', () => {
  test('admin can list users', async ({ page }) => {
    await resetDb(page);

    const admin = await registerUser(page, 'adminlist', 'adminlist@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, 'adminlist');

    const res = await page.request.get('/api/admin/users');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.users.length).toBeGreaterThan(0);
    const u = body.users[0];
    expect(u).toHaveProperty('id');
    expect(u).toHaveProperty('username');
    expect(u).toHaveProperty('email');
    expect(u).toHaveProperty('status');
    expect(u).toHaveProperty('role');
    expect(u).toHaveProperty('balance');
    expect(u).toHaveProperty('created_at');
  });

  test('moderator can list users', async ({ page }) => {
    await resetDb(page);

    const mod = await registerUser(page, 'modlist', 'modlist@example.com');
    await activateUser(page, mod.username);
    await setUserRole(page, mod.username, 'moderator');
    await loginUser(page, 'modlist');

    const res = await page.request.get('/api/admin/users');
    expect(res.status()).toBe(200);
  });

  test('plain user cannot list users', async ({ page }) => {
    await resetDb(page);

    const user = await registerUser(page, 'plainlist', 'plainlist@example.com');
    await activateUser(page, user.username);
    await loginUser(page, 'plainlist');

    const res = await page.request.get('/api/admin/users');
    expect(res.status()).toBe(403);
  });

  test('unauthenticated request is rejected', async ({ request }) => {
    const res = await request.get('/api/admin/users');
    expect(res.status()).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/users/:id/ban
// ---------------------------------------------------------------------------

test.describe('POST /api/admin/users/:id/ban', () => {
  test('moderator can ban a plain user', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'targetban', 'targetban@example.com');
    await activateUser(page, target.username);

    const mod = await registerUser(page, 'modban', 'modban@example.com');
    await activateUser(page, mod.username);
    await setUserRole(page, mod.username, 'moderator');
    await loginUser(page, 'modban');

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/users/${target.id}/ban`, {
      data: { reason: 'test ban' },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.user.status).toBe('banned');
  });

  test('moderator cannot ban an admin', async ({ page }) => {
    await resetDb(page);

    const adminTarget = await registerUser(page, 'admintarget', 'admintarget@example.com');
    await activateUser(page, adminTarget.username);
    await setUserRole(page, adminTarget.username, 'admin');

    const mod = await registerUser(page, 'modbantarget', 'modbantarget@example.com');
    await activateUser(page, mod.username);
    await setUserRole(page, mod.username, 'moderator');
    await loginUser(page, 'modbantarget');

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/users/${adminTarget.id}/ban`, {
      data: {},
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(403);
  });

  test('admin cannot ban self', async ({ page }) => {
    await resetDb(page);

    const admin = await registerUser(page, 'adminself', 'adminself@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, 'adminself');

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/users/${admin.id}/ban`, {
      data: {},
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(403);
  });

  test('missing CSRF on ban -> 403', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'targetnocsrf', 'targetnocsrf@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'adminnocsrf', 'adminnocsrf@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, 'adminnocsrf');

    const res = await page.request.post(`/api/admin/users/${target.id}/ban`, {
      data: {},
      // no X-CSRF-Token header
    });
    expect(res.status()).toBe(403);
  });

  test('unauthenticated ban attempt is rejected', async ({ page, request }) => {
    await resetDb(page);
    const target = await registerUser(page, 'targetunauth', 'targetunauth@example.com');
    await activateUser(page, target.username);

    const csrfToken = await getCsrfToken(page);
    const res = await request.post(`/api/admin/users/${target.id}/ban`, {
      data: {},
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/users/:id/unban
// ---------------------------------------------------------------------------

test.describe('POST /api/admin/users/:id/unban', () => {
  test('admin can unban a banned user', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'targetunban', 'targetunban@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'adminunban', 'adminunban@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, 'adminunban');

    const csrfToken = await getCsrfToken(page);

    // First ban the user
    await page.request.post(`/api/admin/users/${target.id}/ban`, {
      data: {},
      headers: { 'X-CSRF-Token': csrfToken },
    });

    // Now unban
    const csrfToken2 = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/users/${target.id}/unban`, {
      data: {},
      headers: { 'X-CSRF-Token': csrfToken2 },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.user.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/users/:id/delete
// ---------------------------------------------------------------------------

test.describe('POST /api/admin/users/:id/delete (soft delete)', () => {
  test('admin can soft delete a user', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'targetdel', 'targetdel@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'admindelete', 'admindelete@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, 'admindelete');

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/users/${target.id}/delete`, {
      data: {},
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.user.status).toBe('deleted');
    expect(body.user.deleted_at).toBeTruthy();
  });

  test('admin cannot delete self', async ({ page }) => {
    await resetDb(page);

    const admin = await registerUser(page, 'admindelself', 'admindelself@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, 'admindelself');

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/users/${admin.id}/delete`, {
      data: {},
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(403);
  });

  test('moderator cannot delete users (admin only endpoint)', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'targetdel2', 'targetdel2@example.com');
    await activateUser(page, target.username);

    const mod = await registerUser(page, 'moddel', 'moddel@example.com');
    await activateUser(page, mod.username);
    await setUserRole(page, mod.username, 'moderator');
    await loginUser(page, 'moddel');

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/users/${target.id}/delete`, {
      data: {},
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/users/:id/balance-adjust
// ---------------------------------------------------------------------------

test.describe('POST /api/admin/users/:id/balance-adjust', () => {
  test('admin can adjust balance and idempotency prevents double-credit', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'targetbal', 'targetbal@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'adminbal', 'adminbal@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, 'adminbal');

    const idempotencyKey = `test-key-${Date.now()}`;

    // First request
    const csrfToken1 = await getCsrfToken(page);
    const res1 = await page.request.post(`/api/admin/users/${target.id}/balance-adjust`, {
      data: { amount: 100, comment: 'bonus credit', idempotency_key: idempotencyKey },
      headers: { 'X-CSRF-Token': csrfToken1 },
    });
    expect(res1.status(), await res1.text()).toBe(200);
    const body1 = await res1.json();
    expect(body1.success).toBe(true);
    expect(body1.idempotent).toBe(false);
    expect(body1.balance).toBeCloseTo(300); // default 200 + 100

    // Second request with same idempotency_key — must be idempotent
    const csrfToken2 = await getCsrfToken(page);
    const res2 = await page.request.post(`/api/admin/users/${target.id}/balance-adjust`, {
      data: { amount: 100, comment: 'bonus credit', idempotency_key: idempotencyKey },
      headers: { 'X-CSRF-Token': csrfToken2 },
    });
    expect(res2.status(), await res2.text()).toBe(200);
    const body2 = await res2.json();
    expect(body2.success).toBe(true);
    expect(body2.idempotent).toBe(true);
    // Balance must NOT have changed a second time
    expect(body2.balance).toBeCloseTo(300);

    // Same transaction id returned both times
    expect(body2.transaction.id).toBe(body1.transaction.id);
  });

  test('reusing idempotency key for a different target returns conflict', async ({ page }) => {
    await resetDb(page);

    const targetOne = await registerUser(page, 'targetbalone', 'targetbalone@example.com');
    await activateUser(page, targetOne.username);
    const targetTwo = await registerUser(page, 'targetbaltwo', 'targetbaltwo@example.com');
    await activateUser(page, targetTwo.username);

    const admin = await registerUser(page, 'adminbalconflict', 'adminbalconflict@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, 'adminbalconflict');

    const idempotencyKey = `target-conflict-${Date.now()}`;

    const csrfToken1 = await getCsrfToken(page);
    const res1 = await page.request.post(`/api/admin/users/${targetOne.id}/balance-adjust`, {
      data: { amount: 25, comment: 'first target', idempotency_key: idempotencyKey },
      headers: { 'X-CSRF-Token': csrfToken1 },
    });
    expect(res1.status(), await res1.text()).toBe(200);

    const csrfToken2 = await getCsrfToken(page);
    const res2 = await page.request.post(`/api/admin/users/${targetTwo.id}/balance-adjust`, {
      data: { amount: 25, comment: 'second target', idempotency_key: idempotencyKey },
      headers: { 'X-CSRF-Token': csrfToken2 },
    });
    expect(res2.status(), await res2.text()).toBe(409);
    const body2 = await res2.json();
    expect(body2).toMatchObject({ error: 'idempotency_key_conflict' });
  });

  test('reusing idempotency key by a different admin returns conflict', async ({ page, browser }) => {
    await resetDb(page);

    const target = await registerUser(page, 'targetbalactor', 'targetbalactor@example.com');
    await activateUser(page, target.username);

    const adminOne = await registerUser(page, 'adminactorone', 'adminactorone@example.com');
    await activateUser(page, adminOne.username);
    await setUserRole(page, adminOne.username, 'admin');

    const adminTwo = await registerUser(page, 'adminactortwo', 'adminactortwo@example.com');
    await activateUser(page, adminTwo.username);
    await setUserRole(page, adminTwo.username, 'admin');

    await loginUser(page, 'adminactorone');

    const idempotencyKey = `actor-conflict-${Date.now()}`;
    const csrfToken1 = await getCsrfToken(page);
    const res1 = await page.request.post(`/api/admin/users/${target.id}/balance-adjust`, {
      data: { amount: 40, comment: 'first admin', idempotency_key: idempotencyKey },
      headers: { 'X-CSRF-Token': csrfToken1 },
    });
    expect(res1.status(), await res1.text()).toBe(200);

    const secondContext = await browser.newContext({ baseURL: TEST_BASE_URL });
    const secondPage = await secondContext.newPage();
    try {
      await loginUser(secondPage, 'adminactortwo');
      const csrfToken2 = await getCsrfToken(secondPage);
      const res2 = await secondPage.request.post(`/api/admin/users/${target.id}/balance-adjust`, {
        data: { amount: 40, comment: 'second admin', idempotency_key: idempotencyKey },
        headers: { 'X-CSRF-Token': csrfToken2 },
      });
      expect(res2.status(), await res2.text()).toBe(409);
      const body2 = await res2.json();
      expect(body2).toMatchObject({ error: 'idempotency_key_conflict' });
    } finally {
      await secondContext.close();
    }
  });

  test('moderator cannot balance-adjust admin', async ({ page }) => {
    await resetDb(page);

    const adminTarget = await registerUser(page, 'targetadminbal', 'targetadminbal@example.com');
    await activateUser(page, adminTarget.username);
    await setUserRole(page, adminTarget.username, 'admin');

    const moderator = await registerUser(page, 'modbalance', 'modbalance@example.com');
    await activateUser(page, moderator.username);
    await setUserRole(page, moderator.username, 'moderator');
    await loginUser(page, 'modbalance');

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/users/${adminTarget.id}/balance-adjust`, {
      data: { amount: 50, comment: 'should fail', idempotency_key: `mod-admin-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status(), await res.text()).toBe(403);
  });

  test('balance adjust rejects if new balance would go negative', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'targetneg', 'targetneg@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'adminneg', 'adminneg@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, 'adminneg');

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/users/${target.id}/balance-adjust`, {
      data: { amount: -99999, comment: 'overdraft attempt', idempotency_key: `neg-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('insufficient_balance');
  });

  test('missing CSRF on balance-adjust -> 403', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'targetnocsrfbal', 'targetnocsrfbal@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'adminnocsrfbal', 'adminnocsrfbal@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, 'adminnocsrfbal');

    const res = await page.request.post(`/api/admin/users/${target.id}/balance-adjust`, {
      data: { amount: 50, comment: 'test', idempotency_key: `nocsrf-${Date.now()}` },
      // no X-CSRF-Token header
    });
    expect(res.status()).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Audit log written for an admin action
// ---------------------------------------------------------------------------

test.describe('Admin audit log', () => {
  test('admin ban action writes its own audit row', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'auditbantarget', 'auditbantarget@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'auditbanadmin', 'auditbanadmin@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, 'auditbanadmin');

    const csrfToken = await getCsrfToken(page);
    const banRes = await page.request.post(`/api/admin/users/${target.id}/ban`, {
      data: { reason: 'audit smoke test' },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(banRes.status(), await banRes.text()).toBe(200);

    const auditRow = getLatestAdminAuditRow(admin.id, 'ban_user', target.id);
    expect(auditRow).toBeTruthy();
    expect(auditRow?.admin_id).toBe(admin.id);
    expect(auditRow?.action).toBe('ban_user');
    expect(auditRow?.target_id).toBe(target.id);
    expect(auditRow?.details_json).toContain('"reason":"audit smoke test"');
    expect(auditRow?.details_json).toContain('"new_status":"banned"');
  });
});
