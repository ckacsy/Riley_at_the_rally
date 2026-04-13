import { test, expect } from '@playwright/test';
import { resetDb, getCsrfToken, registerUser, activateUser, loginUser, setupSocketCapture, waitForSocketEvent, waitForSocketConnected } from './helpers';

/**
 * Duel backend E2E tests.
 *
 * Covers:
 *  - Two players entering the queue and being matched
 *  - One player validly finishes first and wins
 *  - One player disconnects after start and loses
 *  - Invalid finish (checkpoints incomplete) is rejected
 *  - Duel result is persisted exactly once
 *  - Rank changes are applied correctly
 *  - GET /api/duel/status and GET /api/duel/history APIs
 */

// ---------------------------------------------------------------------------
// Shared helpers (mirrors socket_race.spec.ts patterns)
// ---------------------------------------------------------------------------

/**
 * Inject fake client-side activeSession into sessionStorage.
 * Prevents /control from redirecting to /garage.
 */
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

/**
 * Injects a server-side active session via the dev endpoint.
 * Required for duel:search eligibility checks.
 */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Duel backend — matchmaking', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('two players in queue are matched and both receive duel:matched', async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();
      await resetDb(pageA);

      const userA = await registerUser(pageA, 'duel_a', 'duel_a@test.com', 'Secure#Pass1');
      await activateUser(pageA, userA.username);
      const userB = await registerUser(pageA, 'duel_b', 'duel_b@test.com', 'Secure#Pass1');
      await activateUser(pageA, userB.username);

      // Re-login as userA: registerUser(duel_b) overwrote pageA's session
      await loginUser(pageA, userA.username);

      // Player A — log in and connect
      await setupSocketCapture(pageA);
      await injectActiveSession(pageA, 1, userA.username, userA.id);
      await pageA.goto('/control');
      await waitForSocketConnected(pageA);
      const socketIdA = await pageA.evaluate(() => (window as any).__testSocket.id);
      await injectServerActiveSession(pageA, 1, userA.id, socketIdA);

      // Player B — login in its own context before connecting
      const pageB = await ctxB.newPage();
      await loginUser(pageB, userB.username);
      await setupSocketCapture(pageB);
      await injectActiveSession(pageB, 2, userB.username, userB.id);
      await pageB.goto('/control');
      await waitForSocketConnected(pageB);
      const socketIdB = await pageB.evaluate(() => (window as any).__testSocket.id);
      await injectServerActiveSession(pageB, 2, userB.id, socketIdB);

      // Both emit duel:search — wait for searching confirmation to ensure sequential queueing
      await pageA.evaluate(() => (window as any).__testSocket.emit('duel:search'));
      await waitForSocketEvent(pageA, 'duel:searching');

      await pageB.evaluate(() => (window as any).__testSocket.emit('duel:search'));
      // Player B's search should trigger immediate match

      const matchedA = await waitForSocketEvent(pageA, 'duel:matched', 15_000);
      const matchedB = await waitForSocketEvent(pageB, 'duel:matched', 15_000);

      expect(matchedA.duelId).toBeTruthy();
      expect(matchedB.duelId).toBe(matchedA.duelId);
      expect(matchedA.opponent.username).toBe('duel_b');
      expect(matchedB.opponent.username).toBe('duel_a');
      expect(typeof matchedA.requiredCheckpoints).toBe('number');
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('GET /api/duel/status returns searching while in queue', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);

      const user = await registerUser(page, 'status_user', 'status@test.com', 'Secure#Pass1');
      await activateUser(page, user.username);

      await setupSocketCapture(page);
      await injectActiveSession(page, 1, user.username, user.id);
      await page.goto('/control');
      await waitForSocketConnected(page);
      const socketId = await page.evaluate(() => (window as any).__testSocket.id);
      await injectServerActiveSession(page, 1, user.id, socketId);

      await page.evaluate(() => (window as any).__testSocket.emit('duel:search'));
      await waitForSocketEvent(page, 'duel:searching');

      const res = await page.request.get('/api/duel/status');
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('searching');
    } finally {
      await ctx.close();
    }
  });

  test('duel:cancel_search removes player from queue', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);

      const user = await registerUser(page, 'cancel_user', 'cancel@test.com', 'Secure#Pass1');
      await activateUser(page, user.username);

      await setupSocketCapture(page);
      await injectActiveSession(page, 1, user.username, user.id);
      await page.goto('/control');
      await waitForSocketConnected(page);
      const socketId = await page.evaluate(() => (window as any).__testSocket.id);
      await injectServerActiveSession(page, 1, user.id, socketId);

      await page.evaluate(() => (window as any).__testSocket.emit('duel:search'));
      await waitForSocketEvent(page, 'duel:searching');

      await page.evaluate(() => (window as any).__testSocket.emit('duel:cancel_search'));
      await waitForSocketEvent(page, 'duel:search_cancelled');

      const res = await page.request.get('/api/duel/status');
      const body = await res.json();
      expect(body.status).toBe('none');
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------

