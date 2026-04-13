import { test, expect, type APIRequestContext } from '@playwright/test';
import { resetDb, getCsrfToken, registerUser, activateUser, loginUser } from './helpers';

/**
 * Register, activate, and log in a fresh user using the given APIRequestContext.
 * After this call the request context carries a valid session cookie, so
 * subsequent requests will be treated as authenticated by the server.
 */
async function authenticateRequest(
  request: APIRequestContext,
  username: string,
  email: string,
  password = 'Password123!',
): Promise<void> {
  await request.post('/api/dev/reset-db');
  const csrfRes = await request.get('/api/csrf-token');
  const { csrfToken } = await csrfRes.json();
  await request.post('/api/auth/register', {
    data: { username, email, password, confirm_password: password },
    headers: { 'X-CSRF-Token': csrfToken },
  });
  await request.post('/api/dev/activate-user', { data: { username } });
  await request.post('/api/auth/login', {
    data: { identifier: username, password },
    headers: { 'X-CSRF-Token': csrfToken },
  });
}

/**
 * Server route availability and core API endpoint tests.
 *
 * Validates that all three static page routes return HTTP 200,
 * the health endpoint reports ok=true, the leaderboard never 500s,
 * the metrics endpoint blocks unauthenticated callers, and the
 * cars endpoint returns the expected payload shape.
 */

test.describe('Static page routes', () => {
  test('GET / returns 200', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
  });

  test('GET /control returns 200', async ({ page }) => {
    const response = await page.goto('/control');
    expect(response?.status()).toBe(200);
  });

  test('GET /garage returns 200', async ({ page }) => {
    const response = await page.goto('/garage');
    expect(response?.status()).toBe(200);
  });

  test('GET /garage responds with Content-Type text/html', async ({ request }) => {
    const res = await request.get('/garage');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/text\/html/);
  });

  test('GET /garage serves complete HTML document with garage-canvas', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'garagetest', 'garagetest@test.com', 'Password123!');
    await activateUser(page, 'garagetest');
    await loginUser(page, 'garagetest', 'Password123!');
    const res = await page.goto('/garage');
    expect(res?.status()).toBe(200);
    const body = await page.content();
    expect(body).toMatch(/<!DOCTYPE html>/i);
    expect(body).toContain('garage-canvas');
  });

  test('GET /control responds with Content-Type text/html', async ({ request }) => {
    const res = await request.get('/control');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/text\/html/);
  });

  test('GET /control serves complete HTML document with control-panel elements', async ({ request }) => {
    await authenticateRequest(request, 'ctrl1', 'ctrl1@test.com');
    const res = await request.get('/control');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/<!DOCTYPE html>/i);
    expect(body).toContain('car-name');
    expect(body).toContain('session-timer');
    expect(body).toContain('chat-toggle-btn');
    expect(body).toContain('Управление RC-машиной');
  });
});

test.describe('API health & leaderboard', () => {
  test('/api/health returns ok=true', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('/api/leaderboard returns payload without 500', async ({ request }) => {
    const res = await request.get('/api/leaderboard');
    expect(res.status()).not.toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty('leaderboard');
    expect(Array.isArray(body.leaderboard)).toBe(true);
  });

  test('/api/leaderboard?range=week returns leaderboard array', async ({ request }) => {
    const res = await request.get('/api/leaderboard?range=week');
    expect(res.status()).not.toBe(500);
    const body = await res.json();
    expect(Array.isArray(body.leaderboard)).toBe(true);
    expect(body.range).toBe('week');
  });

  test('/api/leaderboard?range=day returns leaderboard array', async ({ request }) => {
    const res = await request.get('/api/leaderboard?range=day');
    expect(res.status()).not.toBe(500);
    const body = await res.json();
    expect(Array.isArray(body.leaderboard)).toBe(true);
    expect(body.range).toBe('day');
  });
});

test.describe('API metrics protection', () => {
  test('/api/metrics blocks unauthenticated user (401 or 403)', async ({ request }) => {
    const res = await request.get('/api/metrics');
    expect([401, 403]).toContain(res.status());
  });
});

test.describe('API cars', () => {
  test('/api/cars returns ratePerMinute and cars array', async ({ request }) => {
    const res = await request.get('/api/cars');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.ratePerMinute).toBe('number');
    expect(Array.isArray(body.cars)).toBe(true);
    expect(body.cars.length).toBeGreaterThan(0);
    // Each car has expected fields
    for (const car of body.cars) {
      expect(car).toHaveProperty('id');
      expect(car).toHaveProperty('name');
      expect(car).toHaveProperty('status');
      expect(['available', 'unavailable']).toContain(car.status);
    }
  });
});

test.describe('API car-status', () => {
  test('/api/car-status returns status and lastUpdated', async ({ request }) => {
    const res = await request.get('/api/car-status');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('status');
    expect(['available', 'busy', 'offline']).toContain(body.status);
    expect(body).toHaveProperty('lastUpdated');
    expect(typeof body.lastUpdated).toBe('string');
    // lastUpdated must be a valid ISO 8601 timestamp
    expect(new Date(body.lastUpdated).getTime()).not.toBeNaN();
  });
});

