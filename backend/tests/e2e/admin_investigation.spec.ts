import { test, expect } from '@playwright/test';

const TEST_BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:5000';

/**
 * Admin investigation timeline and entity e2e tests.
 *
 * Covers:
 *  - GET /api/admin/investigation/timeline: access control (401, 403, 200)
 *  - GET /api/admin/investigation/entity/:type/:id: access control (moderator+ allowed)
 *  - Timeline validation: no filters → 400; invalid params → 400
 *  - Timeline data: transactions, sessions, audit, maintenance sources
 *  - Filtering: user_id, car_id, reference_id, date range, combined
 *  - Sorting: DESC by created_at
 *  - Pagination: page/limit/total/pages
 *  - Entity endpoint: user (fields, 404)
 *  - Entity endpoint: session (fields + transactions, 404)
 *  - Entity endpoint: car (with/without maintenance)
 *  - Entity endpoint: errors (invalid type, invalid id)
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

async function insertTransaction(
  page: import('@playwright/test').Page,
  data: {
    user_id: number;
    type: string;
    amount: number;
    balance_after: number;
    description?: string;
    reference_id?: string;
  },
): Promise<{ id: number }> {
  const res = await page.request.post('/api/dev/transactions/insert', { data });
  expect(res.status(), `insertTransaction failed: ${await res.text()}`).toBe(200);
  const body = await res.json();
  return body.transaction;
}

async function insertRentalSession(
  page: import('@playwright/test').Page,
  data: {
    user_id: number;
    car_id: number;
    car_name?: string;
    duration_seconds?: number;
    cost?: number;
    session_ref?: string;
  },
): Promise<{ id: number }> {
  const res = await page.request.post('/api/dev/rental-sessions/insert', { data });
  expect(res.status(), `insertRentalSession failed: ${await res.text()}`).toBe(200);
  const body = await res.json();
  return body.session;
}

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

async function toggleMaintenance(
  page: import('@playwright/test').Page,
  carId: number,
  enabled: boolean,
  reason?: string,
): Promise<import('@playwright/test').APIResponse> {
  const csrfToken = await getCsrfToken(page);
  const body: Record<string, unknown> = { enabled };
  if (reason !== undefined) body.reason = reason;
  return page.request.post(`/api/admin/cars/${carId}/maintenance`, {
    data: body,
    headers: { 'X-CSRF-Token': csrfToken },
  });
}

// ---------------------------------------------------------------------------
// Access control — timeline
// ---------------------------------------------------------------------------

test.describe('GET /api/admin/investigation/timeline — access control', () => {
  test('unauthenticated request returns 401', async ({ page }) => {
    await resetDb(page);
    const res = await page.request.get('/api/admin/investigation/timeline?user_id=1');
    expect(res.status()).toBe(401);
  });

  test('moderator cannot access timeline (403)', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'invtlmod1', 'invtlmod1@test.com');
    await activateUser(page, 'invtlmod1');
    await setUserRole(page, 'invtlmod1', 'moderator');
    await loginUser(page, 'invtlmod1');

    const res = await page.request.get('/api/admin/investigation/timeline?user_id=1');
    expect(res.status()).toBe(403);
  });

  test('admin can access timeline with valid filter (200)', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'invtladmin1', 'invtladmin1@test.com');
    await activateUser(page, 'invtladmin1');
    await setUserRole(page, 'invtladmin1', 'admin');
    await loginUser(page, 'invtladmin1');

    const res = await page.request.get(`/api/admin/investigation/timeline?user_id=${admin.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('items');
    expect(body).toHaveProperty('pagination');
    expect(Array.isArray(body.items)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Access control — entity endpoint
// ---------------------------------------------------------------------------

test.describe('GET /api/admin/investigation/entity/:type/:id — access control', () => {
  test('unauthenticated request returns 401', async ({ page }) => {
    await resetDb(page);
    const res = await page.request.get('/api/admin/investigation/entity/user/1');
    expect(res.status()).toBe(401);
  });

  test('plain user cannot access entity endpoint (403)', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'inventplain1', 'inventplain1@test.com');
    await activateUser(page, 'inventplain1');
    await loginUser(page, 'inventplain1');

    const res = await page.request.get(`/api/admin/investigation/entity/user/${user.id}`);
    expect(res.status()).toBe(403);
  });

  test('moderator can access entity endpoint (200)', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'inventmod1', 'inventmod1@test.com');
    await activateUser(page, 'inventmod1');
    await setUserRole(page, 'inventmod1', 'moderator');
    await loginUser(page, 'inventmod1');

    const res = await page.request.get(`/api/admin/investigation/entity/user/${user.id}`);
    expect(res.status()).toBe(200);
  });

  test('admin can access entity endpoint (200)', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'inventadmin0', 'inventadmin0@test.com');
    await activateUser(page, 'inventadmin0');
    await setUserRole(page, 'inventadmin0', 'admin');
    await loginUser(page, 'inventadmin0');

    const res = await page.request.get(`/api/admin/investigation/entity/user/${admin.id}`);
    expect(res.status()).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Validation — timeline
// ---------------------------------------------------------------------------

test.describe('GET /api/admin/investigation/timeline — validation', () => {
  test('no filters returns 400 with filter requirement error', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'invval1', 'invval1@test.com');
    await activateUser(page, 'invval1');
    await setUserRole(page, 'invval1', 'admin');
    await loginUser(page, 'invval1');

    const res = await page.request.get('/api/admin/investigation/timeline');
    expect(res.status()).toBe(400);
    const body = await res.json();
    // The API returns a Russian error message requiring at least one filter
    expect(body.error).toMatch(/фильтр/i);
  });

  test('invalid user_id "abc" returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'invval2', 'invval2@test.com');
    await activateUser(page, 'invval2');
    await setUserRole(page, 'invval2', 'admin');
    await loginUser(page, 'invval2');

    const res = await page.request.get('/api/admin/investigation/timeline?user_id=abc');
    expect(res.status()).toBe(400);
  });

  test('invalid user_id "-1" returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'invval3', 'invval3@test.com');
    await activateUser(page, 'invval3');
    await setUserRole(page, 'invval3', 'admin');
    await loginUser(page, 'invval3');

    const res = await page.request.get('/api/admin/investigation/timeline?user_id=-1');
    expect(res.status()).toBe(400);
  });

  test('invalid user_id "0" returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'invval4', 'invval4@test.com');
    await activateUser(page, 'invval4');
    await setUserRole(page, 'invval4', 'admin');
    await loginUser(page, 'invval4');

    const res = await page.request.get('/api/admin/investigation/timeline?user_id=0');
    expect(res.status()).toBe(400);
  });

  test('invalid car_id "abc" returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'invval5', 'invval5@test.com');
    await activateUser(page, 'invval5');
    await setUserRole(page, 'invval5', 'admin');
    await loginUser(page, 'invval5');

    const res = await page.request.get('/api/admin/investigation/timeline?car_id=abc');
    expect(res.status()).toBe(400);
  });

  test('invalid car_id "-1" returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'invval6', 'invval6@test.com');
    await activateUser(page, 'invval6');
    await setUserRole(page, 'invval6', 'admin');
    await loginUser(page, 'invval6');

    const res = await page.request.get('/api/admin/investigation/timeline?car_id=-1');
    expect(res.status()).toBe(400);
  });

  test('invalid car_id "0" returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'invval7', 'invval7@test.com');
    await activateUser(page, 'invval7');
    await setUserRole(page, 'invval7', 'admin');
    await loginUser(page, 'invval7');

    const res = await page.request.get('/api/admin/investigation/timeline?car_id=0');
    expect(res.status()).toBe(400);
  });

  test('invalid date_from format returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'invval8', 'invval8@test.com');
    await activateUser(page, 'invval8');
    await setUserRole(page, 'invval8', 'admin');
    await loginUser(page, 'invval8');

    const res = await page.request.get('/api/admin/investigation/timeline?date_from=not-a-date');
    expect(res.status()).toBe(400);
  });

  test('invalid page "0" returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'invval9', 'invval9@test.com');
    await activateUser(page, 'invval9');
    await setUserRole(page, 'invval9', 'admin');
    await loginUser(page, 'invval9');

    const res = await page.request.get('/api/admin/investigation/timeline?user_id=1&page=0');
    expect(res.status()).toBe(400);
  });

  test('invalid page "-1" returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'invval10', 'invval10@test.com');
    await activateUser(page, 'invval10');
    await setUserRole(page, 'invval10', 'admin');
    await loginUser(page, 'invval10');

    const res = await page.request.get('/api/admin/investigation/timeline?user_id=1&page=-1');
    expect(res.status()).toBe(400);
  });

  test('invalid page "abc" returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'invval11', 'invval11@test.com');
    await activateUser(page, 'invval11');
    await setUserRole(page, 'invval11', 'admin');
    await loginUser(page, 'invval11');

    const res = await page.request.get('/api/admin/investigation/timeline?user_id=1&page=abc');
    expect(res.status()).toBe(400);
  });

  test('invalid limit "0" returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'invval12', 'invval12@test.com');
    await activateUser(page, 'invval12');
    await setUserRole(page, 'invval12', 'admin');
    await loginUser(page, 'invval12');

    const res = await page.request.get('/api/admin/investigation/timeline?user_id=1&limit=0');
    expect(res.status()).toBe(400);
  });

  test('invalid limit "101" returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'invval13', 'invval13@test.com');
    await activateUser(page, 'invval13');
    await setUserRole(page, 'invval13', 'admin');
    await loginUser(page, 'invval13');

    const res = await page.request.get('/api/admin/investigation/timeline?user_id=1&limit=101');
    expect(res.status()).toBe(400);
  });

  test('invalid limit "abc" returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'invval14', 'invval14@test.com');
    await activateUser(page, 'invval14');
    await setUserRole(page, 'invval14', 'admin');
    await loginUser(page, 'invval14');

    const res = await page.request.get('/api/admin/investigation/timeline?user_id=1&limit=abc');
    expect(res.status()).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Timeline data — source: transaction
// ---------------------------------------------------------------------------

test.describe('Timeline data — source: transaction', () => {
  test('user_id filter returns transaction events with correct shape', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'invtx1user', 'invtx1user@test.com');
    await activateUser(page, 'invtx1user');
    await registerUser(page, 'invtx1admin', 'invtx1admin@test.com');
    await activateUser(page, 'invtx1admin');
    await setUserRole(page, 'invtx1admin', 'admin');
    await loginUser(page, 'invtx1admin');

    await insertTransaction(page, {
      user_id: user.id,
      type: 'topup',
      amount: 100,
      balance_after: 300,
      description: 'Test top-up',
    });

    const res = await page.request.get(`/api/admin/investigation/timeline?user_id=${user.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const txItems = body.items.filter((i: { source: string }) => i.source === 'transaction');
    expect(txItems.length).toBeGreaterThanOrEqual(1);

    const tx = txItems[0];
    expect(tx).toHaveProperty('source', 'transaction');
    expect(tx).toHaveProperty('id');
    expect(tx).toHaveProperty('created_at');
    expect(typeof tx.summary).toBe('string');
    expect(tx.summary.length).toBeGreaterThan(0);
    expect(tx).toHaveProperty('details');
    expect(typeof tx.details).toBe('object');
    expect(tx.details).toHaveProperty('user_id', user.id);
    expect(tx.details).toHaveProperty('type', 'topup');
    expect(tx.details).toHaveProperty('amount', 100);
    expect(tx.details).toHaveProperty('balance_after');
  });
});

// ---------------------------------------------------------------------------
// Timeline data — source: session
// ---------------------------------------------------------------------------

test.describe('Timeline data — source: session', () => {
  test('user_id filter returns session events with correct shape', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'invsess1user', 'invsess1user@test.com');
    await activateUser(page, 'invsess1user');
    await registerUser(page, 'invsess1admin', 'invsess1admin@test.com');
    await activateUser(page, 'invsess1admin');
    await setUserRole(page, 'invsess1admin', 'admin');
    await loginUser(page, 'invsess1admin');

    await insertRentalSession(page, {
      user_id: user.id,
      car_id: 1,
      car_name: 'Test Car',
      duration_seconds: 120,
      cost: 50,
    });

    const res = await page.request.get(`/api/admin/investigation/timeline?user_id=${user.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const sessionItems = body.items.filter((i: { source: string }) => i.source === 'session');
    expect(sessionItems.length).toBeGreaterThanOrEqual(1);

    const s = sessionItems[0];
    expect(s).toHaveProperty('source', 'session');
    expect(s).toHaveProperty('id');
    expect(s).toHaveProperty('created_at');
    expect(typeof s.summary).toBe('string');
    expect(s.details).toHaveProperty('user_id', user.id);
    expect(s.details).toHaveProperty('car_id', 1);
    expect(s.details).toHaveProperty('duration_seconds', 120);
    expect(s.details).toHaveProperty('cost', 50);
  });
});

// ---------------------------------------------------------------------------
// Timeline data — source: audit
// ---------------------------------------------------------------------------

test.describe('Timeline data — source: audit', () => {
  test('user_id filter returns audit events with correct shape', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'invaud1user', 'invaud1user@test.com');
    await activateUser(page, 'invaud1user');
    await registerUser(page, 'invaud1admin', 'invaud1admin@test.com');
    await activateUser(page, 'invaud1admin');
    await setUserRole(page, 'invaud1admin', 'admin');
    await loginUser(page, 'invaud1admin');

    await writeAuditEntry(page, 'ban_user', 'user', user.id, { reason: 'test ban' });

    const res = await page.request.get(`/api/admin/investigation/timeline?user_id=${user.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const auditItems = body.items.filter((i: { source: string }) => i.source === 'audit');
    expect(auditItems.length).toBeGreaterThanOrEqual(1);

    const a = auditItems[0];
    expect(a).toHaveProperty('source', 'audit');
    expect(a).toHaveProperty('id');
    expect(a).toHaveProperty('created_at');
    expect(typeof a.summary).toBe('string');
    expect(a.details).toHaveProperty('action', 'ban_user');
    expect(a.details).toHaveProperty('target_id', user.id);
    expect(a.details).toHaveProperty('target_type', 'user');
    expect(a.details).toHaveProperty('admin_id');
  });
});

// ---------------------------------------------------------------------------
// Timeline data — source: maintenance
// ---------------------------------------------------------------------------

test.describe('Timeline data — source: maintenance', () => {
  test('car_id filter returns maintenance events with correct shape', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'invmaint1admin', 'invmaint1admin@test.com');
    await activateUser(page, 'invmaint1admin');
    await setUserRole(page, 'invmaint1admin', 'admin');
    await loginUser(page, 'invmaint1admin');

    const maintRes = await toggleMaintenance(page, 1, true, 'Routine inspection');
    expect(maintRes.status()).toBe(200);

    const res = await page.request.get('/api/admin/investigation/timeline?car_id=1');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const maintItems = body.items.filter((i: { source: string }) => i.source === 'maintenance');
    expect(maintItems.length).toBeGreaterThanOrEqual(1);

    const m = maintItems[0];
    expect(m).toHaveProperty('source', 'maintenance');
    expect(m).toHaveProperty('created_at');
    expect(typeof m.summary).toBe('string');
    expect(m.details).toHaveProperty('car_id', 1);
    expect(m.details).toHaveProperty('enabled', 1);
    expect(m.details).toHaveProperty('reason', 'Routine inspection');
    expect(m.details).toHaveProperty('admin_id');
  });
});

// ---------------------------------------------------------------------------
// Timeline data — every event has required fields
// ---------------------------------------------------------------------------

test('every timeline event has required fields (source, id, created_at, summary, details)', async ({ page }) => {
  await resetDb(page);
  const user = await registerUser(page, 'invshape1user', 'invshape1user@test.com');
  await activateUser(page, 'invshape1user');
  await registerUser(page, 'invshape1admin', 'invshape1admin@test.com');
  await activateUser(page, 'invshape1admin');
  await setUserRole(page, 'invshape1admin', 'admin');
  await loginUser(page, 'invshape1admin');

  await insertTransaction(page, {
    user_id: user.id,
    type: 'topup',
    amount: 50,
    balance_after: 250,
  });

  const res = await page.request.get(`/api/admin/investigation/timeline?user_id=${user.id}`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  for (const item of body.items) {
    expect(item).toHaveProperty('source');
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('created_at');
    expect(typeof item.summary).toBe('string');
    expect(item).toHaveProperty('details');
    expect(typeof item.details).toBe('object');
  }
});

// ---------------------------------------------------------------------------
// Filtering — user_id only returns events for that user
// ---------------------------------------------------------------------------

test('user_id filter returns only events for that user', async ({ page }) => {
  await resetDb(page);
  const user1 = await registerUser(page, 'invfilt1u1', 'invfilt1u1@test.com');
  await activateUser(page, 'invfilt1u1');
  const user2 = await registerUser(page, 'invfilt1u2', 'invfilt1u2@test.com');
  await activateUser(page, 'invfilt1u2');
  await registerUser(page, 'invfilt1adm', 'invfilt1adm@test.com');
  await activateUser(page, 'invfilt1adm');
  await setUserRole(page, 'invfilt1adm', 'admin');
  await loginUser(page, 'invfilt1adm');

  await insertTransaction(page, { user_id: user1.id, type: 'topup', amount: 10, balance_after: 210 });
  await insertTransaction(page, { user_id: user2.id, type: 'topup', amount: 20, balance_after: 220 });

  const res = await page.request.get(`/api/admin/investigation/timeline?user_id=${user1.id}`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  for (const item of body.items) {
    if (item.source === 'transaction') {
      expect(item.details.user_id).toBe(user1.id);
    }
    if (item.source === 'session') {
      expect(item.details.user_id).toBe(user1.id);
    }
  }
});

// ---------------------------------------------------------------------------
// Filtering — car_id returns sessions + maintenance for that car
// ---------------------------------------------------------------------------

test('car_id filter returns sessions and maintenance for that car', async ({ page }) => {
  await resetDb(page);
  const user = await registerUser(page, 'invfilt2user', 'invfilt2user@test.com');
  await activateUser(page, 'invfilt2user');
  await registerUser(page, 'invfilt2adm', 'invfilt2adm@test.com');
  await activateUser(page, 'invfilt2adm');
  await setUserRole(page, 'invfilt2adm', 'admin');
  await loginUser(page, 'invfilt2adm');

  await insertRentalSession(page, { user_id: user.id, car_id: 2, car_name: 'Car2', duration_seconds: 60, cost: 10 });
  await toggleMaintenance(page, 2, true, 'Filter test');

  const res = await page.request.get('/api/admin/investigation/timeline?car_id=2');
  expect(res.status()).toBe(200);
  const body = await res.json();
  const sources = new Set(body.items.map((i: { source: string }) => i.source));
  expect(sources.has('session') || sources.has('maintenance')).toBe(true);
  for (const item of body.items) {
    if (item.source === 'session') expect(item.details.car_id).toBe(2);
    if (item.source === 'maintenance') expect(item.details.car_id).toBe(2);
  }
});

// ---------------------------------------------------------------------------
// Filtering — reference_id
// ---------------------------------------------------------------------------

test('reference_id filter returns matching transactions and sessions', async ({ page }) => {
  await resetDb(page);
  const user = await registerUser(page, 'invfilt3user', 'invfilt3user@test.com');
  await activateUser(page, 'invfilt3user');
  await registerUser(page, 'invfilt3adm', 'invfilt3adm@test.com');
  await activateUser(page, 'invfilt3adm');
  await setUserRole(page, 'invfilt3adm', 'admin');
  await loginUser(page, 'invfilt3adm');

  const ref = `ref-${Date.now()}`;
  await insertTransaction(page, { user_id: user.id, type: 'hold', amount: -30, balance_after: 170, reference_id: ref });
  await insertRentalSession(page, { user_id: user.id, car_id: 1, duration_seconds: 60, cost: 30, session_ref: ref });

  const res = await page.request.get(`/api/admin/investigation/timeline?reference_id=${ref}`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.items.length).toBeGreaterThanOrEqual(1);
  for (const item of body.items) {
    if (item.source === 'transaction') expect(item.details.reference_id).toBe(ref);
    if (item.source === 'session') expect(item.details.session_ref).toBe(ref);
  }
});

// ---------------------------------------------------------------------------
// Filtering — date range
// ---------------------------------------------------------------------------

test('date_from + date_to range filters events correctly', async ({ page }) => {
  await resetDb(page);
  const user = await registerUser(page, 'invdate1user', 'invdate1user@test.com');
  await activateUser(page, 'invdate1user');
  await registerUser(page, 'invdate1adm', 'invdate1adm@test.com');
  await activateUser(page, 'invdate1adm');
  await setUserRole(page, 'invdate1adm', 'admin');
  await loginUser(page, 'invdate1adm');

  await insertTransaction(page, { user_id: user.id, type: 'topup', amount: 10, balance_after: 210 });

  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const res = await page.request.get(
    `/api/admin/investigation/timeline?user_id=${user.id}&date_from=${today}&date_to=${tomorrow}`,
  );
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.items.length).toBeGreaterThanOrEqual(1);
  for (const item of body.items) {
    expect(new Date(item.created_at).getTime()).toBeGreaterThanOrEqual(new Date(today).getTime());
  }
});

// ---------------------------------------------------------------------------
// Filtering — combined user_id + date_from
// ---------------------------------------------------------------------------

test('combined user_id + date_from narrows results to that user', async ({ page }) => {
  await resetDb(page);
  const user = await registerUser(page, 'invcomb1user', 'invcomb1user@test.com');
  await activateUser(page, 'invcomb1user');
  await registerUser(page, 'invcomb1adm', 'invcomb1adm@test.com');
  await activateUser(page, 'invcomb1adm');
  await setUserRole(page, 'invcomb1adm', 'admin');
  await loginUser(page, 'invcomb1adm');

  await insertTransaction(page, { user_id: user.id, type: 'topup', amount: 10, balance_after: 210 });

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const res = await page.request.get(
    `/api/admin/investigation/timeline?user_id=${user.id}&date_from=${yesterday}`,
  );
  expect(res.status()).toBe(200);
  const body = await res.json();
  for (const item of body.items) {
    if (item.source === 'transaction') expect(item.details.user_id).toBe(user.id);
    if (item.source === 'session') expect(item.details.user_id).toBe(user.id);
  }
});

// ---------------------------------------------------------------------------
// Sorting — DESC by created_at
// ---------------------------------------------------------------------------

test('timeline events are sorted DESC by created_at', async ({ page }) => {
  await resetDb(page);
  const user = await registerUser(page, 'invsort1user', 'invsort1user@test.com');
  await activateUser(page, 'invsort1user');
  await registerUser(page, 'invsort1adm', 'invsort1adm@test.com');
  await activateUser(page, 'invsort1adm');
  await setUserRole(page, 'invsort1adm', 'admin');
  await loginUser(page, 'invsort1adm');

  for (let i = 0; i < 3; i++) {
    await insertTransaction(page, { user_id: user.id, type: 'topup', amount: 10 + i, balance_after: 200 + i });
  }

  const res = await page.request.get(`/api/admin/investigation/timeline?user_id=${user.id}`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  const dates = body.items.map((i: { created_at: string }) => i.created_at);
  for (let i = 0; i < dates.length - 1; i++) {
    expect(dates[i] >= dates[i + 1]).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test.describe('Pagination', () => {
  test('page=1&limit=2 returns exactly 2 items', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'invpag1user', 'invpag1user@test.com');
    await activateUser(page, 'invpag1user');
    await registerUser(page, 'invpag1adm', 'invpag1adm@test.com');
    await activateUser(page, 'invpag1adm');
    await setUserRole(page, 'invpag1adm', 'admin');
    await loginUser(page, 'invpag1adm');

    for (let i = 0; i < 5; i++) {
      await insertTransaction(page, { user_id: user.id, type: 'topup', amount: 10 + i, balance_after: 200 + i });
    }

    const res = await page.request.get(`/api/admin/investigation/timeline?user_id=${user.id}&page=1&limit=2`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(2);
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(2);
  });

  test('page=2 returns a different set of items than page=1', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'invpag2user', 'invpag2user@test.com');
    await activateUser(page, 'invpag2user');
    await registerUser(page, 'invpag2adm', 'invpag2adm@test.com');
    await activateUser(page, 'invpag2adm');
    await setUserRole(page, 'invpag2adm', 'admin');
    await loginUser(page, 'invpag2adm');

    for (let i = 0; i < 5; i++) {
      await insertTransaction(page, { user_id: user.id, type: 'topup', amount: 10 + i, balance_after: 200 + i });
    }

    const res1 = await page.request.get(`/api/admin/investigation/timeline?user_id=${user.id}&page=1&limit=2`);
    const body1 = await res1.json();
    const res2 = await page.request.get(`/api/admin/investigation/timeline?user_id=${user.id}&page=2&limit=2`);
    expect(res2.status()).toBe(200);
    const body2 = await res2.json();

    const ids1 = new Set(body1.items.map((i: { source: string; id: number }) => `${i.source}-${i.id}`));
    const ids2 = body2.items.map((i: { source: string; id: number }) => `${i.source}-${i.id}`);
    for (const id of ids2) {
      expect(ids1.has(id)).toBe(false);
    }
  });

  test('pagination object has correct shape and totals', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'invpag3user', 'invpag3user@test.com');
    await activateUser(page, 'invpag3user');
    await registerUser(page, 'invpag3adm', 'invpag3adm@test.com');
    await activateUser(page, 'invpag3adm');
    await setUserRole(page, 'invpag3adm', 'admin');
    await loginUser(page, 'invpag3adm');

    for (let i = 0; i < 5; i++) {
      await insertTransaction(page, { user_id: user.id, type: 'topup', amount: 10 + i, balance_after: 200 + i });
    }

    const res = await page.request.get(`/api/admin/investigation/timeline?user_id=${user.id}&page=1&limit=2`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.pagination).toHaveProperty('page', 1);
    expect(body.pagination).toHaveProperty('limit', 2);
    expect(typeof body.pagination.total).toBe('number');
    expect(typeof body.pagination.pages).toBe('number');
    expect(body.pagination.total).toBeGreaterThanOrEqual(5);
    expect(body.pagination.pages).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Entity endpoint — user
// ---------------------------------------------------------------------------

test.describe('Entity endpoint — user', () => {
  test('returns type=user with entity fields', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'inventuser1', 'inventuser1@test.com');
    await activateUser(page, 'inventuser1');
    await registerUser(page, 'inventuadm1', 'inventuadm1@test.com');
    await activateUser(page, 'inventuadm1');
    await setUserRole(page, 'inventuadm1', 'admin');
    await loginUser(page, 'inventuadm1');

    const res = await page.request.get(`/api/admin/investigation/entity/user/${user.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('type', 'user');
    expect(body).toHaveProperty('entity');
    const e = body.entity;
    expect(e).toHaveProperty('id', user.id);
    expect(e).toHaveProperty('username', 'inventuser1');
    expect(e).toHaveProperty('email');
    expect(e).toHaveProperty('status');
    expect(e).toHaveProperty('role');
    expect(e).toHaveProperty('balance');
    expect(e).toHaveProperty('created_at');
  });

  test('nonexistent user id returns 404', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'inventuadm2', 'inventuadm2@test.com');
    await activateUser(page, 'inventuadm2');
    await setUserRole(page, 'inventuadm2', 'admin');
    await loginUser(page, 'inventuadm2');

    const res = await page.request.get('/api/admin/investigation/entity/user/99999');
    expect(res.status()).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Entity endpoint — session
// ---------------------------------------------------------------------------

test.describe('Entity endpoint — session', () => {
  test('returns type=session with entity and related transactions', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'inventsess1', 'inventsess1@test.com');
    await activateUser(page, 'inventsess1');
    await registerUser(page, 'inventsadm1', 'inventsadm1@test.com');
    await activateUser(page, 'inventsadm1');
    await setUserRole(page, 'inventsadm1', 'admin');
    await loginUser(page, 'inventsadm1');

    const sessionRef = `sess-ref-${Date.now()}`;
    const session = await insertRentalSession(page, {
      user_id: user.id,
      car_id: 1,
      car_name: 'Test Car',
      duration_seconds: 180,
      cost: 30,
      session_ref: sessionRef,
    });
    await insertTransaction(page, {
      user_id: user.id,
      type: 'deduct',
      amount: -30,
      balance_after: 170,
      reference_id: sessionRef,
    });

    const res = await page.request.get(`/api/admin/investigation/entity/session/${session.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('type', 'session');
    expect(body).toHaveProperty('entity');
    expect(body).toHaveProperty('transactions');
    const e = body.entity;
    expect(e).toHaveProperty('id', session.id);
    expect(e).toHaveProperty('user_id', user.id);
    expect(e).toHaveProperty('car_id', 1);
    expect(e).toHaveProperty('duration_seconds', 180);
    expect(e).toHaveProperty('cost', 30);
    expect(e).toHaveProperty('session_ref', sessionRef);
    expect(Array.isArray(body.transactions)).toBe(true);
    expect(body.transactions.length).toBeGreaterThanOrEqual(1);
    body.transactions.forEach((tx: { reference_id: string }) => {
      expect(tx.reference_id).toBe(sessionRef);
    });
  });

  test('nonexistent session id returns 404', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'inventsadm2', 'inventsadm2@test.com');
    await activateUser(page, 'inventsadm2');
    await setUserRole(page, 'inventsadm2', 'admin');
    await loginUser(page, 'inventsadm2');

    const res = await page.request.get('/api/admin/investigation/entity/session/99999');
    expect(res.status()).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Entity endpoint — car
// ---------------------------------------------------------------------------

test.describe('Entity endpoint — car', () => {
  test('returns type=car with entity fields including maintenance', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'inventcadm1', 'inventcadm1@test.com');
    await activateUser(page, 'inventcadm1');
    await setUserRole(page, 'inventcadm1', 'admin');
    await loginUser(page, 'inventcadm1');

    const maintRes = await toggleMaintenance(page, 2, true, 'Oil change');
    expect(maintRes.status()).toBe(200);

    const res = await page.request.get('/api/admin/investigation/entity/car/2');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('type', 'car');
    expect(body).toHaveProperty('entity');
    const e = body.entity;
    expect(e).toHaveProperty('car_id', 2);
    expect(e).toHaveProperty('maintenance');
    expect(e).toHaveProperty('recent_sessions_count');
    expect(typeof e.recent_sessions_count).toBe('number');
    expect(e.maintenance).not.toBeNull();
    expect(e.maintenance).toHaveProperty('car_id', 2);
    expect(e.maintenance).toHaveProperty('enabled');
    expect(e.maintenance).toHaveProperty('reason', 'Oil change');
  });

  test('car with no maintenance record returns maintenance as null', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'inventcadm2', 'inventcadm2@test.com');
    await activateUser(page, 'inventcadm2');
    await setUserRole(page, 'inventcadm2', 'admin');
    await loginUser(page, 'inventcadm2');

    // Car 3 has no maintenance after DB reset
    const res = await page.request.get('/api/admin/investigation/entity/car/3');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('type', 'car');
    expect(body.entity).toHaveProperty('car_id', 3);
    expect(body.entity.maintenance).toBeNull();
    expect(typeof body.entity.recent_sessions_count).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Entity endpoint — error cases
// ---------------------------------------------------------------------------

test.describe('Entity endpoint — error cases', () => {
  test('unknown entity type returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'inventerr1', 'inventerr1@test.com');
    await activateUser(page, 'inventerr1');
    await setUserRole(page, 'inventerr1', 'admin');
    await loginUser(page, 'inventerr1');

    const res = await page.request.get('/api/admin/investigation/entity/unknown/1');
    expect(res.status()).toBe(400);
  });

  test('invalid id "abc" returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'inventerr2', 'inventerr2@test.com');
    await activateUser(page, 'inventerr2');
    await setUserRole(page, 'inventerr2', 'admin');
    await loginUser(page, 'inventerr2');

    const res = await page.request.get('/api/admin/investigation/entity/user/abc');
    expect(res.status()).toBe(400);
  });

  test('invalid id "0" returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'inventerr3', 'inventerr3@test.com');
    await activateUser(page, 'inventerr3');
    await setUserRole(page, 'inventerr3', 'admin');
    await loginUser(page, 'inventerr3');

    const res = await page.request.get('/api/admin/investigation/entity/user/0');
    expect(res.status()).toBe(400);
  });
});
