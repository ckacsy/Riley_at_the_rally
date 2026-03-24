import { test, expect, Browser } from '@playwright/test';
import path from 'path';

/**
 * Driver presence tests.
 *
 * Validates:
 *  1. When a driver opens /control (Context A), the /broadcast page (Context B)
 *     shows that driver in the "Активные водители" list.
 *  2. The /api/health endpoint exposes the activeDrivers count.
 */

const DB_PATH = path.join(__dirname, '../../riley.sqlite');

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

function activateUser(username: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3');
  const db = new BetterSqlite3(DB_PATH);
  try {
    db.prepare("UPDATE users SET status = 'active' WHERE username = ?").run(username);
  } finally {
    db.close();
  }
}

/** Inject sessionStorage on /control so the page treats itself as having an active session. */
async function injectControlSession(
  page: import('@playwright/test').Page,
  userId: number,
  username: string,
) {
  await page.addInitScript(
    ({ uid, uname }) => {
      sessionStorage.setItem(
        'activeSession',
        JSON.stringify({
          carId: 1,
          carName: 'Riley-X1 · Алый',
          startTime: new Date().toISOString(),
          sessionId: null,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Driver presence', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('driver on /control appears in "Активные водители" on /broadcast', async ({ browser }) => {
    // ── Setup: two separate browser contexts ──────────────────────────────
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();

    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();

      // Reset DB once via pageA (also clears in-memory presenceMap)
      await resetDb(pageA);

      // Register & activate driver (Context A) — register sets session on pageA
      const driverUser = await registerUser(pageA, 'driver_presence', 'driver@example.com', 'Secure#Pass1');
      activateUser(driverUser.username);

      // Register spectator via pageA (separate DB user), then log in on pageB
      const spectatorUser = await registerUser(pageA, 'spectator_presence', 'spectator@example.com', 'Secure#Pass1');
      activateUser(spectatorUser.username);
      await loginUser(pageB, spectatorUser.username, 'Secure#Pass1');

      // ── Context A: open /control with injected session ────────────────
      await injectControlSession(pageA, driverUser.id, driverUser.username);
      // Navigate; the page will emit presence:hello on socket connect
      await pageA.goto('/control');

      // Wait for socket to connect (status dot becomes connected)
      await pageA.waitForFunction(
        () => document.getElementById('status-dot')?.classList.contains('connected'),
        { timeout: 10_000 },
      );

      // ── Context B: open /broadcast ────────────────────────────────────
      await pageB.goto('/broadcast');
      await expect(pageB).toHaveURL(/\/broadcast/, { timeout: 5_000 });

      // Drivers panel should be visible
      const panel = pageB.locator('.drivers-panel');
      await expect(panel).toBeVisible({ timeout: 5_000 });

      // The driver's username must appear in the list
      const driverEntry = pageB.locator('#drivers-list .driver-item .driver-name', {
        hasText: driverUser.username,
      });
      await expect(driverEntry).toBeVisible({ timeout: 10_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('/api/health includes activeDrivers count', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.details.activeDrivers).toBe('number');
    expect(body.details.activeDrivers).toBeGreaterThanOrEqual(0);
  });

  test('empty state: /broadcast shows "Нет активных водителей" when no drivers connected', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();

      // Reset DB (also clears in-memory presenceMap so no stale drivers)
      await resetDb(page);

      const user = await registerUser(page, 'spectator_empty', 'spectator_empty@example.com', 'Secure#Pass1');
      activateUser(user.username);

      // Re-login since resetDb destroys the session created by register
      await loginUser(page, user.username, 'Secure#Pass1');

      await page.goto('/broadcast');
      await expect(page).toHaveURL(/\/broadcast/, { timeout: 5_000 });

      // Empty placeholder should be visible
      const empty = page.locator('#drivers-empty');
      await expect(empty).toBeVisible({ timeout: 5_000 });
      await expect(empty).toContainText('Нет активных водителей');
    } finally {
      await ctx.close();
    }
  });
});

