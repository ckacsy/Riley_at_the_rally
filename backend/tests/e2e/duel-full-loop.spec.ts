import { test, expect } from '@playwright/test';

/**
 * Duel integration smoke tests — full end-to-end loops.
 *
 * Covers:
 *  1. Full win flow (A finishes first, B loses)
 *  2. Disconnect during in_progress (A wins by disconnect)
 *  3. Timeout (both get timeout result, no rank change)
 *  4. Protected zone loss (B at rank 12 loses, rank unchanged)
 *  5. Promotion flow (A at rank 5 stars 3 wins → rank 4)
 *  6. Legend entry (A at rank 1 stars 3 wins → is_legend = 1)
 */

// ---------------------------------------------------------------------------
// Helpers (mirrors duel.spec.ts patterns)
// ---------------------------------------------------------------------------

async function resetDb(page: import('@playwright/test').Page): Promise<void> {
  await page.request.post('/api/dev/reset-db');
}

async function getCsrfToken(
  page: import('@playwright/test').Page,
): Promise<string> {
  const res = await page.request.get('/api/csrf-token');
  const body = await res.json();
  return body.csrfToken as string;
}

async function registerUser(
  page: import('@playwright/test').Page,
  username: string,
  email: string,
  password: string,
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
  const res = await page.request.post('/api/dev/activate-user', {
    data: { username },
  });
  expect(res.status(), `activateUser failed: ${await res.text()}`).toBe(200);
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

async function injectServerActiveSession(
  page: import('@playwright/test').Page,
  carId: number,
  dbUserId: number,
  socketId?: string,
): Promise<void> {
  const res = await page.request.post('/api/dev/inject-active-session', {
    data: { carId, dbUserId, socketId },
  });
  expect(res.status(), `injectServerActiveSession failed: ${await res.text()}`).toBe(200);
}

async function setupSocketCapture(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__socketEventStore = {};

    let _ioValue: any;
    Object.defineProperty(window, 'io', {
      configurable: true,
      get() {
        return _ioValue;
      },
      set(v: any) {
        _ioValue = function (this: any, ...args: any[]) {
          const sock = v.apply(this, args);
          (window as any).__testSocket = sock;

          sock.onAny((event: string, ...cbArgs: any[]) => {
            (window as any).__socketEventStore[event] =
              cbArgs.length === 1 ? cbArgs[0] : cbArgs;
          });

          const origOn = sock.on.bind(sock);
          sock.on = function (event: string, cb: Function) {
            origOn(event, (...cbArgs: any[]) => {
              (window as any).__socketEventStore[event] =
                cbArgs.length === 1 ? cbArgs[0] : cbArgs;
              cb(...cbArgs);
            });
            return sock;
          };

          return sock;
        };
        Object.assign(_ioValue, v);
        _ioValue.prototype = v.prototype;
      },
    });
  });
}

