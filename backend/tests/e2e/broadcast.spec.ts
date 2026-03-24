import { test, expect, Browser } from '@playwright/test';
import path from 'path';

/**
 * Broadcast spectator page tests.
 *
 * Covers:
 *  1. Driver presence — user A opens /control → appears in /broadcast driver list for user B.
 *  2. Global chat — user B sends a message from /broadcast → user A sees it in the control
 *     page chat overlay.
 *  3. Fullscreen toggle — clicking the fullscreen button adds/removes the `is-fullscreen`
 *     CSS class on the viewport container (no real browser fullscreen needed in headless).
 *  4. /broadcast route requires auth — unauthenticated users are redirected to /login.
 */

const DB_PATH = path.join(__dirname, '../../riley.sqlite');

// ── Helpers ────────────────────────────────────────────────────────────────

async function resetDb(page: import('@playwright/test').Page): Promise<void> {
  await page.request.post('/api/dev/reset-db');
}

async function getCsrfToken(page: import('@playwright/test').Page): Promise<string> {
  const res = await page.request.get('/api/csrf-token');
  const body = await res.json();
  return body.csrfToken as string;
}

async function registerAndActivate(
  page: import('@playwright/test').Page,
  username: string,
  email: string,
  password: string,
): Promise<number> {
  const csrf1 = await getCsrfToken(page);
  const regRes = await page.request.post('/api/auth/register', {
    data: { username, email, password, confirm_password: password },
    headers: { 'X-CSRF-Token': csrf1 },
  });
  expect(regRes.status(), `register failed for ${username}: ${await regRes.text()}`).toBe(200);
  const body = await regRes.json();
  const userId: number = body.user.id;

  // Activate directly via SQLite
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3');
  const db = new BetterSqlite3(DB_PATH);
  try {
    db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(userId);
  } finally {
    db.close();
  }

  return userId;
}

async function loginUser(
  page: import('@playwright/test').Page,
  identifier: string,
  password: string,
): Promise<void> {
  const csrf = await getCsrfToken(page);
  const res = await page.request.post('/api/auth/login', {
    data: { identifier, password },
    headers: { 'X-CSRF-Token': csrf },
  });
  expect(res.status(), `login failed for ${identifier}: ${await res.text()}`).toBe(200);
}

/**
 * Inject an active session into sessionStorage via addInitScript so that
 * /control does not redirect to /garage.  Must be called BEFORE page.goto().
 */
async function injectActiveSession(
  page: import('@playwright/test').Page,
  userId: number,
  username: string,
): Promise<void> {
  await page.addInitScript(
    ({ id, uname }) => {
      sessionStorage.setItem(
        'activeSession',
        JSON.stringify({
          carId: 1,
          carName: 'Riley-X1 · Алый',
          dbUserId: id,
          userId: uname,
          startTime: new Date().toISOString(),
        }),
      );
    },
    { id: userId, uname: username },
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe('Broadcast page — /broadcast route', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('GET /broadcast redirects unauthenticated user to /login', async ({ page }) => {
    await page.goto('/broadcast');
    // Client-side init() redirects unauthenticated users to /login
    await expect(page).toHaveURL(/\/login/, { timeout: 8_000 });
  });

  test('GET /broadcast serves the page for authenticated user', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await resetDb(page);
      await registerAndActivate(page, 'bcauth', 'bcauth@test.com', 'Secure#Pass1');
      await loginUser(page, 'bcauth', 'Secure#Pass1');

      // Navigate via browser to ensure session cookie is set in browser context
      await page.goto('/broadcast');
      await page.waitForFunction(
        () => !(document.getElementById('chat-input') as HTMLInputElement)?.disabled,
        { timeout: 8_000 },
      );
      const url = page.url();
      expect(url).toContain('/broadcast');
    } finally {
      await ctx.close();
    }
  });
});

