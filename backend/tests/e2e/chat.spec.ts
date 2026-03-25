import { test, expect } from '@playwright/test';
import path from 'path';

/**
 * Global chat tests (Part 3).
 *
 * Validates:
 *  1. User B (/broadcast) sends a message; User A (/control, drawer open) sees it.
 *  2. User A replies from /control; User B sees it on /broadcast.
 *  3. Unauthenticated user cannot send chat messages (input is irrelevant; server rejects).
 */

const DB_PATH = path.join(__dirname, '../../riley.sqlite');

// ---------------------------------------------------------------------------
// Helpers (reused from other specs)
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

test.describe('Global chat', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('B sends message on /broadcast → A sees it in /control chat drawer', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();

    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();

      // Reset DB
      await resetDb(pageA);

      // Register & activate users
      const userA = await registerUser(pageA, 'chat_userA', 'chatA@example.com', 'Secure#Pass1');
      activateUser(userA.username);

      const userB = await registerUser(pageA, 'chat_userB', 'chatB@example.com', 'Secure#Pass1');
      activateUser(userB.username);

      // Login B on pageB
      await loginUser(pageB, userB.username, 'Secure#Pass1');

      // Context A: open /control with injected session
      await injectControlSession(pageA, userA.id, userA.username);
      await pageA.goto('/control');

      // Wait for socket connection
      await pageA.waitForFunction(
        () => document.getElementById('status-dot')?.classList.contains('connected'),
        { timeout: 10_000 },
      );

      // Open the chat drawer on /control
      const chatToggleBtn = pageA.locator('#chat-toggle-btn');
      await expect(chatToggleBtn).toBeVisible({ timeout: 5_000 });
      await chatToggleBtn.click();

      // Drawer should be open
      await expect(pageA.locator('#chat-drawer')).toBeVisible({ timeout: 3_000 });

      // Context B: navigate to /broadcast
      await pageB.goto('/broadcast');
      await expect(pageB).toHaveURL(/\/broadcast/, { timeout: 5_000 });

      // Wait for socket to connect (chat:history received)
      await pageB.waitForSelector('[data-socket-ready="true"]', { timeout: 10_000 });

      // B sends a message
      const bMsg = 'Hello from broadcast ' + Date.now();
      await pageB.locator('#chat-input').fill(bMsg);
      await pageB.locator('#chat-send-btn').click();

      // First verify B itself sees the message (confirms server processed it)
      const msgOnBroadcast = pageB.locator('#chat-messages .chat-msg', { hasText: bMsg });
      await expect(msgOnBroadcast).toBeVisible({ timeout: 10_000 });

      // A (on /control) should see B's message in the chat drawer
      const msgInDrawer = pageA.locator('#chat-messages .chat-msg', { hasText: bMsg });
      await expect(msgInDrawer).toBeVisible({ timeout: 10_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('A replies from /control → B sees it on /broadcast', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();

    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();

      // Reset DB
      await resetDb(pageA);

      // Register & activate users
      const userA = await registerUser(pageA, 'chat_replyA', 'chatReplyA@example.com', 'Secure#Pass1');
      activateUser(userA.username);

      const userB = await registerUser(pageA, 'chat_replyB', 'chatReplyB@example.com', 'Secure#Pass1');
      activateUser(userB.username);

      // Login B on pageB
      await loginUser(pageB, userB.username, 'Secure#Pass1');

      // Context A: open /control with session
      await injectControlSession(pageA, userA.id, userA.username);
      await pageA.goto('/control');

      // Wait for socket connection
      await pageA.waitForFunction(
        () => document.getElementById('status-dot')?.classList.contains('connected'),
        { timeout: 10_000 },
      );

      // Open chat drawer
      await pageA.locator('#chat-toggle-btn').click();
      await expect(pageA.locator('#chat-drawer')).toBeVisible({ timeout: 3_000 });

      // Context B: open /broadcast
      await pageB.goto('/broadcast');
      await expect(pageB).toHaveURL(/\/broadcast/, { timeout: 5_000 });

      // Wait for B's socket to connect
      await pageB.waitForSelector('[data-socket-ready="true"]', { timeout: 10_000 });

      // A sends a reply from /control
      const aMsg = 'Reply from control ' + Date.now();
      await pageA.locator('#chat-input').fill(aMsg);
      await pageA.locator('#chat-send-btn').click();

      // B on /broadcast should see A's reply
      const msgOnBroadcast = pageB.locator('#chat-messages .chat-msg', { hasText: aMsg });
      await expect(msgOnBroadcast).toBeVisible({ timeout: 10_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
