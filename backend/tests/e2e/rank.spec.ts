import { test, expect } from '@playwright/test';

async function resetDb(request: import('@playwright/test').APIRequestContext): Promise<void> {
  await request.post('/api/dev/reset-db');
}

async function getCsrfToken(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.get('/api/csrf-token');
  const body = await res.json();
  return body.csrfToken as string;
}

async function registerUser(
  request: import('@playwright/test').APIRequestContext,
  username: string,
  email: string,
  password: string,
): Promise<{ id: number; username: string; status: string }> {
  const csrfToken = await getCsrfToken(request);
  const res = await request.post('/api/auth/register', {
    data: { username, email, password, confirm_password: password },
    headers: { 'X-CSRF-Token': csrfToken },
  });
  expect(res.status(), `register failed: ${await res.text()}`).toBe(200);
  const body = await res.json();
  return body.user;
}

async function activateUser(request: import('@playwright/test').APIRequestContext, username: string): Promise<void> {
  const res = await request.post('/api/dev/activate-user', { data: { username } });
  expect(res.status(), `activateUser failed: ${await res.text()}`).toBe(200);
}

async function loginUser(request: import('@playwright/test').APIRequestContext, identifier: string, password: string): Promise<void> {
  const csrfToken = await getCsrfToken(request);
  const res = await request.post('/api/auth/login', {
    data: { identifier, password },
    headers: { 'X-CSRF-Token': csrfToken },
  });
  expect(res.status(), `login failed: ${await res.text()}`).toBe(200);
}

/**
 * Rank API smoke tests.
 * Validates GET /api/profile/rank and GET /api/rankings response shapes.
 */

test.describe('GET /api/profile/rank', () => {
  test('requires authentication — returns 401 when not logged in', async ({ request }) => {
    const res = await request.get('/api/profile/rank');
    expect(res.status()).toBe(401);
  });

  test('returns rank data with expected shape for authenticated user', async ({ request }) => {
    await resetDb(request);
    const user = await registerUser(request, 'rankuser', 'rankuser@example.com', 'Secure#Pass1');
    await activateUser(request, user.username);
    await loginUser(request, user.username, 'Secure#Pass1');

    const res = await request.get('/api/profile/rank');
    expect(res.status()).toBe(200);
    const body = await res.json();

    // Required fields
    expect(typeof body.rank).toBe('number');
    expect(typeof body.stars).toBe('number');
    expect(typeof body.isLegend).toBe('boolean');
    expect(typeof body.duelsWon).toBe('number');
    expect(typeof body.duelsLost).toBe('number');

    // Default values for a brand-new user
    expect(body.rank).toBe(15);
    expect(body.stars).toBe(0);
    expect(body.isLegend).toBe(false);
    expect(body.legendPosition).toBeNull();
    expect(body.duelsWon).toBe(0);
    expect(body.duelsLost).toBe(0);

    // Display object
    expect(body.display).toHaveProperty('label');
    expect(body.display).toHaveProperty('emoji');
    expect(body.display).toHaveProperty('starsDisplay');
    expect(body.display).toHaveProperty('text');

    // Default rank 15 display
    expect(body.display.label).toBe('15');
    expect(body.display.starsDisplay).toBe('☆☆☆');
  });
});

test.describe('GET /api/rankings', () => {
  test('returns ladder and legend arrays', async ({ request }) => {
    const res = await request.get('/api/rankings');
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty('ladder');
    expect(body).toHaveProperty('legend');
    expect(Array.isArray(body.ladder)).toBe(true);
    expect(Array.isArray(body.legend)).toBe(true);
  });

  test('ladder entries have expected shape', async ({ request }) => {
    await resetDb(request);
    const user = await registerUser(request, 'ladderuser', 'ladderuser@example.com', 'Secure#Pass1');
    await activateUser(request, user.username);

    const res = await request.get('/api/rankings');
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.ladder.length).toBeGreaterThan(0);
    const entry = body.ladder[0];

    expect(entry).toHaveProperty('id');
    expect(entry).toHaveProperty('username');
    expect(entry).toHaveProperty('rank');
    expect(entry).toHaveProperty('stars');
    expect(entry).toHaveProperty('duelsWon');
    expect(entry).toHaveProperty('duelsLost');
    expect(entry).toHaveProperty('display');
    expect(entry.display).toHaveProperty('text');
  });

  test('legend list is empty when no legend players exist', async ({ request }) => {
    await resetDb(request);
    const res = await request.get('/api/rankings');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.legend).toEqual([]);
  });
});