test.describe('API config/session', () => {
  test('/api/config/session returns sessionMaxDurationMs and inactivityTimeoutMs', async ({ request }) => {
    const res = await request.get('/api/config/session');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.sessionMaxDurationMs).toBe('number');
    expect(body.sessionMaxDurationMs).toBeGreaterThan(0);
    expect(typeof body.inactivityTimeoutMs).toBe('number');
    expect(body.inactivityTimeoutMs).toBeGreaterThan(0);
  });
});

test.describe('Leaderboard page (index.html)', () => {
  test('GET / serves leaderboard page with section heading', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain('leaderboard-section');
    expect(body).toContain('Рекорды');
  });

  test('leaderboard page has no car rental section', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('cars-grid');
    expect(body).not.toContain('activate-btn');
  });

  test('leaderboard page has no active races section', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('races-grid');
    expect(body).not.toContain('create-race-btn');
  });

  test('leaderboard page has link back to /garage', async ({ request }) => {
    const res = await request.get('/');
    const body = await res.text();
    expect(body).toContain('/garage');
  });
});

test.describe('Profile page', () => {
  test('profile page "home" link points to /garage', async ({ page }) => {
    // 1. Reset DB
    await resetDb(page);

    // 2. Register user via API (sets session cookie on page)
    const user = await registerUser(page, 'navtest', 'navtest@example.com', 'Secure#Pass1');

    // 3. Activate (bypass email verification)
    await activateUser(page, user.username);

    // 4. Login via API (cookie jar shared with page — no form interaction needed)
    await loginUser(page, user.username, 'Secure#Pass1');

    // 5. Navigate directly to /profile — user is authenticated, no redirect
    await page.goto('/profile');

    // 6. nav.js injects navigation with href="/garage" — wait for it directly
    //    (don't rely on networkidle — nav.js manipulates DOM, not network)
    const garageLink = page.locator('a[href="/garage"]');
    await expect(garageLink.first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Control page (content smoke)', () => {
  // /control is auth-guarded (PR #159): authenticate before each test.
  // control.js also redirects to /garage when sessionStorage has no activeSession,
  // so inject a minimal fake session to prevent the client-side redirect.
  test.beforeEach(async ({ page }) => {
    await resetDb(page);
    const user = await registerUser(page, 'ctrlsmoke', 'ctrlsmoke@test.com', 'Secure#Pass1');
    await activateUser(page, user.username);
    await loginUser(page, user.username, 'Secure#Pass1');
    await page.addInitScript(({ uid, uname }) => {
      sessionStorage.setItem(
        'activeSession',
        JSON.stringify({
          carId: 1,
          carName: 'Test Car',
          startTime: new Date().toISOString(),
          sessionId: null,
          userId: uname,
          dbUserId: uid,
          ratePerMinute: 0.5,
          selectedRaceId: null,
        }),
      );
    }, { uid: user.id, uname: user.username });
  });

  test('control page has keyboard hint', async ({ page }) => {
    await page.goto('/control');
    const body = await page.content();
    expect(body).toContain('keyboard-hint');
  });

  test('control page has speed slider', async ({ page }) => {
    await page.goto('/control');
    const slider = page.locator('#speed-slider');
    await expect(slider).toBeAttached();
  });

  test('control page has directional control buttons', async ({ page }) => {
    await page.goto('/control');
    await expect(page.locator('#forward')).toBeAttached();
    await expect(page.locator('#backward')).toBeAttached();
    await expect(page.locator('#left')).toBeAttached();
    await expect(page.locator('#right')).toBeAttached();
  });

  test('control page has end-rental button', async ({ page }) => {
    await page.goto('/control');
    await expect(page.locator('#end-rental')).toBeAttached();
  });

  test('control page has chat drawer with input', async ({ page }) => {
    await page.goto('/control');
    await expect(page.locator('#chat-input')).toBeAttached();
    await expect(page.locator('#chat-toggle-btn')).toBeAttached();
  });
});

test.describe('Auth-guarded page routes', () => {
  test('GET /control unauthenticated redirects to /login', async ({ request }) => {
    const res = await request.get('/control', { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers()['location']).toContain('/login');
  });

  test('GET /garage unauthenticated redirects to /login', async ({ request }) => {
    const res = await request.get('/garage', { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers()['location']).toContain('/login');
  });

  test('GET /control authenticated returns 200 with HTML', async ({ request }) => {
    await authenticateRequest(request, 'authctrl', 'authctrl@test.com');
    const res = await request.get('/control');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('Управление RC-машиной');
  });

  test('GET /garage authenticated returns 200 with HTML', async ({ request }) => {
    await authenticateRequest(request, 'authgrg', 'authgrg@test.com');
    const res = await request.get('/garage');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('garage-canvas');
  });
});