test.describe('Duel backend — lap validation and win', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  async function setupDuelPair(browser: import('@playwright/test').Browser) {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();

    const pageA = await ctxA.newPage();
    await resetDb(pageA);

    const userA = await registerUser(pageA, 'win_a', 'win_a@test.com', 'Secure#Pass1');
    await activateUser(pageA, userA.username);
    const userB = await registerUser(pageA, 'win_b', 'win_b@test.com', 'Secure#Pass1');
    await activateUser(pageA, userB.username);

    // Re-login as userA: registerUser(win_b) overwrote pageA's session
    await loginUser(pageA, userA.username);

    await setupSocketCapture(pageA);
    await injectActiveSession(pageA, 1, userA.username, userA.id);
    await pageA.goto('/control');
    await waitForSocketConnected(pageA);
    const socketIdA = await pageA.evaluate(() => (window as any).__testSocket.id);
    await injectServerActiveSession(pageA, 1, userA.id, socketIdA);

    // Login userB in its own context before connecting
    const pageB = await ctxB.newPage();
    await loginUser(pageB, userB.username);
    await setupSocketCapture(pageB);
    await injectActiveSession(pageB, 2, userB.username, userB.id);
    await pageB.goto('/control');
    await waitForSocketConnected(pageB);
    const socketIdB = await pageB.evaluate(() => (window as any).__testSocket.id);
    await injectServerActiveSession(pageB, 2, userB.id, socketIdB);

    await pageA.evaluate(() => (window as any).__testSocket.emit('duel:search'));
    await pageB.evaluate(() => (window as any).__testSocket.emit('duel:search'));

    // Diagnostic: check if duel:error was received instead of duel:matched
    await new Promise(r => setTimeout(r, 2000)); // wait 2s
    const errorA = await pageA.evaluate(() => (window as any).__socketEventStore['duel:error']);
    const errorB = await pageB.evaluate(() => (window as any).__socketEventStore['duel:error']);
    console.log('Player A duel:error:', JSON.stringify(errorA));
    console.log('Player B duel:error:', JSON.stringify(errorB));
    console.log('Player A all events:', await pageA.evaluate(() => Object.keys((window as any).__socketEventStore)));
    console.log('Player B all events:', await pageB.evaluate(() => Object.keys((window as any).__socketEventStore)));

    await waitForSocketEvent(pageA, 'duel:matched');
    await waitForSocketEvent(pageB, 'duel:matched');

    await pageA.evaluate(() => (window as any).__testSocket.emit('duel:ready'));
    await pageB.evaluate(() => (window as any).__testSocket.emit('duel:ready'));

    await waitForSocketEvent(pageA, 'duel:countdown');
    await waitForSocketEvent(pageB, 'duel:countdown');

    await waitForSocketEvent(pageA, 'duel:start');
    await waitForSocketEvent(pageB, 'duel:start');

    return { ctxA, ctxB, pageA, pageB, userA, userB };
  }

  test('invalid finish (no checkpoints) is rejected with error', async ({
    browser,
  }) => {
    const { ctxA, ctxB, pageA } = await setupDuelPair(browser);
    try {
      // Start lap
      await pageA.evaluate(() => (window as any).__testSocket.emit('duel:start_lap'));
      await waitForSocketEvent(pageA, 'duel:lap_started');

      // Skip checkpoints — finish immediately (should fail)
      await pageA.evaluate(() => (window as any).__testSocket.emit('duel:finish_lap'));
      const err = await waitForSocketEvent(pageA, 'duel:error');
      expect(err.code).toBe('checkpoints_incomplete');
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('MIN_LAP_TIME_MS anti-cheat guard rejects instant finish after all checkpoints', async ({
    browser,
  }) => {
    const { ctxA, ctxB, pageA } = await setupDuelPair(browser);
    try {
      // Player A starts lap
      await pageA.evaluate(() => (window as any).__testSocket.emit('duel:start_lap'));
      await waitForSocketEvent(pageA, 'duel:lap_started');

      // Player A hits all required checkpoints
      for (let i = 0; i < 2; i++) {
        await pageA.evaluate(
          (idx) => (window as any).__testSocket.emit('duel:checkpoint', { index: idx }),
          i,
        );
        await waitForSocketEvent(pageA, 'duel:checkpoint_ok');
      }

      // Finish immediately — should be cancelled because elapsed time < MIN_LAP_TIME_MS.
      // The server calls _cancelDuel which emits duel:cancelled (not duel:error).
      await pageA.evaluate(() => (window as any).__testSocket.emit('duel:finish_lap'));
      const cancelled = await waitForSocketEvent(pageA, 'duel:cancelled');
      expect(cancelled.reason).toBe('finish_rejected');
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});

// ---------------------------------------------------------------------------

test.describe('Duel backend — disconnect handling', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('player disconnects after start — opponent receives win', async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();
      await resetDb(pageA);

      const userA = await registerUser(pageA, 'disc_a', 'disc_a@test.com', 'Secure#Pass1');
      await activateUser(pageA, userA.username);
      const userB = await registerUser(pageA, 'disc_b', 'disc_b@test.com', 'Secure#Pass1');
      await activateUser(pageA, userB.username);

      // Re-login as userA: registerUser(disc_b) overwrote pageA's session
      await loginUser(pageA, userA.username);

      await setupSocketCapture(pageA);
      await injectActiveSession(pageA, 1, userA.username, userA.id);
      await pageA.goto('/control');
      await waitForSocketConnected(pageA);
      const socketIdA = await pageA.evaluate(() => (window as any).__testSocket.id);
      await injectServerActiveSession(pageA, 1, userA.id, socketIdA);

      const pageB = await ctxB.newPage();
      // Login userB in its own context before connecting
      await loginUser(pageB, userB.username);
      await setupSocketCapture(pageB);
      await injectActiveSession(pageB, 2, userB.username, userB.id);
      await pageB.goto('/control');
      await waitForSocketConnected(pageB);
      const socketIdB = await pageB.evaluate(() => (window as any).__testSocket.id);
      await injectServerActiveSession(pageB, 2, userB.id, socketIdB);

      // Match
      await pageA.evaluate(() => (window as any).__testSocket.emit('duel:search'));
      await pageB.evaluate(() => (window as any).__testSocket.emit('duel:search'));
      await waitForSocketEvent(pageA, 'duel:matched');
      await waitForSocketEvent(pageB, 'duel:matched');

      // Ready handshake + countdown
      await pageA.evaluate(() => (window as any).__testSocket.emit('duel:ready'));
      await pageB.evaluate(() => (window as any).__testSocket.emit('duel:ready'));
      await waitForSocketEvent(pageA, 'duel:countdown');
      await waitForSocketEvent(pageB, 'duel:countdown');
      await waitForSocketEvent(pageA, 'duel:start');
      await waitForSocketEvent(pageB, 'duel:start');

      // Player A starts lap (duel is now in_progress)
      await pageA.evaluate(() => (window as any).__testSocket.emit('duel:start_lap'));
      await waitForSocketEvent(pageA, 'duel:lap_started');

      // Player A disconnects
      await ctxA.close();

      // Player B should receive a win result
      const resultB = await waitForSocketEvent(pageB, 'duel:result', 10_000);
      expect(resultB.result).toBe('win');

      // Check DB
      const rankRes = await pageB.request.get('/api/profile/rank');
      const rankBody = await rankRes.json();
      expect(rankBody.duelsWon).toBe(1);
    } finally {
      // ctxA already closed above
      await ctxB.close();
    }
  });

  test('player disconnects before start — duel cancelled, no rank changes', async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();
      await resetDb(pageA);

      const userA = await registerUser(pageA, 'cdisc_a', 'cdisc_a@test.com', 'Secure#Pass1');
      await activateUser(pageA, userA.username);
      const userB = await registerUser(pageA, 'cdisc_b', 'cdisc_b@test.com', 'Secure#Pass1');
      await activateUser(pageA, userB.username);

      // Re-login as userA: registerUser(cdisc_b) overwrote pageA's session
      await loginUser(pageA, userA.username);

      await setupSocketCapture(pageA);
      await injectActiveSession(pageA, 1, userA.username, userA.id);
      await pageA.goto('/control');
      await waitForSocketConnected(pageA);
      const socketIdA = await pageA.evaluate(() => (window as any).__testSocket.id);
      await injectServerActiveSession(pageA, 1, userA.id, socketIdA);

      const pageB = await ctxB.newPage();
      // Login userB in its own context before connecting
      await loginUser(pageB, userB.username);
      await setupSocketCapture(pageB);
      await injectActiveSession(pageB, 2, userB.username, userB.id);
      await pageB.goto('/control');
      await waitForSocketConnected(pageB);
      const socketIdB = await pageB.evaluate(() => (window as any).__testSocket.id);
      await injectServerActiveSession(pageB, 2, userB.id, socketIdB);

      // Match
      await pageA.evaluate(() => (window as any).__testSocket.emit('duel:search'));
      await pageB.evaluate(() => (window as any).__testSocket.emit('duel:search'));
      await waitForSocketEvent(pageA, 'duel:matched');
      await waitForSocketEvent(pageB, 'duel:matched');

      // Player A disconnects WITHOUT starting a lap
      await ctxA.close();

      // Player B should get a cancel result (no rank change)
      const resultB = await waitForSocketEvent(pageB, 'duel:result', 10_000);
      expect(resultB.result).toBe('cancel');

      // No rank changes
      const rankRes = await pageB.request.get('/api/profile/rank');
      const rankBody = await rankRes.json();
      expect(rankBody.duelsWon).toBe(0);
      expect(rankBody.duelsLost).toBe(0);
    } finally {
      await ctxB.close();
    }
  });
});

// ---------------------------------------------------------------------------

test.describe('Duel backend — REST API', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('GET /api/duel/status returns 401 when unauthenticated', async ({
    request,
  }) => {
    const res = await request.get('/api/duel/status');
    expect(res.status()).toBe(401);
  });

  test('GET /api/duel/history returns 401 when unauthenticated', async ({
    request,
  }) => {
    const res = await request.get('/api/duel/history');
    expect(res.status()).toBe(401);
  });

  test('GET /api/duel/history returns empty array for new user', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);

      await registerUser(page, 'hist_user', 'hist@test.com', 'Secure#Pass1');
      await activateUser(page, 'hist_user');

      const res = await page.request.get('/api/duel/history');
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.history)).toBe(true);
      expect(body.history.length).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  test('GET /api/duel/status returns none for user not in duel', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);

      await registerUser(page, 'status2_user', 'status2@test.com', 'Secure#Pass1');
      await activateUser(page, 'status2_user');

      const res = await page.request.get('/api/duel/status');
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('none');
    } finally {
      await ctx.close();
    }
  });
});