async function waitForSocketEvent(
  page: import('@playwright/test').Page,
  eventName: string,
  timeout = 10_000,
): Promise<any> {
  return page.evaluate(
    ({ evt, ms }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timeout waiting for socket event: ${evt}`)),
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

async function clearSocketEvent(
  page: import('@playwright/test').Page,
  eventName: string,
): Promise<void> {
  await page.evaluate(
    (evt) => { delete (window as any).__socketEventStore[evt]; },
    eventName,
  );
}

async function waitForSocketConnected(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    () => document.getElementById('status-dot')?.classList.contains('connected'),
    { timeout: 10_000 },
  );
}

async function setUserRank(
  page: import('@playwright/test').Page,
  username: string,
  rank: number,
  stars: number,
  is_legend = false,
  legend_position: number | null = null,
): Promise<void> {
  const res = await page.request.post('/api/dev/set-user-rank', {
    data: { username, rank, stars, is_legend, legend_position },
  });
  expect(res.status(), `setUserRank failed: ${await res.text()}`).toBe(200);
}

/**
 * Rewind the lap start time so MIN_LAP_TIME_MS check passes.
 */
async function rewindLapStart(
  page: import('@playwright/test').Page,
  dbUserId: number,
): Promise<void> {
  const res = await page.request.post('/api/dev/rewind-lap-start', {
    data: { dbUserId },
  });
  expect(res.status(), `rewindLapStart failed: ${await res.text()}`).toBe(200);
}

/**
 * Force the duel timeout for a user's active duel.
 */
async function triggerDuelTimeout(
  page: import('@playwright/test').Page,
  dbUserId: number,
): Promise<void> {
  const res = await page.request.post('/api/dev/trigger-duel-timeout-for-user', {
    data: { dbUserId },
  });
  expect(res.status(), `triggerDuelTimeout failed: ${await res.text()}`).toBe(200);
}

/**
 * Perform the complete matching + ready handshake for two pages.
 * Both pages must already be connected to the socket and have active sessions.
 * Returns after both players receive duel:start.
 */
async function doMatchAndReady(
  pageA: import('@playwright/test').Page,
  pageB: import('@playwright/test').Page,
): Promise<void> {
  await pageA.evaluate(() => (window as any).__testSocket.emit('duel:search'));
  await pageB.evaluate(() => (window as any).__testSocket.emit('duel:search'));

  await waitForSocketEvent(pageA, 'duel:matched');
  await waitForSocketEvent(pageB, 'duel:matched');

  await pageA.evaluate(() => (window as any).__testSocket.emit('duel:ready'));
  await pageB.evaluate(() => (window as any).__testSocket.emit('duel:ready'));

  await waitForSocketEvent(pageA, 'duel:countdown');
  await waitForSocketEvent(pageB, 'duel:countdown');

  await waitForSocketEvent(pageA, 'duel:start');
  await waitForSocketEvent(pageB, 'duel:start');
}

/**
 * Perform a valid lap: start_lap → 2 checkpoints → rewind time → finish_lap.
 * Returns the duel:result payload received by pageA.
 */
async function performWinningLap(
  pageA: import('@playwright/test').Page,
  dbUserIdA: number,
): Promise<any> {
  await pageA.evaluate(() => (window as any).__testSocket.emit('duel:start_lap'));
  await waitForSocketEvent(pageA, 'duel:lap_started');

  // Checkpoint 0
  await pageA.evaluate((idx) => (window as any).__testSocket.emit('duel:checkpoint', { index: idx }), 0);
  await waitForSocketEvent(pageA, 'duel:checkpoint_ok');
  await clearSocketEvent(pageA, 'duel:checkpoint_ok');

  // Checkpoint 1
  await pageA.evaluate((idx) => (window as any).__testSocket.emit('duel:checkpoint', { index: idx }), 1);
  await waitForSocketEvent(pageA, 'duel:checkpoint_ok');

  // Bypass MIN_LAP_TIME_MS
  await rewindLapStart(pageA, dbUserIdA);

  // Finish
  await pageA.evaluate(() => (window as any).__testSocket.emit('duel:finish_lap'));
  return waitForSocketEvent(pageA, 'duel:result', 10_000);
}

// ---------------------------------------------------------------------------
// Test setup helper
// ---------------------------------------------------------------------------

async function setupDuelUsers(
  browser: import('@playwright/test').Browser,
  nameA: string,
  nameB: string,
): Promise<{
  ctxA: import('@playwright/test').BrowserContext;
  ctxB: import('@playwright/test').BrowserContext;
  pageA: import('@playwright/test').Page;
  pageB: import('@playwright/test').Page;
  userA: { id: number; username: string };
  userB: { id: number; username: string };
}> {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();

  const pageA = await ctxA.newPage();
  await resetDb(pageA);

  const userA = await registerUser(pageA, nameA, `${nameA}@test.com`, 'Secure#Pass1');
  await activateUser(pageA, userA.username);
  const userB = await registerUser(pageA, nameB, `${nameB}@test.com`, 'Secure#Pass1');
  await activateUser(pageA, userB.username);

  // Re-login as userA after registering userB (registration overwrites session)
  await loginUser(pageA, userA.username);

  await setupSocketCapture(pageA);
  await injectActiveSession(pageA, 1, userA.username, userA.id);
  await pageA.goto('/control');
  await waitForSocketConnected(pageA);
  const socketIdA = await pageA.evaluate(() => (window as any).__testSocket.id);
  await injectServerActiveSession(pageA, 1, userA.id, socketIdA);

  const pageB = await ctxB.newPage();
  await loginUser(pageB, userB.username);
  await setupSocketCapture(pageB);
  await injectActiveSession(pageB, 2, userB.username, userB.id);
  await pageB.goto('/control');
  await waitForSocketConnected(pageB);
  const socketIdB = await pageB.evaluate(() => (window as any).__testSocket.id);
  await injectServerActiveSession(pageB, 2, userB.id, socketIdB);

  return { ctxA, ctxB, pageA, pageB, userA, userB };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Duel full-loop — smoke tests', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.setTimeout(60_000);

  // -------------------------------------------------------------------------
  // Test 1: Full win flow
  // -------------------------------------------------------------------------
  test('Test 1: full win flow — A wins, B loses, stats and history updated', async ({
    browser,
  }) => {
    const { ctxA, ctxB, pageA, pageB, userA, userB } = await setupDuelUsers(
      browser, 'fl_win_a', 'fl_win_b',
    );
    try {
      await doMatchAndReady(pageA, pageB);

      const resultA = await performWinningLap(pageA, userA.id);

      expect(resultA.result).toBe('win');

      const resultB = await waitForSocketEvent(pageB, 'duel:result', 10_000);
      expect(resultB.result).toBe('loss');

      // Verify DB stats via API
      const rankResA = await pageA.request.get('/api/profile/rank');
      const rankBodyA = await rankResA.json();
      expect(rankBodyA.duelsWon).toBe(1);

      const rankResB = await pageB.request.get('/api/profile/rank');
      const rankBodyB = await rankResB.json();
      expect(rankBodyB.duelsLost).toBe(1);

      // Verify history for A
      const histResA = await pageA.request.get('/api/duel/history');
      const histBodyA = await histResA.json();
      expect(Array.isArray(histBodyA.history)).toBe(true);
      expect(histBodyA.history.length).toBeGreaterThan(0);
      const entryA = histBodyA.history[0];
      expect(entryA.isWin).toBe(true);

      // Verify history for B
      const histResB = await pageB.request.get('/api/duel/history');
      const histBodyB = await histResB.json();
      expect(Array.isArray(histBodyB.history)).toBe(true);
      expect(histBodyB.history.length).toBeGreaterThan(0);
      const entryB = histBodyB.history[0];
      expect(entryB.isWin).toBe(false);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: Disconnect during in_progress
  // -------------------------------------------------------------------------
  test('Test 2: disconnect during in_progress — A wins by disconnect', async ({
    browser,
  }) => {
    const { ctxA, ctxB, pageA, pageB, userA } = await setupDuelUsers(
      browser, 'fl_disc_a', 'fl_disc_b',
    );
    try {
      await doMatchAndReady(pageA, pageB);

      // A starts lap
      await pageA.evaluate(() => (window as any).__testSocket.emit('duel:start_lap'));
      await waitForSocketEvent(pageA, 'duel:lap_started');

      // B disconnects
      await ctxB.close();

      // A receives win by disconnect
      const resultA = await waitForSocketEvent(pageA, 'duel:result', 10_000);
      expect(resultA.result).toBe('win');
      expect(resultA.reason).toBe('disconnect');
    } finally {
      await ctxA.close();
      // ctxB already closed
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: Timeout
  // -------------------------------------------------------------------------
  test('Test 3: timeout — both get timeout result, no rank change', async ({
    browser,
  }) => {
    const { ctxA, ctxB, pageA, pageB, userA } = await setupDuelUsers(
      browser, 'fl_to_a', 'fl_to_b',
    );
    try {
      await doMatchAndReady(pageA, pageB);

      // Force timeout via dev endpoint
      await triggerDuelTimeout(pageA, userA.id);

      const resultA = await waitForSocketEvent(pageA, 'duel:result', 10_000);
      expect(resultA.result).toBe('timeout');
      expect(resultA.rankChange).toBeNull();

      const resultB = await waitForSocketEvent(pageB, 'duel:result', 10_000);
      expect(resultB.result).toBe('timeout');
      expect(resultB.rankChange).toBeNull();

      // No rank changes in DB
      const rankResA = await pageA.request.get('/api/profile/rank');
      const rankBodyA = await rankResA.json();
      expect(rankBodyA.duelsWon).toBe(0);
      expect(rankBodyA.duelsLost).toBe(0);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  // -------------------------------------------------------------------------
  // Test 4: Protected zone loss (rank 12 — no star change on loss)
  // -------------------------------------------------------------------------
  test('Test 4: protected zone loss — B at rank 12 stars 1 loses, rank unchanged', async ({
    browser,
  }) => {
    const { ctxA, ctxB, pageA, pageB, userA, userB } = await setupDuelUsers(
      browser, 'fl_pz_a', 'fl_pz_b',
    );
    try {
      // Set A and B to rank 12 (within ±2 for matchmaking)
      await setUserRank(pageA, userA.username, 12, 0);
      await setUserRank(pageA, userB.username, 12, 1);

      await doMatchAndReady(pageA, pageB);

      // A wins
      await performWinningLap(pageA, userA.id);

      // Wait for B to receive result
      const resultB = await waitForSocketEvent(pageB, 'duel:result', 10_000);
      expect(resultB.result).toBe('loss');

      // B should still be rank 12, stars 1 (protected zone, no change)
      const rankResB = await pageB.request.get('/api/profile/rank');
      const rankBodyB = await rankResB.json();
      expect(rankBodyB.rank).toBe(12);
      expect(rankBodyB.stars).toBe(1);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: Promotion flow (rank 5 stars 3 → rank 4 stars 0 on win)
  // -------------------------------------------------------------------------
  test('Test 5: promotion flow — A at rank 5 stars 3 wins → rank 4 stars 0', async ({
    browser,
  }) => {
    const { ctxA, ctxB, pageA, pageB, userA, userB } = await setupDuelUsers(
      browser, 'fl_promo_a', 'fl_promo_b',
    );
    try {
      // Set both to rank 5 so matchmaking works (±2)
      await setUserRank(pageA, userA.username, 5, 3);
      await setUserRank(pageA, userB.username, 5, 0);

      await doMatchAndReady(pageA, pageB);

      const resultA = await performWinningLap(pageA, userA.id);
      expect(resultA.result).toBe('win');

      // A should now be rank 4, stars 0
      const rankResA = await pageA.request.get('/api/profile/rank');
      const rankBodyA = await rankResA.json();
      expect(rankBodyA.rank).toBe(4);
      expect(rankBodyA.stars).toBe(0);
      expect(rankBodyA.isLegend).toBe(false);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  // -------------------------------------------------------------------------
  // Test 6: Legend entry (rank 1 stars 3 → is_legend = 1)
  // -------------------------------------------------------------------------
  test('Test 6: legend entry — A at rank 1 stars 3 wins → is_legend = 1', async ({
    browser,
  }) => {
    const { ctxA, ctxB, pageA, pageB, userA, userB } = await setupDuelUsers(
      browser, 'fl_leg_a', 'fl_leg_b',
    );
    try {
      // A at rank 1 stars 3 (legend threshold); B at rank 2 (within ±2)
      await setUserRank(pageA, userA.username, 1, 3);
      await setUserRank(pageA, userB.username, 2, 0);

      await doMatchAndReady(pageA, pageB);

      const resultA = await performWinningLap(pageA, userA.id);
      expect(resultA.result).toBe('win');

      // A should now be legend
      const rankResA = await pageA.request.get('/api/profile/rank');
      const rankBodyA = await rankResA.json();
      expect(rankBodyA.isLegend).toBe(true);
      expect(typeof rankBodyA.legendPosition).toBe('number');
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