test.describe('Broadcast page — driver presence', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('driver opening /control appears in /broadcast driver list', async ({ browser }: { browser: Browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      // Reset DB and create two users
      await resetDb(pageA);

      const userAId = await registerAndActivate(pageA, 'driverPresA', 'driverPresA@test.com', 'Secure#Pass1');
      await loginUser(pageA, 'driverPresA', 'Secure#Pass1');

      await registerAndActivate(pageB, 'spectPresB', 'spectPresB@test.com', 'Secure#Pass1');
      await loginUser(pageB, 'spectPresB', 'Secure#Pass1');

      // User A: inject session then navigate to /control
      await injectActiveSession(pageA, userAId, 'driverPresA');
      await pageA.goto('/control');

      // Wait for socket to connect (status indicator changes to 'connected')
      await pageA.waitForSelector('#status-dot.connected', { timeout: 8_000 });
      // Brief pause to allow driver:mark to be received and processed server-side
      await pageA.waitForTimeout(400);

      // User B: open /broadcast and wait for auth + socket init
      await pageB.goto('/broadcast');
      await pageB.waitForFunction(
        () => !(document.getElementById('chat-input') as HTMLInputElement)?.disabled,
        { timeout: 8_000 },
      );

      // Wait for the driver list to be populated (presence update received)
      await expect(pageB.locator('#drivers-list')).toContainText('driverPresA', { timeout: 10_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});

test.describe('Broadcast page — global chat', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('user B sends chat from /broadcast; user A on /control receives it in overlay', async ({ browser }: { browser: Browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await resetDb(pageA);

      const userAId = await registerAndActivate(pageA, 'driverChatA', 'driverChatA@test.com', 'Secure#Pass1');
      await loginUser(pageA, 'driverChatA', 'Secure#Pass1');

      await registerAndActivate(pageB, 'spectChatB', 'spectChatB@test.com', 'Secure#Pass1');
      await loginUser(pageB, 'spectChatB', 'Secure#Pass1');

      // User A opens /control
      await injectActiveSession(pageA, userAId, 'driverChatA');
      await pageA.goto('/control');
      await pageA.waitForSelector('#status-dot.connected', { timeout: 8_000 });

      // User A opens the chat overlay
      await pageA.locator('#chat-toggle-btn').click();
      await expect(pageA.locator('#chat-overlay')).not.toHaveClass(/hidden/, { timeout: 5_000 });

      // User B opens /broadcast and waits for auth + socket
      await pageB.goto('/broadcast');
      await pageB.waitForFunction(
        () => !(document.getElementById('chat-input') as HTMLInputElement)?.disabled,
        { timeout: 8_000 },
      );

      // User B sends a chat message
      const testMsg = 'Hello from spectator ' + Date.now();
      await pageB.locator('#chat-input').fill(testMsg);
      await pageB.locator('#chat-send-btn').click();

      // User A should receive the message in the chat overlay
      await expect(pageA.locator('#chat-overlay-messages')).toContainText(testMsg, { timeout: 8_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('chat message from /broadcast is visible to other spectators on /broadcast', async ({ browser }: { browser: Browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await resetDb(pageA);

      await registerAndActivate(pageA, 'spectA2', 'spectA2@test.com', 'Secure#Pass1');
      await loginUser(pageA, 'spectA2', 'Secure#Pass1');

      await registerAndActivate(pageB, 'spectB2', 'spectB2@test.com', 'Secure#Pass1');
      await loginUser(pageB, 'spectB2', 'Secure#Pass1');

      // Both open /broadcast
      await pageA.goto('/broadcast');
      await pageB.goto('/broadcast');

      // Wait for both to be authenticated and chat enabled
      await pageA.waitForFunction(
        () => !(document.getElementById('chat-input') as HTMLInputElement)?.disabled,
        { timeout: 8_000 },
      );
      await pageB.waitForFunction(
        () => !(document.getElementById('chat-input') as HTMLInputElement)?.disabled,
        { timeout: 8_000 },
      );

      const testMsg = 'Spectator chat test ' + Date.now();
      await pageB.locator('#chat-input').fill(testMsg);
      await pageB.locator('#chat-send-btn').click();

      await expect(pageA.locator('#chat-messages')).toContainText(testMsg, { timeout: 8_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});

test.describe('Broadcast page — fullscreen toggle', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  /**
   * The broadcast.html fullscreen button uses an optimistic class toggle,
   * so DOM state changes on click without requiring real browser fullscreen.
   * This test verifies the class and button text toggling in headless mode.
   */
  test('clicking fullscreen button adds is-fullscreen class and changes button text', async ({ browser }: { browser: Browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      await resetDb(page);
      await registerAndActivate(page, 'fsuser', 'fsuser@test.com', 'Secure#Pass1');
      await loginUser(page, 'fsuser', 'Secure#Pass1');

      await page.goto('/broadcast');
      await page.waitForSelector('#viewport-container');
      // Wait for auth to complete (chat-input becomes enabled when init() finishes)
      await page.waitForFunction(
        () => !(document.getElementById('chat-input') as HTMLInputElement)?.disabled,
        { timeout: 8_000 },
      );

      const fsBtn = page.locator('#fullscreen-btn');
      const container = page.locator('#viewport-container');

      // Initial state: not fullscreen
      await expect(container).not.toHaveClass(/is-fullscreen/);
      await expect(fsBtn).toContainText('Полный экран');

      // Click to enter fullscreen — class added optimistically
      await fsBtn.click();
      await expect(container).toHaveClass(/is-fullscreen/, { timeout: 3_000 });
      await expect(fsBtn).toContainText('Свернуть');

      // Click to exit fullscreen — class removed optimistically
      await fsBtn.click();
      await expect(container).not.toHaveClass(/is-fullscreen/, { timeout: 3_000 });
      await expect(fsBtn).toContainText('Полный экран');
    } finally {
      await ctx.close();
    }
  });
});

test.describe('API health — broadcast counts', () => {
  test('/api/health includes activeDrivers, chatMessagesBuffered, broadcastViewers', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.activeDrivers).toBe('number');
    expect(typeof body.chatMessagesBuffered).toBe('number');
    expect(typeof body.broadcastViewers).toBe('number');
  });
});
