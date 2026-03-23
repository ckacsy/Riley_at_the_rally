import { test, expect } from '@playwright/test';

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
