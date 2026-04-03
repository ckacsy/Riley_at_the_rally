import { test, expect } from '@playwright/test';

/**
 * Socket.IO session flow E2E tests.
 *
 * Covers start_session → session_started → end_session → session_ended
 * and related REST endpoints (/api/car-status, /api/session/end, /api/cars).
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
 * Intercept the socket.io io() call via Object.defineProperty so that:
 *  - window.__testSocket is set to the created socket
 *  - window.__socketEventStore[eventName] is populated when events arrive
 *
 * Must be called before page.goto().
 */
async function setupSocketCapture(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__socketEventStore = {};

    // Intercept the assignment of window.io by the socket.io client script.
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

          const trackedEvents = [
            'session_started',
            'session_error',
            'session_ended',
            'race_joined',
            'race_error',
            'race_left',
            'lap_started',
            'lap_recorded',
          ];
          for (const evt of trackedEvents) {
            sock.on(evt, (data: any) => {
              // Store the event data. For events emitted without arguments,
              // store null so that hasOwnProperty check still detects arrival.
              (window as any).__socketEventStore[evt] = data !== undefined ? data : null;
            });
          }

          return sock;
        };
      },
    });
  });
}

/**
 * Wait for a socket event to appear in __socketEventStore and return its data.
 * Handles both "already received" and "not yet received" cases.
 */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Socket.IO session flow', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('start_session → receives session_started with carId, sessionId, sessionMaxDurationMs, inactivityTimeoutMs', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);

      const user = await registerUser(page, 'sess_start', 'sess_start@example.com', 'Secure#Pass1');
      await activateUser(page, user.username);

      await setupSocketCapture(page);
      await injectActiveSession(page, 1, user.username, user.id);
      await page.goto('/control');

      const data = await waitForSocketEvent(page, 'session_started');

      expect(data).toHaveProperty('carId', 1);
      expect(data).toHaveProperty('sessionId');
      expect(typeof data.sessionId).toBe('string');
      expect(data.sessionId.length).toBeGreaterThan(0);
      expect(data).toHaveProperty('sessionMaxDurationMs');
      expect(typeof data.sessionMaxDurationMs).toBe('number');
      expect(data.sessionMaxDurationMs).toBeGreaterThan(0);
      expect(data).toHaveProperty('inactivityTimeoutMs');
      expect(typeof data.inactivityTimeoutMs).toBe('number');
      expect(data.inactivityTimeoutMs).toBeGreaterThan(0);
    } finally {
      await ctx.close();
    }
  });

  test('start_session without auth (unknown user) → receives session_error with code auth_required', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    // Separate context used only to call resetDb without affecting ctx's session.
    const resetCtx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      const resetPage = await resetCtx.newPage();

      // Use the reset context to clean the DB (this destroys resetCtx's session,
      // but ctx's session is unaffected).
      await resetDb(resetPage);

      // Register a user in the test context so the server session has a userId.
      const user = await registerUser(page, 'ghosttest', 'ghosttest@test.com', 'Secure#Pass1');

      // Now reset the DB again via the separate context: all users are deleted
      // from the DB, but ctx's server-side session (session.userId = user.id)
      // is still alive. When /control loads, the auth guard passes (session.userId
      // is set), but the socket's start_session handler cannot find the user in DB
      // → emits session_error with code auth_required.
      await resetDb(resetPage);

      // Inject session with a dbUserId that no longer exists in the DB
      await setupSocketCapture(page);
      await injectActiveSession(page, 1, 'ghost', user.id);
      await page.goto('/control');

      const data = await waitForSocketEvent(page, 'session_error');
      expect(data.code).toBe('auth_required');
    } finally {
      await ctx.close();
      await resetCtx.close();
    }
  });

  test('start_session on already-occupied car → receives session_error about car being busy', async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();
      await resetDb(pageA);

      const userA = await registerUser(pageA, 'sess_car_a', 'sess_car_a@example.com', 'Secure#Pass1');
      await activateUser(pageA, userA.username);

      const userB = await registerUser(pageA, 'sess_car_b', 'sess_car_b@example.com', 'Secure#Pass1');
      await activateUser(pageA, userB.username);

      // Restore pageA's session to userA (registering userB above overwrote the session).
      await loginUser(pageA, userA.username);

      // Context A: start a session on car 1
      await setupSocketCapture(pageA);
      await injectActiveSession(pageA, 1, userA.username, userA.id);
      await pageA.goto('/control');
      await waitForSocketEvent(pageA, 'session_started');

      // Context B: try to start a session on the same car.
      // Login userB so pageB can access /control (required after PR #159 auth guard).
      const pageB = await ctxB.newPage();
      await loginUser(pageB, userB.username);
      await setupSocketCapture(pageB);
      await injectActiveSession(pageB, 1, userB.username, userB.id);
      await pageB.goto('/control');

      const errData = await waitForSocketEvent(pageB, 'session_error');
      // session_error received means the server correctly rejected the duplicate session request
      expect(errData.message).toBeTruthy();
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('start_session while user already has active session on another car → receives session_error with code session_already_active', async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();
      await resetDb(pageA);

      const user = await registerUser(pageA, 'sess_user_dup', 'sess_user_dup@example.com', 'Secure#Pass1');
      await activateUser(pageA, user.username);

      // Context A (same user): start a session on car 1
      await setupSocketCapture(pageA);
      await injectActiveSession(pageA, 1, user.username, user.id);
      await pageA.goto('/control');
      await waitForSocketEvent(pageA, 'session_started');

      // Context B (same user): try to start a session on car 2
      // Login the same user in context B so the server-side session is authenticated
      const pageB = await ctxB.newPage();
      await loginUser(pageB, user.username);
      await setupSocketCapture(pageB);
      await injectActiveSession(pageB, 2, user.username, user.id);
      await pageB.goto('/control');

      const errData = await waitForSocketEvent(pageB, 'session_error');
      expect(errData.code).toBe('session_already_active');

      // First session on context A must still be active (not ended)
      const carsRes = await pageA.request.get('/api/cars');
      expect(carsRes.status()).toBe(200);
      const carsBody = await carsRes.json();
      const car1 = (carsBody.cars as any[]).find((c: any) => c.id === 1);
      expect(car1).toBeTruthy();
      expect(car1.status).toBe('unavailable');
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('end_session → receives session_ended with durationSeconds and cost', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);

      const user = await registerUser(page, 'sess_end', 'sess_end@example.com', 'Secure#Pass1');
      await activateUser(page, user.username);

      await setupSocketCapture(page);
      await injectActiveSession(page, 1, user.username, user.id);
      await page.goto('/control');

      // Wait for session to start
      const started = await waitForSocketEvent(page, 'session_started');
      expect(started.carId).toBe(1);

      // Wait a moment, then end the session
      await page.waitForTimeout(150);
      await page.evaluate(() => {
        (window as any).__testSocket.emit('end_session', {});
      });

      const ended = await waitForSocketEvent(page, 'session_ended');
      expect(ended).toHaveProperty('carId', 1);
      expect(typeof ended.durationSeconds).toBe('number');
      expect(ended.durationSeconds).toBeGreaterThanOrEqual(0);
      expect(typeof ended.cost).toBe('number');
      expect(ended.cost).toBeGreaterThanOrEqual(0);
    } finally {
      await ctx.close();
    }
  });

  test('/api/car-status returns busy when session active, available after session ends', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);

      const user = await registerUser(page, 'sess_carstatus', 'sess_cs@example.com', 'Secure#Pass1');
      await activateUser(page, user.username);

      await setupSocketCapture(page);
      await injectActiveSession(page, 1, user.username, user.id);
      await page.goto('/control');

      // Wait for session to be registered on server
      await waitForSocketEvent(page, 'session_started');

      const busyRes = await page.request.get('/api/car-status');
      expect(busyRes.status()).toBe(200);
      const busyBody = await busyRes.json();
      expect(busyBody.status).toBe('busy');

      // End the session
      await page.evaluate(() => {
        (window as any).__testSocket.emit('end_session', {});
      });
      await waitForSocketEvent(page, 'session_ended');

      const availRes = await page.request.get('/api/car-status');
      const availBody = await availRes.json();
      expect(availBody.status).toBe('available');
    } finally {
      await ctx.close();
    }
  });

  test('/api/session/end (HTTP beacon) ends an active session → returns ended: true', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);

      const user = await registerUser(page, 'sess_beacon', 'sess_beacon@example.com', 'Secure#Pass1');
      await activateUser(page, user.username);

      await setupSocketCapture(page);
      await injectActiveSession(page, 1, user.username, user.id);
      await page.goto('/control');

      // Get sessionId from session_started (it equals the socket.id on the server)
      const started = await waitForSocketEvent(page, 'session_started');
      const sessionId = started.sessionId;
      expect(typeof sessionId).toBe('string');

      // End via HTTP beacon endpoint (no CSRF required — used by sendBeacon)
      const endRes = await page.request.post('/api/session/end', {
        data: { sessionId, dbUserId: user.id },
      });
      expect(endRes.status()).toBe(200);
      const endBody = await endRes.json();
      expect(endBody.ended).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  test('/api/cars shows unavailable for occupied car, available after session ends', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);

      const user = await registerUser(page, 'sess_cars_api', 'sess_cars@example.com', 'Secure#Pass1');
      await activateUser(page, user.username);

      await setupSocketCapture(page);
      await injectActiveSession(page, 1, user.username, user.id);
      await page.goto('/control');

      await waitForSocketEvent(page, 'session_started');

      // Car 1 should be unavailable
      const carsRes = await page.request.get('/api/cars');
      expect(carsRes.status()).toBe(200);
      const carsBody = await carsRes.json();
      const car1 = (carsBody.cars as any[]).find((c) => c.id === 1);
      expect(car1).toBeDefined();
      expect(car1.status).toBe('unavailable');

      // End session and verify car becomes available
      await page.evaluate(() => {
        (window as any).__testSocket.emit('end_session', {});
      });
      await waitForSocketEvent(page, 'session_ended');

      const carsRes2 = await page.request.get('/api/cars');
      const carsBody2 = await carsRes2.json();
      const car1After = (carsBody2.cars as any[]).find((c) => c.id === 1);
      expect(car1After?.status).toBe('available');
    } finally {
      await ctx.close();
    }
  });
});
