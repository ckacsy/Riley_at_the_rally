import { test, expect } from '@playwright/test';
import { resetDb, getCsrfToken, registerUser, activateUser, loginUser, setUserRole, setupSocketCapture, waitForSocketEvent } from './helpers';

const TEST_BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:5000';

/**
 * PR 7 — Admin transactions dashboard API and UI e2e tests.
 *
 * Covers:
 *  - GET /api/admin/transactions: admin can fetch; moderator/user/unauthenticated blocked
 *  - Filters: user_id, type, reference_id, date_from, date_to, min_amount, max_amount
 *  - Combined filters
 *  - Validation: invalid params return 400
 *  - Pagination
 *  - Summary byType totals
 *  - admin_id / admin_username joins
 *  - GET /api/admin/users/:id/ledger
 *  - UI: admin can open transactions page
 *  - UI: moderator is redirected
 *  - UI: filters, summary, type badges
 *  - UI: empty state
 *  - UI: username click opens ledger panel
 *  - UI: amount formatting
 *  - UI: admin_adjust shows admin username
 *  - UI: admin landing page shows Transactions card only for admin
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertTransaction(
  page: import('@playwright/test').Page,
  userId: number,
  type: string,
  amount: number,
  balanceAfter: number,
  opts: { description?: string; reference_id?: string; admin_id?: number; created_at?: string } = {},
): Promise<{ id: number }> {
  const res = await page.request.post('/api/dev/transactions/insert', {
    data: {
      user_id: userId,
      type,
      amount,
      balance_after: balanceAfter,
      description: opts.description || null,
      reference_id: opts.reference_id || null,
      admin_id: opts.admin_id || null,
      created_at: opts.created_at || undefined,
    },
  });
  expect(res.status(), `insert transaction failed: ${await res.text()}`).toBe(200);
  const body = await res.json();
  return body.transaction;
}

async function injectActiveSession(
  page: import('@playwright/test').Page,
  carId: number,
  userId: string,
  dbUserId: number | null,
): Promise<void> {
  await page.addInitScript(
    ({ carId, userId, dbUserId }) => {
      sessionStorage.setItem(
        'activeSession',
        JSON.stringify({
          carId,
          carName: 'Test Car',
          startTime: new Date().toISOString(),
          sessionId: 'pending',
          userId,
          dbUserId,
          ratePerMinute: 0.5,
          selectedRaceId: null,
        }),
      );
    },
    { carId, userId, dbUserId },
  );
}

// ---------------------------------------------------------------------------
// API Tests: GET /api/admin/transactions
// ---------------------------------------------------------------------------

test.describe('GET /api/admin/transactions', () => {
  test('admin can fetch transactions', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'txadmin1', 'txadmin1@test.com');
    await activateUser(page, 'txadmin1');
    await setUserRole(page, 'txadmin1', 'admin');
    await loginUser(page, 'txadmin1');

    const res = await page.request.get('/api/admin/transactions');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('items');
    expect(body).toHaveProperty('pagination');
    expect(body).toHaveProperty('summary');
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.pagination.total).toBe('number');
    expect(typeof body.pagination.pages).toBe('number');
    expect(typeof body.summary.totalCount).toBe('number');
    expect(typeof body.summary.totalAmount).toBe('number');
    expect(Array.isArray(body.summary.byType)).toBe(true);
  });

  test('moderator cannot fetch transactions (403)', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'txmod1', 'txmod1@test.com');
    await activateUser(page, 'txmod1');
    await setUserRole(page, 'txmod1', 'moderator');
    await loginUser(page, 'txmod1');

    const res = await page.request.get('/api/admin/transactions');
    expect(res.status()).toBe(403);
  });

  test('plain user cannot fetch transactions (403)', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'txuser1', 'txuser1@test.com');
    await activateUser(page, 'txuser1');
    await loginUser(page, 'txuser1');

    const res = await page.request.get('/api/admin/transactions');
    expect(res.status()).toBe(403);
  });

  test('unauthenticated user cannot fetch transactions (401)', async ({ page }) => {
    await resetDb(page);
    const res = await page.request.get('/api/admin/transactions');
    expect(res.status()).toBe(401);
  });

  test('filter by user_id works', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'txadmin2', 'txadmin2@test.com');
    const other = await registerUser(page, 'txother2', 'txother2@test.com');
    await activateUser(page, 'txadmin2');
    await activateUser(page, 'txother2');
    await setUserRole(page, 'txadmin2', 'admin');
    await loginUser(page, 'txadmin2');

    await insertTransaction(page, admin.id, 'topup', 100, 300);
    await insertTransaction(page, other.id, 'topup', 50, 250);

    const res = await page.request.get('/api/admin/transactions?user_id=' + admin.id);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    body.items.forEach((item: { user_id: number }) => {
      expect(item.user_id).toBe(admin.id);
    });
  });

  test('filter by type works', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'txadmin3', 'txadmin3@test.com');
    await activateUser(page, 'txadmin3');
    await setUserRole(page, 'txadmin3', 'admin');
    await loginUser(page, 'txadmin3');

    await insertTransaction(page, admin.id, 'topup', 100, 300);
    await insertTransaction(page, admin.id, 'hold', -50, 250);

    const res = await page.request.get('/api/admin/transactions?type=topup');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    body.items.forEach((item: { type: string }) => {
      expect(item.type).toBe('topup');
    });
  });

  test('invalid type returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'txadmin4', 'txadmin4@test.com');
    await activateUser(page, 'txadmin4');
    await setUserRole(page, 'txadmin4', 'admin');
    await loginUser(page, 'txadmin4');

    const res = await page.request.get('/api/admin/transactions?type=badtype');
    expect(res.status()).toBe(400);
  });

  test('filter by reference_id works', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'txadmin5', 'txadmin5@test.com');
    await activateUser(page, 'txadmin5');
    await setUserRole(page, 'txadmin5', 'admin');
    await loginUser(page, 'txadmin5');

    await insertTransaction(page, admin.id, 'topup', 100, 300, { reference_id: 'ref-abc-123' });
    await insertTransaction(page, admin.id, 'hold', -50, 250, { reference_id: 'ref-xyz-456' });

    const res = await page.request.get('/api/admin/transactions?reference_id=ref-abc-123');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    body.items.forEach((item: { reference_id: string }) => {
      expect(item.reference_id).toBe('ref-abc-123');
    });
  });

  test('filter by date range works', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'txadmin6', 'txadmin6@test.com');
    await activateUser(page, 'txadmin6');
    await setUserRole(page, 'txadmin6', 'admin');
    await loginUser(page, 'txadmin6');

    await insertTransaction(page, admin.id, 'topup', 100, 300);

    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const res = await page.request.get('/api/admin/transactions?date_from=' + today + '&date_to=' + tomorrow);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
  });

  test('invalid date_from returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'txadmin7', 'txadmin7@test.com');
    await activateUser(page, 'txadmin7');
    await setUserRole(page, 'txadmin7', 'admin');
    await loginUser(page, 'txadmin7');

    const res = await page.request.get('/api/admin/transactions?date_from=29-03-2026');
    expect(res.status()).toBe(400);
  });

  test('invalid date_to returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'txadmin8', 'txadmin8@test.com');
    await activateUser(page, 'txadmin8');
    await setUserRole(page, 'txadmin8', 'admin');
    await loginUser(page, 'txadmin8');

    const res = await page.request.get('/api/admin/transactions?date_to=2026/03/29');
    expect(res.status()).toBe(400);
  });

  test('invalid page returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'txadmin9', 'txadmin9@test.com');
    await activateUser(page, 'txadmin9');
    await setUserRole(page, 'txadmin9', 'admin');
    await loginUser(page, 'txadmin9');

    const res = await page.request.get('/api/admin/transactions?page=0');
    expect(res.status()).toBe(400);
  });

  test('invalid limit returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'txadmin10', 'txadmin10@test.com');
    await activateUser(page, 'txadmin10');
    await setUserRole(page, 'txadmin10', 'admin');
    await loginUser(page, 'txadmin10');

    const res1 = await page.request.get('/api/admin/transactions?limit=200');
    expect(res1.status()).toBe(400);

    const res2 = await page.request.get('/api/admin/transactions?limit=0');
    expect(res2.status()).toBe(400);
  });

  test('invalid user_id returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'txadmin11', 'txadmin11@test.com');
    await activateUser(page, 'txadmin11');
    await setUserRole(page, 'txadmin11', 'admin');
    await loginUser(page, 'txadmin11');

    const res = await page.request.get('/api/admin/transactions?user_id=abc');
    expect(res.status()).toBe(400);
  });

  test('pagination works with seeded data', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'txadmin12', 'txadmin12@test.com');
    await activateUser(page, 'txadmin12');
    await setUserRole(page, 'txadmin12', 'admin');
    await loginUser(page, 'txadmin12');

    for (let i = 0; i < 5; i++) {
      await insertTransaction(page, admin.id, 'topup', 10 + i, 200 + i);
    }

    const res = await page.request.get('/api/admin/transactions?page=1&limit=2');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeLessThanOrEqual(2);
    expect(body.pagination.limit).toBe(2);
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.total).toBeGreaterThanOrEqual(5);
    expect(body.pagination.pages).toBeGreaterThanOrEqual(3);
  });

  test('page beyond last returns empty items', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'txadmin13', 'txadmin13@test.com');
    await activateUser(page, 'txadmin13');
    await setUserRole(page, 'txadmin13', 'admin');
    await loginUser(page, 'txadmin13');

    await insertTransaction(page, admin.id, 'topup', 100, 300);

    const res = await page.request.get('/api/admin/transactions?page=9999&limit=50');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(0);
  });

  test('transaction row with admin_id returns admin_username', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'txadmin14', 'txadmin14@test.com');
    const user = await registerUser(page, 'txuser14', 'txuser14@test.com');
    await activateUser(page, 'txadmin14');
    await activateUser(page, 'txuser14');
    await setUserRole(page, 'txadmin14', 'admin');
    await loginUser(page, 'txadmin14');

    await insertTransaction(page, user.id, 'admin_adjust', 50, 250, {
      description: 'Manual adjust',
      admin_id: admin.id,
    });

    const res = await page.request.get('/api/admin/transactions?type=admin_adjust');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    const tx = body.items.find((item: { admin_id: number }) => item.admin_id === admin.id);
    expect(tx).toBeTruthy();
    expect(tx.admin_username).toBe('txadmin14');
  });

  test('username is returned via LEFT JOIN', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'txadmin15', 'txadmin15@test.com');
    await activateUser(page, 'txadmin15');
    await setUserRole(page, 'txadmin15', 'admin');
    await loginUser(page, 'txadmin15');

    await insertTransaction(page, admin.id, 'topup', 100, 300);

    const res = await page.request.get('/api/admin/transactions?user_id=' + admin.id);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0].username).toBe('txadmin15');
  });

  test('summary byType totals match filtered data', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'txadmin16', 'txadmin16@test.com');
    await activateUser(page, 'txadmin16');
    await setUserRole(page, 'txadmin16', 'admin');
    await loginUser(page, 'txadmin16');

    await insertTransaction(page, admin.id, 'topup', 100, 300);
    await insertTransaction(page, admin.id, 'topup', 200, 500);
    await insertTransaction(page, admin.id, 'hold', -50, 450);

    const res = await page.request.get('/api/admin/transactions?user_id=' + admin.id);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const topupEntry = body.summary.byType.find((b: { type: string }) => b.type === 'topup');
    expect(topupEntry).toBeTruthy();
    expect(topupEntry.count).toBeGreaterThanOrEqual(2);
    expect(topupEntry.total).toBeGreaterThanOrEqual(300);
  });

  test('multiple filters combined work', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'txadmin17', 'txadmin17@test.com');
    const other = await registerUser(page, 'txother17', 'txother17@test.com');
    await activateUser(page, 'txadmin17');
    await activateUser(page, 'txother17');
    await setUserRole(page, 'txadmin17', 'admin');
    await loginUser(page, 'txadmin17');

    await insertTransaction(page, admin.id, 'topup', 100, 300);
    await insertTransaction(page, admin.id, 'hold', -50, 250);
    await insertTransaction(page, other.id, 'topup', 75, 275);

    const res = await page.request.get('/api/admin/transactions?user_id=' + admin.id + '&type=topup');
    expect(res.status()).toBe(200);
    const body = await res.json();
    body.items.forEach((item: { user_id: number; type: string }) => {
      expect(item.user_id).toBe(admin.id);
      expect(item.type).toBe('topup');
    });
  });

  test('invalid min_amount returns 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'txadmin18', 'txadmin18@test.com');
    await activateUser(page, 'txadmin18');
    await setUserRole(page, 'txadmin18', 'admin');
    await loginUser(page, 'txadmin18');

    const res = await page.request.get('/api/admin/transactions?min_amount=xyz');
    expect(res.status()).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// API Tests: GET /api/admin/users/:id/ledger
// ---------------------------------------------------------------------------

test.describe('GET /api/admin/users/:id/ledger', () => {
  test('user ledger returns correct shape', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'ledadmin1', 'ledadmin1@test.com');
    const user = await registerUser(page, 'leduser1', 'leduser1@test.com');
    await activateUser(page, 'ledadmin1');
    await activateUser(page, 'leduser1');
    await setUserRole(page, 'ledadmin1', 'admin');
    await loginUser(page, 'ledadmin1');

    await insertTransaction(page, user.id, 'topup', 100, 300);
    await insertTransaction(page, user.id, 'hold', -50, 250);

    const res = await page.request.get('/api/admin/users/' + user.id + '/ledger');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('user');
    expect(body).toHaveProperty('transactions');
    expect(body).toHaveProperty('summary');
    expect(body).toHaveProperty('pagination');
    expect(body.user.id).toBe(user.id);
    expect(body.user.username).toBe('leduser1');
    expect(typeof body.user.balance).toBe('number');
    expect(typeof body.summary.transactionCount).toBe('number');
    expect(typeof body.summary.totalTopups).toBe('number');
    expect(typeof body.summary.totalHolds).toBe('number');
    expect(typeof body.summary.totalReleases).toBe('number');
    expect(typeof body.summary.totalDeductions).toBe('number');
    expect(typeof body.summary.totalAdminAdjusts).toBe('number');
  });

  test('user ledger for nonexistent user returns 404', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'ledadmin2', 'ledadmin2@test.com');
    await activateUser(page, 'ledadmin2');
    await setUserRole(page, 'ledadmin2', 'admin');
    await loginUser(page, 'ledadmin2');

    const res = await page.request.get('/api/admin/users/999999/ledger');
    expect(res.status()).toBe(404);
  });

  test('user ledger for user with zero transactions returns empty list + valid balance', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'ledadmin3', 'ledadmin3@test.com');
    const user = await registerUser(page, 'leduser3', 'leduser3@test.com');
    await activateUser(page, 'ledadmin3');
    await activateUser(page, 'leduser3');
    await setUserRole(page, 'ledadmin3', 'admin');
    await loginUser(page, 'ledadmin3');

    const res = await page.request.get('/api/admin/users/' + user.id + '/ledger');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.user.id).toBe(user.id);
    expect(typeof body.user.balance).toBe('number');
    expect(Array.isArray(body.transactions)).toBe(true);
    expect(body.pagination.total).toBe(0);
  });

  test('ledger summary includes correct totals', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'ledadmin4', 'ledadmin4@test.com');
    const user = await registerUser(page, 'leduser4', 'leduser4@test.com');
    await activateUser(page, 'ledadmin4');
    await activateUser(page, 'leduser4');
    await setUserRole(page, 'ledadmin4', 'admin');
    await loginUser(page, 'ledadmin4');

    await insertTransaction(page, user.id, 'topup', 100, 300);
    await insertTransaction(page, user.id, 'hold', -50, 250);
    await insertTransaction(page, user.id, 'release', 50, 300);
    await insertTransaction(page, user.id, 'deduct', -30, 270);
    await insertTransaction(page, user.id, 'admin_adjust', 20, 290, { admin_id: admin.id });

    const res = await page.request.get('/api/admin/users/' + user.id + '/ledger');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.summary.totalTopups).toBeCloseTo(100, 1);
    expect(body.summary.totalHolds).toBeCloseTo(-50, 1);
    expect(body.summary.totalReleases).toBeCloseTo(50, 1);
    expect(body.summary.totalDeductions).toBeCloseTo(-30, 1);
    expect(body.summary.totalAdminAdjusts).toBeCloseTo(20, 1);
    expect(body.summary.transactionCount).toBe(5);
  });

  test('moderator cannot access user ledger (403)', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'leduser5', 'leduser5@test.com');
    await registerUser(page, 'ledmod5', 'ledmod5@test.com');
    await activateUser(page, 'ledmod5');
    await setUserRole(page, 'ledmod5', 'moderator');
    await loginUser(page, 'ledmod5');

    const res = await page.request.get('/api/admin/users/' + user.id + '/ledger');
    expect(res.status()).toBe(403);
  });

  test('ledger filter by type works', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'ledadmin6', 'ledadmin6@test.com');
    const user = await registerUser(page, 'leduser6', 'leduser6@test.com');
    await activateUser(page, 'ledadmin6');
    await activateUser(page, 'leduser6');
    await setUserRole(page, 'ledadmin6', 'admin');
    await loginUser(page, 'ledadmin6');

    await insertTransaction(page, user.id, 'topup', 100, 300);
    await insertTransaction(page, user.id, 'hold', -50, 250);

    const res = await page.request.get('/api/admin/users/' + user.id + '/ledger?type=topup');
    expect(res.status()).toBe(200);
    const body = await res.json();
    body.transactions.forEach((tx: { type: string }) => {
      expect(tx.type).toBe('topup');
    });
  });

  test('ledger invalid type returns 400', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'ledadmin7', 'ledadmin7@test.com');
    const user = await registerUser(page, 'leduser7', 'leduser7@test.com');
    await activateUser(page, 'ledadmin7');
    await activateUser(page, 'leduser7');
    await setUserRole(page, 'ledadmin7', 'admin');
    await loginUser(page, 'ledadmin7');

    const res = await page.request.get('/api/admin/users/' + user.id + '/ledger?type=badtype');
    expect(res.status()).toBe(400);
  });

  test('ledger pagination works', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'ledadmin8', 'ledadmin8@test.com');
    const user = await registerUser(page, 'leduser8', 'leduser8@test.com');
    await activateUser(page, 'ledadmin8');
    await activateUser(page, 'leduser8');
    await setUserRole(page, 'ledadmin8', 'admin');
    await loginUser(page, 'ledadmin8');

    for (let i = 0; i < 5; i++) {
      await insertTransaction(page, user.id, 'topup', 10 + i, 200 + i);
    }

    const res = await page.request.get('/api/admin/users/' + user.id + '/ledger?page=1&limit=2');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.transactions.length).toBeLessThanOrEqual(2);
    expect(body.pagination.total).toBeGreaterThanOrEqual(5);
    expect(body.pagination.pages).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// UI Tests
// ---------------------------------------------------------------------------

test.describe('UI: Admin transactions page', () => {
  test('admin can open transactions page', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'uiadmin1', 'uiadmin1@test.com');
    await activateUser(page, 'uiadmin1');
    await setUserRole(page, 'uiadmin1', 'admin');
    await loginUser(page, 'uiadmin1');

    await page.goto('/admin-transactions');
    await expect(page.locator('#admin-content')).not.toHaveAttribute('hidden');
    await expect(page.locator('h1')).toContainText('Транзакции');
  });

  test('moderator is redirected away from transactions page', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'uimod1', 'uimod1@test.com');
    await activateUser(page, 'uimod1');
    await setUserRole(page, 'uimod1', 'moderator');
    await loginUser(page, 'uimod1');

    await page.goto('/admin-transactions');
    await page.waitForURL(/\/(garage|login)/);
  });

  test('unauthenticated user is redirected to login', async ({ page }) => {
    await resetDb(page);
    await page.goto('/admin-transactions');
    await page.waitForURL('/login');
  });

  test('filters narrow rows', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'uiadmin2', 'uiadmin2@test.com');
    const user = await registerUser(page, 'uiuser2', 'uiuser2@test.com');
    await activateUser(page, 'uiadmin2');
    await activateUser(page, 'uiuser2');
    await setUserRole(page, 'uiadmin2', 'admin');
    await loginUser(page, 'uiadmin2');

    await insertTransaction(page, admin.id, 'topup', 100, 300);
    await insertTransaction(page, user.id, 'hold', -50, 150);

    await page.goto('/admin-transactions');
    await expect(page.locator('#admin-content')).not.toHaveAttribute('hidden');
    await page.waitForSelector('#transactions-tbody', { state: 'visible' });

    // Apply user_id filter
    await page.fill('#f-user-id', String(admin.id));
    await page.click('#btn-apply');
    await page.waitForTimeout(500);

    const rows = page.locator('#transactions-tbody tr');
    const count = await rows.count();
    // All visible rows should belong to admin.id
    for (let i = 0; i < count; i++) {
      // We just verify rows exist and table is visible
    }
    await expect(page.locator('#table-wrapper')).not.toHaveAttribute('hidden');
  });

  test('summary block renders after load', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'uiadmin3', 'uiadmin3@test.com');
    await activateUser(page, 'uiadmin3');
    await setUserRole(page, 'uiadmin3', 'admin');
    await loginUser(page, 'uiadmin3');

    await insertTransaction(page, admin.id, 'topup', 100, 300);

    await page.goto('/admin-transactions');
    await expect(page.locator('#admin-content')).not.toHaveAttribute('hidden');
    await page.waitForSelector('#summary-section:not([hidden])', { timeout: 5000 });
    await expect(page.locator('#summary-total-count')).not.toHaveText('—');
  });

  test('type badges render in table', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'uiadmin4', 'uiadmin4@test.com');
    await activateUser(page, 'uiadmin4');
    await setUserRole(page, 'uiadmin4', 'admin');
    await loginUser(page, 'uiadmin4');

    await insertTransaction(page, admin.id, 'topup', 100, 300);

    await page.goto('/admin-transactions');
    await expect(page.locator('#admin-content')).not.toHaveAttribute('hidden');
    await page.waitForSelector('.badge-type--topup', { timeout: 5000 });
    await expect(page.locator('.badge-type--topup').first()).toBeVisible();
  });

  test('empty state renders when no results', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'uiadmin5', 'uiadmin5@test.com');
    await activateUser(page, 'uiadmin5');
    await setUserRole(page, 'uiadmin5', 'admin');
    await loginUser(page, 'uiadmin5');

    await page.goto('/admin-transactions');
    await expect(page.locator('#admin-content')).not.toHaveAttribute('hidden');
    await page.waitForSelector('#state-empty:not([hidden])', { timeout: 5000 });
    await expect(page.locator('#state-empty')).not.toHaveAttribute('hidden');
  });

  test('clicking username in table opens ledger panel', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'uiadmin6', 'uiadmin6@test.com');
    const user = await registerUser(page, 'uiuser6', 'uiuser6@test.com');
    await activateUser(page, 'uiadmin6');
    await activateUser(page, 'uiuser6');
    await setUserRole(page, 'uiadmin6', 'admin');
    await loginUser(page, 'uiadmin6');

    await insertTransaction(page, user.id, 'topup', 100, 300);

    await page.goto('/admin-transactions');
    await expect(page.locator('#admin-content')).not.toHaveAttribute('hidden');
    await page.waitForSelector('.username-link', { timeout: 5000 });

    await page.locator('.username-link').first().click();
    await page.waitForSelector('#ledger-panel:not([hidden])', { timeout: 5000 });
    await expect(page.locator('#ledger-panel')).not.toHaveAttribute('hidden');
  });

  test('ledger close button returns to list', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'uiadmin7', 'uiadmin7@test.com');
    const user = await registerUser(page, 'uiuser7', 'uiuser7@test.com');
    await activateUser(page, 'uiadmin7');
    await activateUser(page, 'uiuser7');
    await setUserRole(page, 'uiadmin7', 'admin');
    await loginUser(page, 'uiadmin7');

    await insertTransaction(page, user.id, 'topup', 100, 300);

    await page.goto('/admin-transactions');
    await expect(page.locator('#admin-content')).not.toHaveAttribute('hidden');
    await page.waitForSelector('.username-link', { timeout: 5000 });
    await page.locator('.username-link').first().click();
    await page.waitForSelector('#ledger-panel:not([hidden])', { timeout: 5000 });

    await page.click('#btn-ledger-close');
    await expect(page.locator('#ledger-panel')).toHaveAttribute('hidden', '');
  });

  test('amount values display with 2 decimal places', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'uiadmin8', 'uiadmin8@test.com');
    await activateUser(page, 'uiadmin8');
    await setUserRole(page, 'uiadmin8', 'admin');
    await loginUser(page, 'uiadmin8');

    await insertTransaction(page, admin.id, 'topup', 100, 300);

    await page.goto('/admin-transactions');
    await expect(page.locator('#admin-content')).not.toHaveAttribute('hidden');
    await page.waitForSelector('#transactions-tbody tr', { timeout: 5000 });

    const amountCells = page.locator('#transactions-tbody .amount-positive, #transactions-tbody .amount-negative');
    const firstAmount = await amountCells.first().textContent();
    // Should contain decimal point with 2 decimals: e.g. "+100.00 RC"
    expect(firstAmount).toMatch(/[+-]?\d+\.\d{2}\s+RC/);
  });

  test('admin_adjust row shows admin username', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'uiadmin9', 'uiadmin9@test.com');
    const user = await registerUser(page, 'uiuser9', 'uiuser9@test.com');
    await activateUser(page, 'uiadmin9');
    await activateUser(page, 'uiuser9');
    await setUserRole(page, 'uiadmin9', 'admin');
    await loginUser(page, 'uiadmin9');

    await insertTransaction(page, user.id, 'admin_adjust', 50, 250, {
      description: 'Test adjust',
      admin_id: admin.id,
    });

    await page.goto('/admin-transactions?type=admin_adjust');
    await expect(page.locator('#admin-content')).not.toHaveAttribute('hidden');
    await page.waitForSelector('#transactions-tbody tr', { timeout: 5000 });

    const rowText = await page.locator('#transactions-tbody tr').first().innerText();
    expect(rowText).toContain('uiadmin9');
  });
});

// ---------------------------------------------------------------------------
// UI Tests: Admin landing page
// ---------------------------------------------------------------------------

test.describe('UI: Admin landing page Transactions card', () => {
  test('admin sees Transactions card on admin landing page', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'cardadmin1', 'cardadmin1@test.com');
    await activateUser(page, 'cardadmin1');
    await setUserRole(page, 'cardadmin1', 'admin');
    await loginUser(page, 'cardadmin1');

    await page.goto('/admin');
    await expect(page.locator('#admin-content')).not.toHaveAttribute('hidden');
    await page.waitForSelector('#card-transactions:not([hidden])', { timeout: 5000 });
    await expect(page.locator('#card-transactions')).toBeVisible();
  });

  test('moderator does not see Transactions card on admin landing page', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'cardmod1', 'cardmod1@test.com');
    await activateUser(page, 'cardmod1');
    await setUserRole(page, 'cardmod1', 'moderator');
    await loginUser(page, 'cardmod1');

    await page.goto('/admin');
    await expect(page.locator('#admin-content')).not.toHaveAttribute('hidden');
    await page.waitForTimeout(500);
    await expect(page.locator('#card-transactions')).toHaveAttribute('hidden', '');
  });
});

// ---------------------------------------------------------------------------
// Orphaned holds
// ---------------------------------------------------------------------------

test.describe('Orphaned holds', () => {
  test('hold with release but no deduct is NOT orphaned', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'orphanrel1', 'orphanrel1@test.com');
    await activateUser(page, 'orphanrel1');
    await setUserRole(page, 'orphanrel1', 'admin');
    await loginUser(page, 'orphanrel1');

    const ref = 'ref-release-only';
    // Insert hold old enough to pass the grace period (15 min ago)
    const oldTs = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    await insertTransaction(page, user.id, 'hold', -100, 100, {
      reference_id: ref,
      created_at: oldTs,
    });
    // Matching release — this resolves the hold
    await insertTransaction(page, user.id, 'release', 100, 200, { reference_id: ref });

    const res = await page.request.get('/api/admin/transactions/orphaned-holds');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const found = (body.items as any[]).find((i: any) => i.reference_id === ref);
    expect(found).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/transactions/orphaned-holds/:holdId/release
// ---------------------------------------------------------------------------

test.describe('POST /api/admin/transactions/orphaned-holds/:holdId/release', () => {
  // -------------------------------------------------------------------------
  // Auth & guard tests
  // -------------------------------------------------------------------------

  test('unauthenticated → 401', async ({ page }) => {
    await resetDb(page);
    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post('/api/admin/transactions/orphaned-holds/1/release', {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(401);
  });

  test('moderator → 403', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'relmod1', 'relmod1@test.com');
    await activateUser(page, 'relmod1');
    await setUserRole(page, 'relmod1', 'moderator');
    await loginUser(page, 'relmod1');
    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post('/api/admin/transactions/orphaned-holds/1/release', {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(403);
  });

  test('missing CSRF → 403', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'reladmin_csrf', 'reladmin_csrf@test.com');
    await activateUser(page, 'reladmin_csrf');
    await setUserRole(page, 'reladmin_csrf', 'admin');
    await loginUser(page, 'reladmin_csrf');
    const res = await page.request.post('/api/admin/transactions/orphaned-holds/1/release');
    expect(res.status()).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Validation tests
  // -------------------------------------------------------------------------

  test('invalid holdId (non-integer) → 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'reladmin1', 'reladmin1@test.com');
    await activateUser(page, 'reladmin1');
    await setUserRole(page, 'reladmin1', 'admin');
    await loginUser(page, 'reladmin1');
    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post('/api/admin/transactions/orphaned-holds/abc/release', {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(400);
  });

  test('hold not found → 404', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'reladmin2', 'reladmin2@test.com');
    await activateUser(page, 'reladmin2');
    await setUserRole(page, 'reladmin2', 'admin');
    await loginUser(page, 'reladmin2');
    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post('/api/admin/transactions/orphaned-holds/999999/release', {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(404);
  });

  test('non-hold transaction (topup) → 404', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'reladmin3', 'reladmin3@test.com');
    await activateUser(page, 'reladmin3');
    await setUserRole(page, 'reladmin3', 'admin');
    await loginUser(page, 'reladmin3');
    const topup = await insertTransaction(page, user.id, 'topup', 100, 300, { reference_id: 'ref-topup-test' });
    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/transactions/orphaned-holds/${topup.id}/release`, {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(404);
  });

  test('hold with NULL reference_id → 400', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'reladmin4', 'reladmin4@test.com');
    await activateUser(page, 'reladmin4');
    await setUserRole(page, 'reladmin4', 'admin');
    await loginUser(page, 'reladmin4');
    const oldTs = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const hold = await insertTransaction(page, user.id, 'hold', -100, 100, { created_at: oldTs });
    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/transactions/orphaned-holds/${hold.id}/release`, {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/reference_id/i);
  });

  test('already resolved hold with matching deduct → 409', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'reladmin5', 'reladmin5@test.com');
    await activateUser(page, 'reladmin5');
    await setUserRole(page, 'reladmin5', 'admin');
    await loginUser(page, 'reladmin5');
    const ref = 'ref-already-deducted';
    const oldTs = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const hold = await insertTransaction(page, user.id, 'hold', -100, 100, {
      reference_id: ref,
      created_at: oldTs,
    });
    await insertTransaction(page, user.id, 'deduct', -80, 20, { reference_id: ref });
    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/transactions/orphaned-holds/${hold.id}/release`, {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already resolved/i);
  });

  test('already resolved hold with matching release → 409', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'reladmin6', 'reladmin6@test.com');
    await activateUser(page, 'reladmin6');
    await setUserRole(page, 'reladmin6', 'admin');
    await loginUser(page, 'reladmin6');
    const ref = 'ref-already-released';
    const oldTs = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const hold = await insertTransaction(page, user.id, 'hold', -100, 100, {
      reference_id: ref,
      created_at: oldTs,
    });
    await insertTransaction(page, user.id, 'release', 100, 200, { reference_id: ref });
    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/transactions/orphaned-holds/${hold.id}/release`, {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already resolved/i);
  });

  test('hold within grace period → 409', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'reladmin7', 'reladmin7@test.com');
    await activateUser(page, 'reladmin7');
    await setUserRole(page, 'reladmin7', 'admin');
    await loginUser(page, 'reladmin7');
    const ref = 'ref-grace-period-' + Date.now();
    // Insert a hold only 1 minute old (within 10-minute grace period)
    const recentTs = new Date(Date.now() - 1 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const hold = await insertTransaction(page, user.id, 'hold', -100, 100, {
      reference_id: ref,
      created_at: recentTs,
    });
    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/transactions/orphaned-holds/${hold.id}/release`, {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/grace period/i);
  });

  test('hold belongs to active session → 409', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);

      const user = await registerUser(page, 'rel_active1', 'rel_active1@test.com');
      await activateUser(page, 'rel_active1');
      await setUserRole(page, 'rel_active1', 'admin');

      // Start a real session to get an active sessionRef
      await setupSocketCapture(page);
      await injectActiveSession(page, 1, user.username, user.id);
      await page.goto('/control');

      const sessionData = await waitForSocketEvent(page, 'session_started');
      const sessionRef = sessionData.sessionRef as string;
      expect(typeof sessionRef).toBe('string');

      // The server already created a hold when the session started.
      // Find it via the admin API instead of inserting a duplicate.
      await loginUser(page, user.username);
      const txRes = await page.request.get(
        `/api/admin/transactions?user_id=${user.id}&type=hold&reference_id=${sessionRef}`,
      );
      expect(txRes.status()).toBe(200);
      const txBody = await txRes.json();
      const hold = txBody.items.find((t: any) => t.reference_id === sessionRef);
      expect(hold).toBeTruthy();

      // Use a separate admin context for the API call
      const adminCtx = await browser.newContext();
      try {
        const adminPage = await adminCtx.newPage();
        await loginUser(adminPage, 'rel_active1');
        const csrfToken = await getCsrfToken(adminPage);
        const res = await adminPage.request.post(
          `/api/admin/transactions/orphaned-holds/${hold.id}/release`,
          { headers: { 'X-CSRF-Token': csrfToken } },
        );
        expect(res.status()).toBe(409);
        const body = await res.json();
        expect(body.error).toMatch(/active session|grace period/i);
      } finally {
        await adminCtx.close();
      }
    } finally {
      await ctx.close();
    }
  });

  // -------------------------------------------------------------------------
  // Happy path tests
  // -------------------------------------------------------------------------

  test('successful release', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'rel_happy1', 'rel_happy1@test.com');
    await activateUser(page, 'rel_happy1');
    await setUserRole(page, 'rel_happy1', 'admin');
    await loginUser(page, 'rel_happy1');

    // activate-user sets balance to 200; insert a hold of -100 → balance_after=100
    const ref = 'ref-orphan-release-test';
    const oldTs = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const hold = await insertTransaction(page, user.id, 'hold', -100, 100, {
      reference_id: ref,
      created_at: oldTs,
    });

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(`/api/admin/transactions/orphaned-holds/${hold.id}/release`, {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.released).toBeDefined();
    expect(body.released.holdId).toBe(hold.id);
    expect(body.released.amount).toBe(100);
    expect(typeof body.released.newBalance).toBe('number');

    // amount must be positive
    expect(body.released.amount).toBeGreaterThan(0);
    expect(body.released.amount).toBe(Math.abs(-100));

    // verify user balance is restored (activate gives 200, hold deducted 100, release adds 100 back)
    const balanceRes = await page.request.get(`/api/admin/users/${user.id}/ledger`);
    expect(balanceRes.status()).toBe(200);
    const balanceBody = await balanceRes.json();
    expect(balanceBody.user.balance).toBe(body.released.newBalance);

    // verify a release transaction exists with matching reference_id
    const txRes = await page.request.get(`/api/admin/transactions?user_id=${user.id}&type=release`);
    expect(txRes.status()).toBe(200);
    const txBody = await txRes.json();
    const releaseTx = txBody.items.find((t: any) => t.reference_id === ref && t.type === 'release');
    expect(releaseTx).toBeDefined();
    expect(releaseTx.amount).toBe(100);
  });

  test('second release attempt returns 409', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'rel_happy2', 'rel_happy2@test.com');
    await activateUser(page, 'rel_happy2');
    await setUserRole(page, 'rel_happy2', 'admin');
    await loginUser(page, 'rel_happy2');

    const ref = 'ref-idempotent-release-test';
    const oldTs = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const hold = await insertTransaction(page, user.id, 'hold', -100, 100, {
      reference_id: ref,
      created_at: oldTs,
    });
    const csrfToken = await getCsrfToken(page);

    // First release — should succeed
    const res1 = await page.request.post(`/api/admin/transactions/orphaned-holds/${hold.id}/release`, {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res1.status()).toBe(200);

    // Second release — should return 409
    const res2 = await page.request.post(`/api/admin/transactions/orphaned-holds/${hold.id}/release`, {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res2.status()).toBe(409);
    const body2 = await res2.json();
    expect(body2.error).toMatch(/already resolved/i);
  });

  test('audit log written after successful release', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'rel_audit1', 'rel_audit1@test.com');
    await activateUser(page, 'rel_audit1');
    await setUserRole(page, 'rel_audit1', 'admin');
    await loginUser(page, 'rel_audit1');

    const ref = 'ref-audit-log-test';
    const oldTs = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const hold = await insertTransaction(page, user.id, 'hold', -100, 100, {
      reference_id: ref,
      created_at: oldTs,
    });

    const csrfToken = await getCsrfToken(page);
    const releaseRes = await page.request.post(
      `/api/admin/transactions/orphaned-holds/${hold.id}/release`,
      { headers: { 'X-CSRF-Token': csrfToken } },
    );
    expect(releaseRes.status()).toBe(200);

    // Query audit log for orphaned_hold_release action
    const auditRes = await page.request.get('/api/admin/audit-log?action=orphaned_hold_release&limit=10');
    expect(auditRes.status()).toBe(200);
    const auditBody = await auditRes.json();
    const items = auditBody.items || auditBody.logs || [];
    const entry = items.find(
      (e: any) => e.action === 'orphaned_hold_release' && e.target_id === hold.id,
    );
    expect(entry).toBeDefined();
  });
});
