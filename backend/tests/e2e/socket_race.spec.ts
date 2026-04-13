import { test, expect } from '@playwright/test';
import { resetDb, getCsrfToken, registerUser, activateUser, loginUser, setupSocketCapture, waitForSocketEvent } from './helpers';

/**
 * Socket.IO race flow E2E tests.
 *
 * Covers join_race, leave_race, start_lap, end_lap socket events
 * and related REST endpoints (/api/races, /api/leaderboard).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inject fake activeSession into sessionStorage before navigating to /control.
 * This prevents the page from redirecting to /garage.
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
 * Wait for socket connected state and emit join_race.
 */
async function emitJoinRace(
  page: import('@playwright/test').Page,
  carId: number,
  dbUserId: number,
  raceId?: string,
): Promise<void> {
  await page.waitForFunction(
    () => document.getElementById('status-dot')?.classList.contains('connected'),
    { timeout: 10_000 },
  );
  await page.evaluate(
    ({ carId, dbUserId, raceId }) => {
      const payload: any = { carId, carName: 'Test Car', dbUserId };
      if (raceId) payload.raceId = raceId;
      (window as any).__testSocket.emit('join_race', payload);
    },
    { carId, dbUserId, raceId: raceId ?? null },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Socket.IO race flow', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('join_race (no existing raceId) → creates a new race, receives race_joined with raceId, raceName, players', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);

      const user = await registerUser(page, 'race_join', 'race_join@example.com', 'Secure#Pass1');
      await activateUser(page, user.username);

      await setupSocketCapture(page);
      await injectActiveSession(page, 1, user.username, user.id);
      await page.goto('/control');

      await emitJoinRace(page, 1, user.id);

      const data = await waitForSocketEvent(page, 'race_joined');

      expect(data.raceId).toBeTruthy();
      expect(typeof data.raceName).toBe('string');
      expect(Array.isArray(data.players)).toBe(true);
      expect(data.players.length).toBeGreaterThanOrEqual(1);
    } finally {
      await ctx.close();
    }
  });

  test('join_race (with existing raceId) → joins existing race, player count increases to 2', async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();
      await resetDb(pageA);

      const userA = await registerUser(pageA, 'race_join_a', 'race_join_a@example.com', 'Secure#Pass1');
      await activateUser(pageA, userA.username);

      const userB = await registerUser(pageA, 'race_join_b', 'race_join_b@example.com', 'Secure#Pass1');
      await activateUser(pageA, userB.username);

      // Re-login as userA: registerUser(race_join_b) overwrote pageA's session
      await loginUser(pageA, userA.username);

      // Player A creates a new race
      await setupSocketCapture(pageA);
      await injectActiveSession(pageA, 1, userA.username, userA.id);
      await pageA.goto('/control');
      await emitJoinRace(pageA, 1, userA.id);
      const raceA = await waitForSocketEvent(pageA, 'race_joined');
      const raceId = raceA.raceId as string;
      expect(raceId).toBeTruthy();

      // Player B joins the existing race — login in its own context first
      const pageB = await ctxB.newPage();
      await loginUser(pageB, userB.username);
      await setupSocketCapture(pageB);
      await injectActiveSession(pageB, 2, userB.username, userB.id);
      await pageB.goto('/control');
      await emitJoinRace(pageB, 2, userB.id, raceId);

      const raceB = await waitForSocketEvent(pageB, 'race_joined');
      expect(raceB.raceId).toBe(raceId);
      expect(raceB.players.length).toBe(2);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('/api/races returns active race after join_race', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);

      const user = await registerUser(page, 'race_api', 'race_api@example.com', 'Secure#Pass1');
      await activateUser(page, user.username);

      await setupSocketCapture(page);
      await injectActiveSession(page, 1, user.username, user.id);
      await page.goto('/control');
      await emitJoinRace(page, 1, user.id);

      const joined = await waitForSocketEvent(page, 'race_joined');
      const raceId = joined.raceId as string;

      const racesRes = await page.request.get('/api/races');
      expect(racesRes.status()).toBe(200);
      const racesBody = await racesRes.json();
      const match = (racesBody.races as any[]).find((r) => r.id === raceId);
      expect(match).toBeDefined();
      expect(match.playerCount).toBeGreaterThanOrEqual(1);
    } finally {
      await ctx.close();
    }
  });

  test('join_race without auth (non-existent user) → receives race_error with code auth_required', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    // Separate context used only to call resetDb without affecting ctx's session.
    const resetCtx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      const resetPage = await resetCtx.newPage();

      // Clean state via separate context so ctx's session is unaffected.
      await resetDb(resetPage);

      // Register a user in the test context so the /control auth guard passes.
      const user = await registerUser(page, 'race_ghost', 'race_ghost@test.com', 'Secure#Pass1');

      // Reset DB again via separate context: deletes user from DB but keeps ctx's
      // session alive (session.userId still set, user record gone).
      await resetDb(resetPage);

      // Inject a fake session (to prevent /control client redirect) but with a dbUserId that
      // doesn't exist in the DB — the race handler will reject with auth_required.
      await setupSocketCapture(page);
      await injectActiveSession(page, 1, 'ghost', user.id);
      await page.goto('/control');

      // Manually emit join_race with the invalid dbUserId
      await page.waitForFunction(
        () => !!(window as any).__testSocket,
        { timeout: 10_000 },
      );
      await page.evaluate(() => {
        (window as any).__testSocket.emit('join_race', {
          carId: 1,
          carName: 'Test Car',
          dbUserId: 99999,
        });
      });

      const data = await waitForSocketEvent(page, 'race_error');
      expect(data.code).toBe('auth_required');
    } finally {
      await ctx.close();
      await resetCtx.close();
    }
  });

  test('start_lap + end_lap → receives lap_recorded with lapTimeMs > 0', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);

      const user = await registerUser(page, 'race_lap', 'race_lap@example.com', 'Secure#Pass1');
      await activateUser(page, user.username);

      await setupSocketCapture(page);
      await injectActiveSession(page, 1, user.username, user.id);
      await page.goto('/control');
      await emitJoinRace(page, 1, user.id);
      await waitForSocketEvent(page, 'race_joined');

      // Start and end a lap
      await page.evaluate(() => {
        (window as any).__testSocket.emit('start_lap');
      });
      await waitForSocketEvent(page, 'lap_started');

      // Wait a bit so lapTimeMs > 0
      await page.waitForTimeout(120);

      await page.evaluate(() => {
        (window as any).__testSocket.emit('end_lap');
      });

      const lapData = await waitForSocketEvent(page, 'lap_recorded');
      expect(typeof lapData.lapTimeMs).toBe('number');
      expect(lapData.lapTimeMs).toBeGreaterThan(0);
      expect(lapData).toHaveProperty('userId');
      expect(lapData).toHaveProperty('isPersonalBest');
    } finally {
      await ctx.close();
    }
  });

  test('leave_race → receives race_left, race removed from /api/races', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);

      const user = await registerUser(page, 'race_leave', 'race_leave@example.com', 'Secure#Pass1');
      await activateUser(page, user.username);

      await setupSocketCapture(page);
      await injectActiveSession(page, 1, user.username, user.id);
      await page.goto('/control');
      await emitJoinRace(page, 1, user.id);

      const joined = await waitForSocketEvent(page, 'race_joined');
      const raceId = joined.raceId as string;

      // Verify the race exists
      const before = await page.request.get('/api/races');
      const beforeBody = await before.json();
      expect((beforeBody.races as any[]).some((r) => r.id === raceId)).toBe(true);

      // Leave the race
      await page.evaluate(() => {
        (window as any).__testSocket.emit('leave_race');
      });

      await waitForSocketEvent(page, 'race_left');

      // Race should be removed (no more players)
      const after = await page.request.get('/api/races');
      const afterBody = await after.json();
      const remaining = (afterBody.races as any[]).find((r) => r.id === raceId);
      // Either the race is gone or it has 0 players
      expect(!remaining || remaining.playerCount === 0).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  test('lap time appears in /api/leaderboard after end_lap', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);

      const user = await registerUser(page, 'race_lb', 'race_lb@example.com', 'Secure#Pass1');
      await activateUser(page, user.username);

      await setupSocketCapture(page);
      await injectActiveSession(page, 1, user.username, user.id);
      await page.goto('/control');
      await emitJoinRace(page, 1, user.id);
      await waitForSocketEvent(page, 'race_joined');

      // Record a lap
      await page.evaluate(() => (window as any).__testSocket.emit('start_lap'));
      await waitForSocketEvent(page, 'lap_started');
      await page.waitForTimeout(120);
      await page.evaluate(() => (window as any).__testSocket.emit('end_lap'));
      const lap = await waitForSocketEvent(page, 'lap_recorded');
      const lapTimeMs = lap.lapTimeMs as number;
      expect(lapTimeMs).toBeGreaterThan(0);

      // Leaderboard should include the recorded lap
      const lbRes = await page.request.get('/api/leaderboard');
      expect(lbRes.status()).toBe(200);
      const lbBody = await lbRes.json();
      const entry = (lbBody.leaderboard as any[]).find(
        (e) => e.userId === user.username && e.lapTimeMs === lapTimeMs,
      );
      expect(entry).toBeDefined();
    } finally {
      await ctx.close();
    }
  });
});
