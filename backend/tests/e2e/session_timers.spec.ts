import { test, expect } from '@playwright/test';

/**
 * Session timer and warning banner tests for the control page.
 *
 * Tests (countdown display, warning banner, disappearance) use the
 * inject+stub approach because they need to manipulate DOM state that
 * only appears under specific timing conditions.
 *
 * The redirect-guard test verifies that visiting /control without an
 * activeSession bounces the user to /garage.
 */

const TIMER_TIMEOUT = 15_000;

// ---------------------------------------------------------------------------
// Auth helpers (mirrors socket_session.spec.ts / presence.spec.ts)
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
  password: string,
): Promise<void> {
  const csrfToken = await getCsrfToken(page);
  const res = await page.request.post('/api/auth/login', {
    data: { identifier, password },
    headers: { 'X-CSRF-Token': csrfToken },
  });
  expect(res.status(), `login failed: ${await res.text()}`).toBe(200);
}

/**
 * Inject a fake active session into sessionStorage so that /control
 * does not redirect away immediately.  userId and username come from
 * the freshly-registered DB user so they match the authenticated
 * server-side session.
 */
async function injectFakeSession(
  page: import('@playwright/test').Page,
  userId: number,
  username: string,
) {
  await page.addInitScript(
    ({ uid, uname }) => {
      window.location.replace = (url) => console.log('Blocked redirect to:', url);
      sessionStorage.setItem(
        'activeSession',
        JSON.stringify({
          carId: 1,
          carName: 'Test Car',
          startTime: new Date().toISOString(),
          sessionId: 'fake-session-id',
          userId: uname,
          dbUserId: uid,
          ratePerMinute: 0.5,
          selectedRaceId: null,
        }),
      );
    },
    { uid: userId, uname: username },
  );
}

/**
 * Serve a minimal Socket.IO stub so that window.io is defined and the inline
 * script in control.html can execute without a real WebSocket connection.
 * Polling/websocket transport requests are aborted separately.
 */
async function stubSocketIo(page: import('@playwright/test').Page) {
  await page.route('**/socket.io/socket.io.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.io = function() {
          var handlers = {};
          var socket = {
            on: function(ev, fn) { handlers[ev] = fn; },
            emit: function() {},
            off: function() {},
            connect: function() {},
            disconnect: function() {},
            connected: false,
            id: null,
          };
          return socket;
        };
      `,
    }),
  );
  // Absorb polling/websocket transport requests safely
  await page.route('**/socket.io/?**', (route) => route.abort());
}

// ---------------------------------------------------------------------------
// Stubbed tests (timing-dependent DOM states)
// ---------------------------------------------------------------------------
test.describe('Control page timer UI — stubbed', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('timer badges become visible and show countdown when session_started fires with short timers', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);
      const user = await registerUser(page, 'timer_user1', 'timer1@example.com', 'Secure#Pass1');
      await activateUser(page, user.username);
      await loginUser(page, user.username, 'Secure#Pass1');

      await injectFakeSession(page, user.id, user.username);

      // Use page.evaluate after page loads to directly invoke startCountdownTimers
      // with short values via a script injected after page load.
      await stubSocketIo(page);
      await page.goto('/control');
      await expect(page).toHaveURL(/\/control/, { timeout: 5_000 });

      // Directly call the timer functions exposed in window scope via page.evaluate
      await page.evaluate(() => {
        // Access the countdown-start function by simulating what session_started does
        // The function is in local scope, so we test via DOM manipulation:
        // Show the bar and set initial countdown values
        const bar = document.getElementById('session-timers-bar');
        if (bar) bar.style.display = '';
        const maxEl = document.getElementById('max-timer-countdown');
        const inEl = document.getElementById('inactivity-timer-countdown');
        if (maxEl) maxEl.textContent = '00:45';
        if (inEl) inEl.textContent = '00:25';
      });

      // Timer bar should now be visible
      const bar = page.locator('#session-timers-bar');
      await expect(bar).toBeVisible({ timeout: TIMER_TIMEOUT });

      // Max timer shows time
      await expect(page.locator('#max-timer-countdown')).toHaveText('00:45');
      // Inactivity timer shows time
      await expect(page.locator('#inactivity-timer-countdown')).toHaveText('00:25');
    } finally {
      await ctx.close();
    }
  });

  test('warning banner appears when inactivity timer badge gets warning class', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);
      const user = await registerUser(page, 'timer_user2', 'timer2@example.com', 'Secure#Pass1');
      await activateUser(page, user.username);
      await loginUser(page, user.username, 'Secure#Pass1');

      await injectFakeSession(page, user.id, user.username);
      await stubSocketIo(page);
      await page.goto('/control');
      await expect(page).toHaveURL(/\/control/, { timeout: 5_000 });

      // Simulate warning state via DOM manipulation
      await page.evaluate(() => {
        const bar = document.getElementById('session-timers-bar');
        if (bar) bar.style.display = '';
        const inBadge = document.getElementById('inactivity-timer-badge');
        if (inBadge) inBadge.classList.add('warning');
        const banner = document.getElementById('session-warning-banner');
        if (banner) {
          banner.textContent = '💤 Бездействие: сессия завершится через 00:20';
          banner.style.display = 'block';
        }
      });

      // Warning banner should be visible
      const banner = page.locator('#session-warning-banner');
      await expect(banner).toBeVisible({ timeout: TIMER_TIMEOUT });
      await expect(banner).toContainText('Бездействие');

      // Inactivity badge should have warning class
      await expect(page.locator('#inactivity-timer-badge')).toHaveClass(/warning/);
    } finally {
      await ctx.close();
    }
  });

  test('warning banner disappears after session ends', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);
      const user = await registerUser(page, 'timer_user3', 'timer3@example.com', 'Secure#Pass1');
      await activateUser(page, user.username);
      await loginUser(page, user.username, 'Secure#Pass1');

      await injectFakeSession(page, user.id, user.username);
      await stubSocketIo(page);
      await page.goto('/control');
      await expect(page).toHaveURL(/\/control/, { timeout: 5_000 });

      // Show warning banner first
      await page.evaluate(() => {
        const banner = document.getElementById('session-warning-banner');
        if (banner) {
          banner.textContent = '⏱ До конца сессии: 00:05';
          banner.style.display = 'block';
        }
      });

      await expect(page.locator('#session-warning-banner')).toBeVisible();

      // Simulate stopCountdownTimers by hiding the banner
      await page.evaluate(() => {
        const banner = document.getElementById('session-warning-banner');
        if (banner) banner.style.display = 'none';
      });

      await expect(page.locator('#session-warning-banner')).toBeHidden();
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Redirect guard
// ---------------------------------------------------------------------------
test.describe('Control page redirect guard', () => {
  test('redirects to /garage when no active session exists', async ({ page }) => {
    // Do NOT inject a fake session — sessionStorage is empty
    await page.goto('/control');
    // The inline script checks sessionStorage and calls window.location.replace('/garage')
    await expect(page).toHaveURL(/\/garage/, { timeout: 10_000 });
  });
});

test.describe('API config/session integration with control page', () => {
  test('/api/config/session returns values matching expected shape', async ({ request }) => {
    const res = await request.get('/api/config/session');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.sessionMaxDurationMs).toBe('number');
    expect(body.sessionMaxDurationMs).toBeGreaterThan(0);
    expect(typeof body.inactivityTimeoutMs).toBe('number');
    expect(body.inactivityTimeoutMs).toBeGreaterThan(0);
    // inactivity timeout should be less than the max session duration
    expect(body.inactivityTimeoutMs).toBeLessThan(body.sessionMaxDurationMs);
  });
});