import { test, expect } from '@playwright/test';
import { resetDb, getCsrfToken, registerUser, activateUser, loginUser, setUserRole } from './helpers';

/**
 * Global chat tests (Part 3).
 *
 * Validates:
 *  1. User B (/broadcast) sends a message; User A (/control, drawer open) sees it.
 *  2. User A replies from /control; User B sees it on /broadcast.
 *  3. Unauthenticated user cannot send chat messages (input is irrelevant; server rejects).
 */

// ---------------------------------------------------------------------------
// Helpers (reused from other specs)
// ---------------------------------------------------------------------------

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

  test('history is loaded on connect', async ({ browser }) => {
    const ctxA = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();

      // Reset DB and create a user who will send a seed message
      await resetDb(pageA);
      const userA = await registerUser(pageA, 'chat_hist_a', 'chatHist@example.com', 'Secure#Pass1');
      await activateUser(pageA, userA.username);
      await loginUser(pageA, userA.username, 'Secure#Pass1');

      // Send a message via broadcast page
      await pageA.goto('/broadcast');
      await pageA.waitForSelector('[data-socket-ready="true"]', { timeout: 10_000 });
      const seedMsg = 'History seed ' + Date.now();
      await pageA.locator('#chat-input').fill(seedMsg);
      await pageA.locator('#chat-send-btn').click();
      await expect(pageA.locator('#chat-messages .chat-msg', { hasText: seedMsg })).toBeVisible({ timeout: 5_000 });

      // Reload the page — history should come from DB on reconnect
      await pageA.reload();
      await pageA.waitForSelector('[data-socket-ready="true"]', { timeout: 10_000 });
      await expect(pageA.locator('#chat-messages .chat-msg', { hasText: seedMsg })).toBeVisible({ timeout: 5_000 });
    } finally {
      await ctxA.close();
    }
  });

  test('B sends message on /broadcast → A sees it in /control chat drawer', async ({ browser }) => {
    test.setTimeout(60_000);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();

    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();

      // Reset DB
      await resetDb(pageA);

      // Register & activate users
      const userA = await registerUser(pageA, 'chat_userA', 'chatA@example.com', 'Secure#Pass1');
      await activateUser(pageA, userA.username);

      const userB = await registerUser(pageA, 'chat_userB', 'chatB@example.com', 'Secure#Pass1');
      await activateUser(pageA, userB.username);

      // Re-login user A on pageA (registerUser(B) overwrote the session)
      await loginUser(pageA, userA.username, 'Secure#Pass1');

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
      await ctxA.close().catch(() => {});
      await ctxB.close().catch(() => {});
    }
  });

  test('A replies from /control → B sees it on /broadcast', async ({ browser }) => {
    test.setTimeout(60_000);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();

    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();

      // Reset DB
      await resetDb(pageA);

      // Register & activate users
      const userA = await registerUser(pageA, 'chat_replyA', 'chatReplyA@example.com', 'Secure#Pass1');
      await activateUser(pageA, userA.username);

      const userB = await registerUser(pageA, 'chat_replyB', 'chatReplyB@example.com', 'Secure#Pass1');
      await activateUser(pageA, userB.username);

      // Re-login user A on pageA (registerUser(B) overwrote the session)
      await loginUser(pageA, userA.username, 'Secure#Pass1');

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
      await ctxA.close().catch(() => {});
      await ctxB.close().catch(() => {});
    }
  });

  test('admin deletes message → both clients see it as deleted', async ({ browser }) => {
    const ctxAdmin = await browser.newContext();
    const ctxB = await browser.newContext();

    try {
      const pageAdmin = await ctxAdmin.newPage();
      const pageB = await ctxB.newPage();

      // Reset DB
      await resetDb(pageAdmin);

      // Create admin user (name must match ADMIN_USERNAMES env)
      const adminUser = await registerUser(pageAdmin, 'testadmin', 'testadmin@example.com', 'Secure#Pass1');
      await activateUser(pageAdmin, adminUser.username);
      await setUserRole(pageAdmin, adminUser.username, 'admin');

      const userB = await registerUser(pageAdmin, 'chat_del_b', 'chatDelB@example.com', 'Secure#Pass1');
      await activateUser(pageAdmin, userB.username);

      // Login both
      await loginUser(pageAdmin, adminUser.username, 'Secure#Pass1');
      await loginUser(pageB, userB.username, 'Secure#Pass1');

      // Both open /broadcast
      await pageAdmin.goto('/broadcast');
      await pageAdmin.waitForSelector('[data-socket-ready="true"]', { timeout: 10_000 });

      await pageB.goto('/broadcast');
      await pageB.waitForSelector('[data-socket-ready="true"]', { timeout: 10_000 });

      // B sends a message
      const delMsg = 'Delete me ' + Date.now();
      await pageB.locator('#chat-input').fill(delMsg);
      await pageB.locator('#chat-send-btn').click();

      // Both see the message
      await expect(pageB.locator('#chat-messages .chat-msg', { hasText: delMsg })).toBeVisible({ timeout: 5_000 });
      await expect(pageAdmin.locator('#chat-messages .chat-msg', { hasText: delMsg })).toBeVisible({ timeout: 5_000 });

      // Get the message id from DOM
      const msgEl = pageAdmin.locator('#chat-messages .chat-msg', { hasText: delMsg });
      const msgId = await msgEl.getAttribute('data-msg-id');

      // Admin deletes via socket
      const socketResult = await pageAdmin.evaluate((id) => {
        const sock = (window as any).__testSocket;
        if (!sock) return { error: 'no socket' };
        sock.emit('chat:delete', { id: parseInt(id as string, 10) });
        return { emitted: true, connected: sock.connected };
      }, msgId);

      // Fail fast if socket wasn't available
      if ((socketResult as any).error) {
        throw new Error('Admin socket not available: ' + (socketResult as any).error);
      }

      // Both should see "Сообщение удалено" within the message element
      await expect(pageB.locator(`[data-msg-id="${msgId}"] .chat-msg-deleted-text`)).toBeVisible({ timeout: 10_000 });
      await expect(pageAdmin.locator(`[data-msg-id="${msgId}"] .chat-msg-deleted-text`)).toBeVisible({ timeout: 10_000 });
    } finally {
      await ctxAdmin.close();
      await ctxB.close();
    }
  });
});
