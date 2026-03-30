import { test, expect } from '@playwright/test';
import path from 'path';
import Database from 'better-sqlite3';

const DB_PATH = path.resolve(__dirname, '..', '..', 'riley.sqlite');
const TEST_BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:5000';

/**
 * PR 15 — Admin compensation workflow e2e tests.
 *
 * Covers POST /api/admin/users/:id/compensations:
 *  - Access control (unauthenticated, user, moderator, admin)
 *  - All field validations
 *  - Idempotency (same actor → idempotent, different actor → 409)
 *  - Functional: balance credit, transaction record, audit log
 *  - Transaction list and ledger filtering
 *  - UI: compensation button visibility, modal submit
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

function getUserBalance(userId: number): number {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const row = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId) as
      | { balance: number }
      | undefined;
    return row?.balance ?? 0;
  } finally {
    db.close();
  }
}

function getLatestTransaction(userId: number, type: string): {
  id: number;
  user_id: number;
  type: string;
  amount: number;
  balance_after: number;
  description: string;
  admin_id: number | null;
  idempotency_key: string | null;
  created_at: string;
} | undefined {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT id, user_id, type, amount, balance_after, description, admin_id, idempotency_key, created_at
           FROM transactions
          WHERE user_id = ? AND type = ?
          ORDER BY id DESC
          LIMIT 1`,
      )
      .get(userId, type) as any;
  } finally {
    db.close();
  }
}

function getLatestAuditRow(adminId: number, action: string, targetId: number): {
  id: number;
  admin_id: number;
  action: string;
  target_id: number;
  details_json: string | null;
} | undefined {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT id, admin_id, action, target_id, details_json
           FROM admin_audit_log
          WHERE admin_id = ? AND action = ? AND target_id = ?
          ORDER BY id DESC
          LIMIT 1`,
      )
      .get(adminId, action, targetId) as any;
  } finally {
    db.close();
  }
}

function setUserDeleted(userId: number): void {
  const db = new Database(DB_PATH);
  try {
    db.prepare("UPDATE users SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(userId);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test.describe('POST /api/admin/users/:id/compensations — access control', () => {
  test('unauthenticated user gets 401', async ({ page, request }) => {
    await resetDb(page);

    const target = await registerUser(page, 'compac1target', 'compac1target@example.com');
    await activateUser(page, target.username);

    const csrfToken = await getCsrfToken(page);
    const res = await request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 50, reason_code: 'service_issue', idempotency_key: `unauthkey-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(401);
  });

  test('regular user gets 403', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'compac2target', 'compac2target@example.com');
    await activateUser(page, target.username);

    const actor = await registerUser(page, 'compac2actor', 'compac2actor@example.com');
    await activateUser(page, actor.username);
    await loginUser(page, actor.username);

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 50, reason_code: 'service_issue', idempotency_key: `userkey-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(403);
  });

  test('moderator gets 403', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'compac3target', 'compac3target@example.com');
    await activateUser(page, target.username);

    const mod = await registerUser(page, 'compac3mod', 'compac3mod@example.com');
    await activateUser(page, mod.username);
    await setUserRole(page, mod.username, 'moderator');
    await loginUser(page, mod.username);

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 50, reason_code: 'service_issue', idempotency_key: `modkey-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(403);
  });

  test('admin can create compensation', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'compac4target', 'compac4target@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'compac4admin', 'compac4admin@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, admin.username);

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 50, reason_code: 'service_issue', idempotency_key: `adminkey-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validations
// ---------------------------------------------------------------------------

test.describe('POST /api/admin/users/:id/compensations — validations', () => {
  async function setupAdmin(page: import('@playwright/test').Page): Promise<{
    target: { id: number; username: string };
    admin: { id: number; username: string };
    csrfToken: string;
  }> {
    await resetDb(page);

    const target = await registerUser(page, 'compval_target', 'compval_target@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'compval_admin', 'compval_admin@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, admin.username);

    const csrfToken = await getCsrfToken(page);
    return { target, admin, csrfToken };
  }

  test('missing amount returns 400', async ({ page }) => {
    const { target, csrfToken } = await setupAdmin(page);
    const res = await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { reason_code: 'service_issue', idempotency_key: `val1-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(400);
  });

  test('negative amount returns 400', async ({ page }) => {
    const { target, csrfToken } = await setupAdmin(page);
    const res = await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: -100, reason_code: 'service_issue', idempotency_key: `val2-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(400);
  });

  test('zero amount returns 400', async ({ page }) => {
    const { target, csrfToken } = await setupAdmin(page);
    const res = await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 0, reason_code: 'service_issue', idempotency_key: `val3-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(400);
  });

  test('amount exceeding 10000 returns 400', async ({ page }) => {
    const { target, csrfToken } = await setupAdmin(page);
    const res = await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 10001, reason_code: 'service_issue', idempotency_key: `val4-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(400);
  });

  test('missing reason_code returns 400', async ({ page }) => {
    const { target, csrfToken } = await setupAdmin(page);
    const res = await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 50, idempotency_key: `val5-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(400);
  });

  test('invalid reason_code returns 400', async ({ page }) => {
    const { target, csrfToken } = await setupAdmin(page);
    const res = await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 50, reason_code: 'not_a_valid_code', idempotency_key: `val6-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(400);
  });

  test('missing idempotency_key returns 400', async ({ page }) => {
    const { target, csrfToken } = await setupAdmin(page);
    const res = await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 50, reason_code: 'service_issue' },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(400);
  });

  test('target user not found returns 404', async ({ page }) => {
    const { csrfToken } = await setupAdmin(page);
    const res = await page.request.post(`/api/admin/users/999999/compensations`, {
      data: { amount: 50, reason_code: 'service_issue', idempotency_key: `val8-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(404);
  });

  test('target user is deleted returns 400', async ({ page }) => {
    const { target, csrfToken } = await setupAdmin(page);
    setUserDeleted(target.id);

    const res = await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 50, reason_code: 'service_issue', idempotency_key: `val9-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/deleted/i);
  });

  test('admin cannot compensate themselves returns 403', async ({ page }) => {
    await resetDb(page);

    const admin = await registerUser(page, 'compselfadmin', 'compselfadmin@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, admin.username);

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/users/${admin.id}/compensations`, {
      data: { amount: 50, reason_code: 'service_issue', idempotency_key: `selfkey-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(403);
  });

  test('missing CSRF token returns 403', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'compnocsrf_target', 'compnocsrf_target@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'compnocsrf_admin', 'compnocsrf_admin@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, admin.username);

    const res = await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 50, reason_code: 'service_issue', idempotency_key: `nocsrfkey-${Date.now()}` },
      // no X-CSRF-Token header
    });
    expect(res.status()).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test.describe('POST /api/admin/users/:id/compensations — idempotency', () => {
  test('same idempotency_key with same actor returns idempotent result, balance not doubled', async ({
    page,
  }) => {
    await resetDb(page);

    const target = await registerUser(page, 'compidem_target', 'compidem_target@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'compidem_admin', 'compidem_admin@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, admin.username);

    const idempotencyKey = `idem-same-${Date.now()}`;
    const initialBalance = getUserBalance(target.id);
    const expectedBalance = initialBalance + 100;

    const csrfToken1 = await getCsrfToken(page);
    const res1 = await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 100, reason_code: 'billing_error', idempotency_key: idempotencyKey },
      headers: { 'X-CSRF-Token': csrfToken1 },
    });
    expect(res1.status(), await res1.text()).toBe(200);
    const body1 = await res1.json();
    expect(body1.idempotent).toBe(false);
    expect(getUserBalance(target.id)).toBe(expectedBalance);

    const csrfToken2 = await getCsrfToken(page);
    const res2 = await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 100, reason_code: 'billing_error', idempotency_key: idempotencyKey },
      headers: { 'X-CSRF-Token': csrfToken2 },
    });
    expect(res2.status(), await res2.text()).toBe(200);
    const body2 = await res2.json();
    expect(body2.idempotent).toBe(true);
    // Balance must NOT be doubled
    expect(getUserBalance(target.id)).toBe(expectedBalance);
  });

  test('same idempotency_key with different actor returns 409', async ({ page, browser }) => {
    await resetDb(page);

    const target = await registerUser(page, 'compidem2_target', 'compidem2_target@example.com');
    await activateUser(page, target.username);

    const admin1 = await registerUser(page, 'compidem2_admin1', 'compidem2_admin1@example.com');
    await activateUser(page, admin1.username);
    await setUserRole(page, admin1.username, 'admin');

    const admin2 = await registerUser(page, 'compidem2_admin2', 'compidem2_admin2@example.com');
    await activateUser(page, admin2.username);
    await setUserRole(page, admin2.username, 'admin');

    // Login admin1 last so page session belongs to admin1
    await loginUser(page, admin1.username);

    const idempotencyKey = `idem-conflict-${Date.now()}`;

    const csrfToken1 = await getCsrfToken(page);
    const res1 = await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 80, reason_code: 'goodwill_credit', idempotency_key: idempotencyKey },
      headers: { 'X-CSRF-Token': csrfToken1 },
    });
    expect(res1.status(), await res1.text()).toBe(200);

    const secondContext = await browser.newContext({ baseURL: TEST_BASE_URL });
    const secondPage = await secondContext.newPage();
    try {
      await loginUser(secondPage, admin2.username);
      const csrfToken2 = await getCsrfToken(secondPage);
      const res2 = await secondPage.request.post(`/api/admin/users/${target.id}/compensations`, {
        data: { amount: 80, reason_code: 'goodwill_credit', idempotency_key: idempotencyKey },
        headers: { 'X-CSRF-Token': csrfToken2 },
      });
      expect(res2.status(), await res2.text()).toBe(409);
      const body2 = await res2.json();
      expect(body2).toMatchObject({ error: 'idempotency_key_conflict' });
    } finally {
      await secondContext.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Functional
// ---------------------------------------------------------------------------

test.describe('POST /api/admin/users/:id/compensations — functional', () => {
  test('successful compensation credits the correct amount to user balance', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'compfunc1_target', 'compfunc1_target@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'compfunc1_admin', 'compfunc1_admin@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, admin.username);

    const initialBalance = getUserBalance(target.id);
    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 150, reason_code: 'service_issue', idempotency_key: `func1-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.balance).toBe(initialBalance + 150);
    expect(getUserBalance(target.id)).toBe(initialBalance + 150);
  });

  test('transaction record has type admin_compensation', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'compfunc2_target', 'compfunc2_target@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'compfunc2_admin', 'compfunc2_admin@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, admin.username);

    const csrfToken = await getCsrfToken(page);
    await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 75, reason_code: 'billing_error', idempotency_key: `func2-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });

    const tx = getLatestTransaction(target.id, 'admin_compensation');
    expect(tx).toBeDefined();
    expect(tx!.type).toBe('admin_compensation');
    expect(tx!.amount).toBe(75);
  });

  test('transaction description contains Russian reason label', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'compfunc3_target', 'compfunc3_target@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'compfunc3_admin', 'compfunc3_admin@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, admin.username);

    const csrfToken = await getCsrfToken(page);
    await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 50, reason_code: 'goodwill_credit', idempotency_key: `func3-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });

    const tx = getLatestTransaction(target.id, 'admin_compensation');
    expect(tx).toBeDefined();
    expect(tx!.description).toContain('Жест доброй воли');
    expect(tx!.description).toContain('Компенсация:');
  });

  test('transaction description contains note when provided', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'compfunc4_target', 'compfunc4_target@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'compfunc4_admin', 'compfunc4_admin@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, admin.username);

    const note = 'Камера не работала 10 минут';
    const csrfToken = await getCsrfToken(page);
    await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: {
        amount: 50,
        reason_code: 'session_interruption',
        note,
        idempotency_key: `func4-${Date.now()}`,
      },
      headers: { 'X-CSRF-Token': csrfToken },
    });

    const tx = getLatestTransaction(target.id, 'admin_compensation');
    expect(tx).toBeDefined();
    expect(tx!.description).toContain(note);
    expect(tx!.description).toContain('Прерывание сессии');
  });

  test('audit log entry is written with action admin_compensation_create', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'compfunc5_target', 'compfunc5_target@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'compfunc5_admin', 'compfunc5_admin@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, admin.username);

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 200, reason_code: 'service_issue', idempotency_key: `func5-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status(), await res.text()).toBe(200);

    const auditRow = getLatestAuditRow(admin.id, 'admin_compensation_create', target.id);
    expect(auditRow).toBeDefined();
    expect(auditRow!.action).toBe('admin_compensation_create');
    const details = JSON.parse(auditRow!.details_json || '{}');
    expect(details.amount).toBe(200);
    expect(details.reason_code).toBe('service_issue');
  });

  test('compensation appears in GET /api/admin/transactions?type=admin_compensation', async ({
    page,
  }) => {
    await resetDb(page);

    const target = await registerUser(page, 'compfunc6_target', 'compfunc6_target@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'compfunc6_admin', 'compfunc6_admin@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, admin.username);

    const csrfToken = await getCsrfToken(page);
    await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 55, reason_code: 'billing_error', idempotency_key: `func6-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });

    const listRes = await page.request.get('/api/admin/transactions?type=admin_compensation');
    expect(listRes.status(), await listRes.text()).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.items).toBeDefined();
    const found = listBody.items.some(
      (item: any) => item.type === 'admin_compensation' && item.user_id === target.id,
    );
    expect(found).toBe(true);
  });

  test('compensation appears in user ledger GET /api/admin/users/:id/ledger', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'compfunc7_target', 'compfunc7_target@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'compfunc7_admin', 'compfunc7_admin@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, admin.username);

    const csrfToken = await getCsrfToken(page);
    await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: { amount: 30, reason_code: 'goodwill_credit', idempotency_key: `func7-${Date.now()}` },
      headers: { 'X-CSRF-Token': csrfToken },
    });

    const ledgerRes = await page.request.get(`/api/admin/users/${target.id}/ledger`);
    expect(ledgerRes.status(), await ledgerRes.text()).toBe(200);
    const ledgerBody = await ledgerRes.json();
    expect(ledgerBody.transactions).toBeDefined();
    const found = ledgerBody.transactions.some((item: any) => item.type === 'admin_compensation');
    expect(found).toBe(true);
  });

  test('note with 500 characters is accepted', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'compfunc8_target', 'compfunc8_target@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'compfunc8_admin', 'compfunc8_admin@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, admin.username);

    const note500 = 'a'.repeat(500);
    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: {
        amount: 10,
        reason_code: 'service_issue',
        note: note500,
        idempotency_key: `func8a-${Date.now()}`,
      },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status(), await res.text()).toBe(200);
  });

  test('note with 501 characters is rejected', async ({ page }) => {
    await resetDb(page);

    const target = await registerUser(page, 'compfunc9_target', 'compfunc9_target@example.com');
    await activateUser(page, target.username);

    const admin = await registerUser(page, 'compfunc9_admin', 'compfunc9_admin@example.com');
    await activateUser(page, admin.username);
    await setUserRole(page, admin.username, 'admin');
    await loginUser(page, admin.username);

    const note501 = 'a'.repeat(501);
    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/users/${target.id}/compensations`, {
      data: {
        amount: 10,
        reason_code: 'service_issue',
        note: note501,
        idempotency_key: `func9b-${Date.now()}`,
      },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// UI tests
// ---------------------------------------------------------------------------

test.describe('Admin compensation UI', () => {
  test('admin sees "Компенсация" button on user rows', async ({ page }) => {
    await resetDb(page);

    await registerUser(page, 'compui_target', 'compui_target@test.com');
    await activateUser(page, 'compui_target');

    await registerUser(page, 'compui_admin', 'compui_admin@test.com');
    await activateUser(page, 'compui_admin');
    await setUserRole(page, 'compui_admin', 'admin');
    await loginUser(page, 'compui_admin');

    await page.goto(TEST_BASE_URL + '/admin-users');
    await expect(page.locator('#users-table')).toBeVisible({ timeout: 8000 });

    await expect(page.locator('button.btn-compensation').first()).toBeVisible({ timeout: 5000 });
  });

  test('moderator does NOT see "Компенсация" button', async ({ page }) => {
    await resetDb(page);

    await registerUser(page, 'compuimod_target', 'compuimod_target@test.com');
    await activateUser(page, 'compuimod_target');

    await registerUser(page, 'compuimod_mod', 'compuimod_mod@test.com');
    await activateUser(page, 'compuimod_mod');
    await setUserRole(page, 'compuimod_mod', 'moderator');
    await loginUser(page, 'compuimod_mod');

    await page.goto(TEST_BASE_URL + '/admin-users');
    await expect(page.locator('#users-table')).toBeVisible({ timeout: 8000 });

    await expect(page.locator('button.btn-compensation')).toHaveCount(0);
  });

  test('admin can open compensation modal, fill form, and submit successfully', async ({ page }) => {
    await resetDb(page);

    await registerUser(page, 'compuisubmit_target', 'compuisubmit_target@test.com');
    await activateUser(page, 'compuisubmit_target');

    await registerUser(page, 'compuisubmit_admin', 'compuisubmit_admin@test.com');
    await activateUser(page, 'compuisubmit_admin');
    await setUserRole(page, 'compuisubmit_admin', 'admin');
    await loginUser(page, 'compuisubmit_admin');

    await page.goto(TEST_BASE_URL + '/admin-users');
    await expect(page.locator('#users-table')).toBeVisible({ timeout: 8000 });

    const targetRow = page
      .locator('#users-tbody tr')
      .filter({ has: page.locator('td', { hasText: 'compuisubmit_target' }) })
      .first();
    await expect(targetRow).toBeVisible({ timeout: 5000 });

    // Click compensation button
    await targetRow.locator('button.btn-compensation').click();
    await expect(page.locator('#modal-compensation')).toBeVisible({ timeout: 4000 });

    // Fill the form
    await page.fill('#comp-amount', '100');
    await page.selectOption('#comp-reason', 'service_issue');

    // Submit
    await page.click('#modal-comp-submit');

    // Modal should close and flash success
    await expect(page.locator('#modal-compensation')).toBeHidden({ timeout: 6000 });
    await expect(page.locator('#flash-container .admin-flash--success')).toBeVisible({
      timeout: 6000,
    });
  });

  test('success flash message appears after compensation', async ({ page }) => {
    await resetDb(page);

    await registerUser(page, 'compuiflash_target', 'compuiflash_target@test.com');
    await activateUser(page, 'compuiflash_target');

    await registerUser(page, 'compuiflash_admin', 'compuiflash_admin@test.com');
    await activateUser(page, 'compuiflash_admin');
    await setUserRole(page, 'compuiflash_admin', 'admin');
    await loginUser(page, 'compuiflash_admin');

    await page.goto(TEST_BASE_URL + '/admin-users');
    await expect(page.locator('#users-table')).toBeVisible({ timeout: 8000 });

    const targetRow = page
      .locator('#users-tbody tr')
      .filter({ has: page.locator('td', { hasText: 'compuiflash_target' }) })
      .first();
    await targetRow.locator('button.btn-compensation').click();
    await expect(page.locator('#modal-compensation')).toBeVisible({ timeout: 4000 });

    await page.fill('#comp-amount', '50');
    await page.selectOption('#comp-reason', 'billing_error');
    await page.click('#modal-comp-submit');

    await expect(page.locator('#flash-container .admin-flash--success')).toBeVisible({
      timeout: 6000,
    });
  });
});
