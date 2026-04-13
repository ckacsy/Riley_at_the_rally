import { test, expect } from '@playwright/test';
import { resetDb, getCsrfToken, registerUser, activateUser, loginUser, setUserRole, setupSocketCapture, waitForSocketEvent } from './helpers';

const TEST_BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:5000';

/**
 * PR 12 — Orphaned holds detection E2E tests.
 *
 * Covers:
 *  - GET /api/admin/transactions/orphaned-holds: auth guards (401, 403)
 *  - Empty items when no orphaned holds exist
 *  - Orphaned hold detection (hold with reference_id, no matching deduct, old enough)
 *  - Non-orphaned hold (matching deduct exists)
 *  - Legacy hold (NULL reference_id) excluded
 *  - Integration: real session via socket → hold has reference_id, end session → deduct shares reference_id
 *  - Integration: admin force-end → deduct shares reference_id as hold
 *  - Active session exclusion: hold whose reference_id belongs to active session not returned
 */

// ---------------------------------------------------------------------------
// Helpers (mirrors admin_transactions.spec.ts pattern)
// ---------------------------------------------------------------------------

async function insertTransaction(
  page: import('@playwright/test').Page,
  userId: number,
  type: string,
  amount: number,
  balanceAfter: number,
  opts: { description?: string; reference_id?: string; admin_id?: number; created_at?: string } = {},
): Promise<{ id: number; reference_id: string | null; [key: string]: unknown }> {
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
// API Tests: GET /api/admin/transactions/orphaned-holds
// ---------------------------------------------------------------------------

test.describe('GET /api/admin/transactions/orphaned-holds', () => {
  test('unauthenticated → 401', async ({ page }) => {
    await resetDb(page);
    const res = await page.request.get('/api/admin/transactions/orphaned-holds');
    expect(res.status()).toBe(401);
  });

  test('non-admin user → 403', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'orphan_user1', 'orphan_user1@test.com');
    await activateUser(page, 'orphan_user1');
    await loginUser(page, 'orphan_user1');
    const res = await page.request.get('/api/admin/transactions/orphaned-holds');
    expect(res.status()).toBe(403);
  });

  test('moderator → 403', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'orphan_mod1', 'orphan_mod1@test.com');
    await activateUser(page, 'orphan_mod1');
    await setUserRole(page, 'orphan_mod1', 'moderator');
    await loginUser(page, 'orphan_mod1');
    const res = await page.request.get('/api/admin/transactions/orphaned-holds');
    expect(res.status()).toBe(403);
  });

  test('admin with no orphaned holds → 200 with empty items', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'orphan_admin1', 'orphan_admin1@test.com');
    await activateUser(page, 'orphan_admin1');
    await setUserRole(page, 'orphan_admin1', 'admin');
    await loginUser(page, 'orphan_admin1');

    const res = await page.request.get('/api/admin/transactions/orphaned-holds');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('items');
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(0);
    expect(body).toHaveProperty('total', 0);
  });

  test('hold with reference_id but no matching deduct, old enough → appears as orphaned', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'orphan_admin2', 'orphan_admin2@test.com');
    await activateUser(page, 'orphan_admin2');
    await setUserRole(page, 'orphan_admin2', 'admin');
    await loginUser(page, 'orphan_admin2');

    const ref = 'test-ref-' + Date.now();
    // Insert a hold with a reference_id that is more than 10 minutes old
    const oldTs = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    await insertTransaction(page, user.id, 'hold', -100, 100, {
      reference_id: ref,
      created_at: oldTs,
    });

    const res = await page.request.get('/api/admin/transactions/orphaned-holds');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const found = body.items.find((i: any) => i.reference_id === ref);
    expect(found).toBeTruthy();
    expect(found.status).toBe('orphaned');
  });

  test('hold with matching deduct (same reference_id) → not orphaned', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'orphan_admin3', 'orphan_admin3@test.com');
    await activateUser(page, 'orphan_admin3');
    await setUserRole(page, 'orphan_admin3', 'admin');
    await loginUser(page, 'orphan_admin3');

    const ref = 'test-ref-deduct-' + Date.now();
    const oldTs = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    await insertTransaction(page, user.id, 'hold', -100, 100, { reference_id: ref, created_at: oldTs });
    await insertTransaction(page, user.id, 'deduct', -80, 20, { reference_id: ref });

    const res = await page.request.get('/api/admin/transactions/orphaned-holds');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const found = body.items.find((i: any) => i.reference_id === ref);
    expect(found).toBeUndefined();
  });

  test('hold with NULL reference_id → not included (legacy data)', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'orphan_admin4', 'orphan_admin4@test.com');
    await activateUser(page, 'orphan_admin4');
    await setUserRole(page, 'orphan_admin4', 'admin');
    await loginUser(page, 'orphan_admin4');

    const oldTs = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    // Insert hold without reference_id (null)
    const tx = await insertTransaction(page, user.id, 'hold', -100, 100, { created_at: oldTs });
    expect(tx.reference_id).toBeNull();

    const res = await page.request.get('/api/admin/transactions/orphaned-holds');
    expect(res.status()).toBe(200);
    const body = await res.json();
    // No item with null reference_id
    const found = body.items.find((i: any) => i.id === tx.id);
    expect(found).toBeUndefined();
  });

  test('hold within grace period → not returned as orphaned yet', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'orphan_admin5', 'orphan_admin5@test.com');
    await activateUser(page, 'orphan_admin5');
    await setUserRole(page, 'orphan_admin5', 'admin');
    await loginUser(page, 'orphan_admin5');

    const ref = 'test-ref-grace-' + Date.now();
    // Insert a hold that is only 1 minute old (within grace period)
    const recentTs = new Date(Date.now() - 1 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    await insertTransaction(page, user.id, 'hold', -100, 100, { reference_id: ref, created_at: recentTs });

    const res = await page.request.get('/api/admin/transactions/orphaned-holds');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const found = body.items.find((i: any) => i.reference_id === ref);
    expect(found).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/transactions/orphaned-holds/:holdId/release
// ---------------------------------------------------------------------------

test.describe('POST /api/admin/transactions/orphaned-holds/:holdId/release', () => {
  test('unauthenticated → 401', async ({ page }) => {
    await resetDb(page);
    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post('/api/admin/transactions/orphaned-holds/1/release', {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(401);
  });

  test('non-admin user → 403', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'release_user1', 'release_user1@test.com');
    await activateUser(page, 'release_user1');
    await loginUser(page, 'release_user1');
    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post('/api/admin/transactions/orphaned-holds/1/release', {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(403);
  });

  test('moderator → 403', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'release_mod1', 'release_mod1@test.com');
    await activateUser(page, 'release_mod1');
    await setUserRole(page, 'release_mod1', 'moderator');
    await loginUser(page, 'release_mod1');
    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post('/api/admin/transactions/orphaned-holds/1/release', {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(403);
  });

  test('invalid holdId (non-integer) → 400', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'release_adm_badid', 'release_adm_badid@test.com');
    await activateUser(page, 'release_adm_badid');
    await setUserRole(page, 'release_adm_badid', 'admin');
    await loginUser(page, 'release_adm_badid');
    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post('/api/admin/transactions/orphaned-holds/abc/release', {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(400);
  });

  test('hold not found → 404', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'release_adm_404', 'release_adm_404@test.com');
    await activateUser(page, 'release_adm_404');
    await setUserRole(page, 'release_adm_404', 'admin');
    await loginUser(page, 'release_adm_404');
    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post('/api/admin/transactions/orphaned-holds/999999/release', {
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(404);
  });

  test('hold without reference_id → 400', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'release_adm_noref', 'release_adm_noref@test.com');
    await activateUser(page, 'release_adm_noref');
    await setUserRole(page, 'release_adm_noref', 'admin');
    await loginUser(page, 'release_adm_noref');

    // Insert a hold without reference_id
    const oldTs = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const tx = await insertTransaction(page, user.id, 'hold', -100, 100, { created_at: oldTs });

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(
      `/api/admin/transactions/orphaned-holds/${tx.id}/release`,
      { headers: { 'X-CSRF-Token': csrfToken } },
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/reference_id/);
  });

  test('already resolved hold → 409', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'release_adm_resolved', 'release_adm_resolved@test.com');
    await activateUser(page, 'release_adm_resolved');
    await setUserRole(page, 'release_adm_resolved', 'admin');
    await loginUser(page, 'release_adm_resolved');

    const ref = 'resolved-ref-' + Date.now();
    const oldTs = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const hold = await insertTransaction(page, user.id, 'hold', -100, 100, {
      reference_id: ref,
      created_at: oldTs,
    });
    // Insert a matching deduct so the hold is already resolved
    await insertTransaction(page, user.id, 'deduct', -80, 20, { reference_id: ref });

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post(
      `/api/admin/transactions/orphaned-holds/${hold.id}/release`,
      { headers: { 'X-CSRF-Token': csrfToken } },
    );
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already resolved/i);
  });

  test('valid orphaned hold → 200, releases hold and credits user balance', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'release_adm_ok', 'release_adm_ok@test.com');
    await activateUser(page, 'release_adm_ok');
    await setUserRole(page, 'release_adm_ok', 'admin');
    await loginUser(page, 'release_adm_ok');

    const ref = 'orphan-ok-ref-' + Date.now();
    const oldTs = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    // Simulate a hold of 50 units
    const hold = await insertTransaction(page, user.id, 'hold', -50, 150, {
      reference_id: ref,
      created_at: oldTs,
    });

    const csrfToken = await getCsrfToken(page);
    const releaseRes = await page.request.post(
      `/api/admin/transactions/orphaned-holds/${hold.id}/release`,
      { headers: { 'X-CSRF-Token': csrfToken } },
    );
    expect(releaseRes.status(), `release failed: ${await releaseRes.text()}`).toBe(200);
    const releaseBody = await releaseRes.json();
    expect(releaseBody.success).toBe(true);
    expect(releaseBody.released).toBeDefined();
    expect(releaseBody.released.holdId).toBe(hold.id);
    expect(releaseBody.released.amount).toBeGreaterThan(0);

    // Verify the hold no longer appears in orphaned holds
    const orphanRes = await page.request.get('/api/admin/transactions/orphaned-holds');
    expect(orphanRes.status()).toBe(200);
    const orphanBody = await orphanRes.json();
    const stillOrphaned = orphanBody.items.find((i: any) => i.id === hold.id);
    expect(stillOrphaned).toBeUndefined();

    // Verify a release transaction was created for the user
    const txRes = await page.request.get(
      `/api/admin/transactions?user_id=${user.id}&type=release`,
    );
    expect(txRes.status()).toBe(200);
    const txBody = await txRes.json();
    const releaseTx = txBody.items.find(
      (t: any) => t.type === 'release' && t.reference_id === ref,
    );
    expect(releaseTx).toBeTruthy();
    expect(releaseTx.amount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: real session via socket — reference_id propagation
// ---------------------------------------------------------------------------

test.describe('Session reference_id propagation', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('start_session → hold has reference_id; end_session → deduct shares same reference_id', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);

      const user = await registerUser(page, 'ref_sess1', 'ref_sess1@example.com');
      await activateUser(page, 'ref_sess1');

      await setupSocketCapture(page);
      await injectActiveSession(page, 1, user.username, user.id);
      await page.goto('/control');

      const sessionData = await waitForSocketEvent(page, 'session_started');
      expect(sessionData).toHaveProperty('sessionRef');
      expect(typeof sessionData.sessionRef).toBe('string');
      expect(sessionData.sessionRef.length).toBeGreaterThan(0);

      // Verify hold transaction has the reference_id
      await setUserRole(page, 'ref_sess1', 'admin');
      await loginUser(page, 'ref_sess1');
      const txRes = await page.request.get(
        `/api/admin/transactions?user_id=${user.id}&type=hold`,
      );
      expect(txRes.status()).toBe(200);
      const txBody = await txRes.json();
      const holdTx = txBody.items.find((t: any) => t.type === 'hold' && t.reference_id === sessionData.sessionRef);
      expect(holdTx).toBeTruthy();

      // End session via socket
      await page.evaluate(() => {
        (window as any).__testSocket.emit('end_session', { carId: 1 });
      });
      await waitForSocketEvent(page, 'session_ended');

      // Verify deduct transaction has the same reference_id
      const txRes2 = await page.request.get(
        `/api/admin/transactions?user_id=${user.id}&type=deduct`,
      );
      expect(txRes2.status()).toBe(200);
      const txBody2 = await txRes2.json();
      const deductTx = txBody2.items.find((t: any) => t.type === 'deduct' && t.reference_id === sessionData.sessionRef);
      expect(deductTx).toBeTruthy();
    } finally {
      await ctx.close();
    }
  });

  test('admin force-end session → deduct has same reference_id as hold', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);

      const user = await registerUser(page, 'ref_force1', 'ref_force1@example.com');
      await activateUser(page, 'ref_force1');
      await setUserRole(page, 'ref_force1', 'admin');

      await setupSocketCapture(page);
      await injectActiveSession(page, 1, user.username, user.id);
      await page.goto('/control');

      const sessionData = await waitForSocketEvent(page, 'session_started');
      const sessionRef = sessionData.sessionRef as string;
      expect(typeof sessionRef).toBe('string');
      expect(sessionRef.length).toBeGreaterThan(0);

      // Admin force-end via API
      await loginUser(page, 'ref_force1');
      const csrfToken = await getCsrfToken(page);
      const forceRes = await page.request.post('/api/admin/sessions/active/1/force-end', {
        data: { reason: 'operator_intervention' },
        headers: { 'X-CSRF-Token': csrfToken },
      });
      expect(forceRes.status()).toBe(200);

      // Verify deduct shares the reference_id
      const txRes = await page.request.get(
        `/api/admin/transactions?user_id=${user.id}&type=deduct`,
      );
      expect(txRes.status()).toBe(200);
      const txBody = await txRes.json();
      const deductTx = txBody.items.find((t: any) => t.type === 'deduct' && t.reference_id === sessionRef);
      expect(deductTx).toBeTruthy();
    } finally {
      await ctx.close();
    }
  });

  test('active session exclusion: hold whose reference_id belongs to active session → not returned as orphaned', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);

      const user = await registerUser(page, 'ref_active1', 'ref_active1@example.com');
      await activateUser(page, 'ref_active1');
      await setUserRole(page, 'ref_active1', 'admin');

      // Start a real session to create a hold with a reference_id
      await setupSocketCapture(page);
      await injectActiveSession(page, 1, user.username, user.id);
      await page.goto('/control');

      const sessionData = await waitForSocketEvent(page, 'session_started');
      const sessionRef = sessionData.sessionRef as string;
      expect(typeof sessionRef).toBe('string');

      // The hold was just created (recent), so it won't appear as orphaned due to grace period.
      // Directly manipulate the hold's created_at to make it appear old enough:
      // We need to be creative here since we can't directly modify DB via API.
      // Instead, insert a fake orphaned hold with the active session's reference_id and old timestamp.
      const oldTs = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      await insertTransaction(page, user.id, 'hold', -100, 100, {
        reference_id: sessionRef,
        created_at: oldTs,
      });

      // Now query orphaned holds — the one with the active session's ref should be excluded
      await loginUser(page, 'ref_active1');
      const res = await page.request.get('/api/admin/transactions/orphaned-holds');
      expect(res.status()).toBe(200);
      const body = await res.json();

      // The inserted hold with sessionRef of the active session should NOT appear
      const found = body.items.find((i: any) => i.reference_id === sessionRef);
      expect(found).toBeUndefined();
      expect(body.activeSessionRefs).toBeGreaterThan(0);
    } finally {
      await ctx.close();
    }
  });
});
