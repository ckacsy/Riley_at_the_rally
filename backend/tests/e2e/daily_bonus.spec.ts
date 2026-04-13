import { test, expect } from '@playwright/test';
import { resetDb, getCsrfToken, registerUser, activateUser, loginUser } from './helpers';

test.describe('Daily Bonus API', () => {
  test('GET /api/daily-bonus/status returns 401 for guest', async ({ request }) => {
    const res = await request.get('/api/daily-bonus/status');
    expect(res.status()).toBe(401);
  });

  test('POST /api/daily-bonus/claim returns 401 for guest', async ({ request }) => {
    const csrfToken = (await (await request.get('/api/csrf-token')).json()).csrfToken;
    const res = await request.post('/api/daily-bonus/claim', {
      headers: { 'x-csrf-token': csrfToken },
    });
    expect(res.status()).toBe(401);
  });

  test('GET /api/daily-bonus/status returns correct shape for new user (no checkins)', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'bonustest1', 'bonustest1@example.com', 'Secure#Pass1');
    await activateUser(page, user.username);
    await loginUser(page, user.username, 'Secure#Pass1');

    const res = await page.request.get('/api/daily-bonus/status');
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty('claimedToday', false);
    expect(body).toHaveProperty('cycleDay', 1);
    expect(body).toHaveProperty('streakCount', 1);
    expect(body).toHaveProperty('todayReward', 2);
    expect(body).toHaveProperty('nextReward', 3);
    expect(body).toHaveProperty('serverDate');
    expect(body).toHaveProperty('lastCheckinDate', null);
  });

  test('POST /api/daily-bonus/claim succeeds for active user — balance increases', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'bonustest2', 'bonustest2@example.com', 'Secure#Pass1');
    await activateUser(page, user.username);
    await loginUser(page, user.username, 'Secure#Pass1');

    // Get initial balance
    const balRes = await page.request.get('/api/balance');
    const { balance: balanceBefore } = await balRes.json();

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post('/api/daily-bonus/claim', {
      headers: { 'x-csrf-token': csrfToken },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty('claimed', true);
    expect(body).toHaveProperty('cycleDay', 1);
    expect(body).toHaveProperty('streakCount', 1);
    expect(body.reward).toBeGreaterThan(0);
    expect(body.balance).toBeCloseTo(balanceBefore + body.reward, 2);
  });

  test('POST /api/daily-bonus/claim creates a transaction of type daily_bonus', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'bonustest3', 'bonustest3@example.com', 'Secure#Pass1');
    await activateUser(page, user.username);
    await loginUser(page, user.username, 'Secure#Pass1');

    const csrfToken = await getCsrfToken(page);
    await page.request.post('/api/daily-bonus/claim', {
      headers: { 'x-csrf-token': csrfToken },
    });

    const txRes = await page.request.get('/api/transactions');
    const { transactions } = await txRes.json();
    const bonusTx = transactions.find((t: { type: string }) => t.type === 'daily_bonus');
    expect(bonusTx).toBeDefined();
    expect(bonusTx.amount).toBeGreaterThan(0);
  });

  test('duplicate same-day claim returns 409 with already_claimed code', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'bonustest4', 'bonustest4@example.com', 'Secure#Pass1');
    await activateUser(page, user.username);
    await loginUser(page, user.username, 'Secure#Pass1');

    const csrfToken = await getCsrfToken(page);
    const first = await page.request.post('/api/daily-bonus/claim', {
      headers: { 'x-csrf-token': csrfToken },
    });
    expect(first.status()).toBe(200);

    const second = await page.request.post('/api/daily-bonus/claim', {
      headers: { 'x-csrf-token': csrfToken },
    });
    expect(second.status()).toBe(409);
    const body = await second.json();
    expect(body).toHaveProperty('code', 'already_claimed');
  });

  test('GET /api/daily-bonus/status shows claimedToday=true after claim', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'bonustest5', 'bonustest5@example.com', 'Secure#Pass1');
    await activateUser(page, user.username);
    await loginUser(page, user.username, 'Secure#Pass1');

    const csrfToken = await getCsrfToken(page);
    await page.request.post('/api/daily-bonus/claim', {
      headers: { 'x-csrf-token': csrfToken },
    });

    const statusRes = await page.request.get('/api/daily-bonus/status');
    const body = await statusRes.json();
    expect(body).toHaveProperty('claimedToday', true);
    expect(body).toHaveProperty('cycleDay', 1);
    expect(body).toHaveProperty('streakCount', 1);
  });

  test('after day-7 claim, nextReward wraps to day-1 reward (2 RC)', async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'bonustest6', 'bonustest6@example.com', 'Secure#Pass1');
    await activateUser(page, user.username);
    await loginUser(page, user.username, 'Secure#Pass1');

    // Inject a streak_count=7 checkin yesterday via dev endpoint
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = (() => {
      const d = new Date(today + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    })();

    // Use dev endpoint to insert a fake checkin for yesterday at streak_count=7
    const injectRes = await page.request.post('/api/dev/inject-checkin', {
      data: { userId: user.id, checkinDate: yesterday, streakCount: 7, cycleDay: 7, rewardAmount: 15 },
    });
    expect(injectRes.status(), `inject-checkin failed: ${await injectRes.text()}`).toBe(200);

    const statusRes = await page.request.get('/api/daily-bonus/status');
    const statusBody = await statusRes.json();
    // Should have streak continuing to 8, cycle_day = 1 (wraps)
    expect(statusBody.cycleDay).toBe(1);
    expect(statusBody.streakCount).toBe(8);
    expect(statusBody.todayReward).toBe(2);

    const csrfToken = await getCsrfToken(page);
    const claimRes = await page.request.post('/api/daily-bonus/claim', {
      headers: { 'x-csrf-token': csrfToken },
    });
    expect(claimRes.status()).toBe(200);
    const claimBody = await claimRes.json();
    // nextReward after day-1 claim should be day-2 reward (3 RC)
    expect(claimBody.nextReward).toBe(3);
    expect(claimBody.cycleDay).toBe(1);
  });
});
