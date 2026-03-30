import { test, expect } from '@playwright/test';

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

/** Intercept socket events from the page. Must be called before page.goto(). */
async function setupSocketCapture(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__socketEventStore = {};
    let _ioValue: any;
    Object.defineProperty(window, 'io', {
      configurable: true,
      get() { return _ioValue; },
      set(v: any) {
        _ioValue = function (this: any, ...args: any[]) {
          const sock = v.apply(this, args);
          (window as any).__testSocket = sock;
          const trackedEvents = ['session_started', 'session_error', 'session_ended'];
          for (const evt of trackedEvents) {
            sock.on(evt, (data: any) => {
              (window as any).__socketEventStore[evt] = data !== undefined ? data : null;
            });
          }
          return sock;
        };
      },
    });
  });
}

async function waitForSocketEvent(
  page: import('@playwright/test').Page,
  eventName: string,
  timeout = 8000,
): Promise<any> {
  return page.evaluate(
    ({ evt, ms }) =>
      new Promise<any>((resolve, reject) => {
        const store = (window as any).__socketEventStore;
        if (store && Object.prototype.hasOwnProperty.call(store, evt)) {
          resolve(store[evt]);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error(`Socket event '${evt}' not received within ${ms}ms`)),
          ms,
        );
        const interval = setInterval(() => {
          const s = (window as any).__socketEventStore;
          if (s && Object.prototype.hasOwnProperty.call(s, evt)) {
            clearInterval(interval);
            clearTimeout(timer);
            resolve(s[evt]);
          }
        }, 50);
      }),
    { evt: eventName, ms: timeout },
  );
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
