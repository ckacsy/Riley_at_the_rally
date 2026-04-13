import { test, expect } from '@playwright/test';
import path from 'path';
import Database from 'better-sqlite3';
import { resetDb, getCsrfToken, registerUser, activateUser, loginUser, setUserRole } from './helpers';

const DB_PATH = path.resolve(__dirname, '..', '..', 'riley.sqlite');

/**
 * PR 11 — Admin cars maintenance mode e2e tests.
 *
 * Covers:
 *  - GET /api/admin/cars: admin can fetch; moderator blocked (403); unauth blocked (401)
 *  - POST /api/admin/cars/:id/maintenance:
 *    - admin can enable maintenance for idle car
 *    - admin can disable maintenance
 *    - moderator cannot toggle (403)
 *    - unauthenticated cannot toggle (401)
 *    - invalid payload returns 400
 *    - unknown car returns 404
 *    - enabling for active-session car rejected (409)
 *  - GET /api/cars reflects maintenance status
 *  - Session start blocked for maintenance car (socket)
 *  - Audit log written on maintenance enable/disable
 *  - GET /api/admin/cars returns correct resolved status
 *  - UI: admin sees cars card on admin landing page
 *  - UI: moderator does not see cars card
 *  - UI: admin can open cars page
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function toggleMaintenance(
  page: import('@playwright/test').Page,
  carId: number,
  enabled: boolean,
  reason?: string,
): Promise<import('@playwright/test').APIResponse> {
  const csrfToken = await getCsrfToken(page);
  const body: Record<string, unknown> = { enabled };
  if (reason !== undefined) body.reason = reason;
  return page.request.post(`/api/admin/cars/${carId}/maintenance`, {
    data: body,
    headers: { 'X-CSRF-Token': csrfToken },
  });
}

function getLatestAuditRow(adminId: number, action: string): {
  id: number;
  admin_id: number;
  action: string;
  target_id: number | null;
  details_json: string | null;
} | undefined {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db.prepare(
      `SELECT id, admin_id, action, target_id, details_json
         FROM admin_audit_log
        WHERE admin_id = ? AND action = ?
        ORDER BY id DESC
        LIMIT 1`,
    ).get(adminId, action) as any;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// API Tests: GET /api/admin/cars
// ---------------------------------------------------------------------------

test.describe('GET /api/admin/cars', () => {
  test('admin can fetch cars with resolved status', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'cadmin1', 'cadmin1@test.com');
    await activateUser(page, 'cadmin1');
    await setUserRole(page, 'cadmin1', 'admin');
    await loginUser(page, 'cadmin1');

    const res = await page.request.get('/api/admin/cars');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('cars');
    expect(Array.isArray(body.cars)).toBe(true);
    expect(body.cars.length).toBeGreaterThan(0);
    const car = body.cars[0];
    expect(car).toHaveProperty('id');
    expect(car).toHaveProperty('name');
    expect(car).toHaveProperty('status');
    expect(['available', 'unavailable', 'maintenance']).toContain(car.status);
    expect(car).toHaveProperty('hasActiveSession');
  });

  test('moderator cannot access GET /api/admin/cars (403)', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'cmod1', 'cmod1@test.com');
    await activateUser(page, 'cmod1');
    await setUserRole(page, 'cmod1', 'moderator');
    await loginUser(page, 'cmod1');

    const res = await page.request.get('/api/admin/cars');
    expect(res.status()).toBe(403);
  });

  test('unauthenticated cannot access GET /api/admin/cars (401)', async ({ page }) => {
    await resetDb(page);
    const res = await page.request.get('/api/admin/cars');
    expect(res.status()).toBe(401);
  });

  test('GET /api/admin/cars returns maintenance status after enabling', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'cadmin2', 'cadmin2@test.com');
    await activateUser(page, 'cadmin2');
    await setUserRole(page, 'cadmin2', 'admin');
    await loginUser(page, 'cadmin2');

    // Enable maintenance on car 1
    const enRes = await toggleMaintenance(page, 1, true, 'Тест обслуживание');
    expect(enRes.status()).toBe(200);

    const res = await page.request.get('/api/admin/cars');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const car1 = body.cars.find((c: { id: number }) => c.id === 1);
    expect(car1).toBeDefined();
    expect(car1.status).toBe('maintenance');
    expect(car1.maintenance).not.toBeNull();
    expect(car1.maintenance.enabled).toBe(true);
    expect(car1.maintenance.reason).toBe('Тест обслуживание');
  });
});

// ---------------------------------------------------------------------------
// API Tests: POST /api/admin/cars/:carId/maintenance
// ---------------------------------------------------------------------------

test.describe('POST /api/admin/cars/:carId/maintenance', () => {
  test('admin can enable maintenance for idle car', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'cmaint1', 'cmaint1@test.com');
    await activateUser(page, 'cmaint1');
    await setUserRole(page, 'cmaint1', 'admin');
    await loginUser(page, 'cmaint1');

    const res = await toggleMaintenance(page, 1, true, 'Замена колеса');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.car.status).toBe('maintenance');
    expect(body.car.maintenance.enabled).toBe(true);
    expect(body.car.maintenance.reason).toBe('Замена колеса');
  });

  test('admin can disable maintenance', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'cmaint2', 'cmaint2@test.com');
    await activateUser(page, 'cmaint2');
    await setUserRole(page, 'cmaint2', 'admin');
    await loginUser(page, 'cmaint2');

    // Enable first
    await toggleMaintenance(page, 2, true, 'Плановое обслуживание');

    // Then disable
    const res = await toggleMaintenance(page, 2, false);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.car.status).toBe('available');
    expect(body.car.maintenance).toBeNull();
  });

  test('moderator cannot toggle maintenance (403)', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'cmod2', 'cmod2@test.com');
    await activateUser(page, 'cmod2');
    await setUserRole(page, 'cmod2', 'moderator');
    await loginUser(page, 'cmod2');

    const res = await toggleMaintenance(page, 1, true, 'Test');
    expect(res.status()).toBe(403);
  });

  test('unauthenticated cannot toggle maintenance (401)', async ({ page }) => {
    await resetDb(page);
    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post('/api/admin/cars/1/maintenance', {
      data: { enabled: true, reason: 'Test' },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(401);
  });

  test('invalid payload returns 400 — missing enabled', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'cmaint3', 'cmaint3@test.com');
    await activateUser(page, 'cmaint3');
    await setUserRole(page, 'cmaint3', 'admin');
    await loginUser(page, 'cmaint3');

    const csrfToken = await getCsrfToken(page);
    const res = await page.request.post('/api/admin/cars/1/maintenance', {
      data: { reason: 'no enabled field' },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    expect(res.status()).toBe(400);
  });

  test('invalid payload returns 400 — missing reason when enabling', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'cmaint4', 'cmaint4@test.com');
    await activateUser(page, 'cmaint4');
    await setUserRole(page, 'cmaint4', 'admin');
    await loginUser(page, 'cmaint4');

    const res = await toggleMaintenance(page, 1, true, '');
    expect(res.status()).toBe(400);
  });

  test('unknown car returns 404', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'cmaint5', 'cmaint5@test.com');
    await activateUser(page, 'cmaint5');
    await setUserRole(page, 'cmaint5', 'admin');
    await loginUser(page, 'cmaint5');

    const res = await toggleMaintenance(page, 9999, true, 'Test');
    expect(res.status()).toBe(404);
  });

  test('enabling maintenance for car with active session returns 409', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'cmaint9', 'cmaint9@test.com');
    await activateUser(page, 'cmaint9');
    await setUserRole(page, 'cmaint9', 'admin');
    await loginUser(page, 'cmaint9');

    // Inject a fake active session for car 1 via the dev helper
    const injectRes = await page.request.post('/api/dev/inject-active-session', {
      data: { carId: 1 },
    });
    expect(injectRes.status(), `inject-active-session failed: ${await injectRes.text()}`).toBe(200);

    // Attempt to enable maintenance while the car has an active session
    const res = await toggleMaintenance(page, 1, true, 'Should be rejected');
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('conflict');
  });

  test('maintenance state persists in DB-backed reads', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'cmaint6', 'cmaint6@test.com');
    await activateUser(page, 'cmaint6');
    await setUserRole(page, 'cmaint6', 'admin');
    await loginUser(page, 'cmaint6');

    await toggleMaintenance(page, 3, true, 'Persistent test');

    // Read back from DB directly
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const row = db.prepare('SELECT * FROM car_maintenance WHERE car_id = 3').get() as any;
      expect(row).toBeDefined();
      expect(row.enabled).toBe(1);
      expect(row.reason).toBe('Persistent test');
    } finally {
      db.close();
    }

    // And via API
    const res = await page.request.get('/api/admin/cars');
    const body = await res.json();
    const car3 = body.cars.find((c: { id: number }) => c.id === 3);
    expect(car3.status).toBe('maintenance');
  });

  test('audit log entry written on maintenance enable', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'cmaint7', 'cmaint7@test.com');
    await activateUser(page, 'cmaint7');
    await setUserRole(page, 'cmaint7', 'admin');
    await loginUser(page, 'cmaint7');

    await toggleMaintenance(page, 1, true, 'Audit test reason');

    const row = getLatestAuditRow(admin.id, 'maintenance_enabled');
    expect(row).toBeDefined();
    expect(row!.target_id).toBe(1);
    const details = JSON.parse(row!.details_json || '{}');
    expect(details.reason).toBe('Audit test reason');
  });

  test('audit log entry written on maintenance disable', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'cmaint8', 'cmaint8@test.com');
    await activateUser(page, 'cmaint8');
    await setUserRole(page, 'cmaint8', 'admin');
    await loginUser(page, 'cmaint8');

    await toggleMaintenance(page, 2, true, 'Enable first');
    await toggleMaintenance(page, 2, false);

    const row = getLatestAuditRow(admin.id, 'maintenance_disabled');
    expect(row).toBeDefined();
    expect(row!.target_id).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// GET /api/cars reflects maintenance
// ---------------------------------------------------------------------------

test.describe('GET /api/cars maintenance status', () => {
  test('maintenance car appears as maintenance in GET /api/cars', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'ccars1', 'ccars1@test.com');
    await activateUser(page, 'ccars1');
    await setUserRole(page, 'ccars1', 'admin');
    await loginUser(page, 'ccars1');

    await toggleMaintenance(page, 1, true, 'Public API test');

    const res = await page.request.get('/api/cars');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const car1 = body.cars.find((c: { id: number }) => c.id === 1);
    expect(car1).toBeDefined();
    expect(car1.status).toBe('maintenance');
  });

  test('non-maintenance car appears as available in GET /api/cars', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'ccars2', 'ccars2@test.com');
    await activateUser(page, 'ccars2');
    await setUserRole(page, 'ccars2', 'admin');
    await loginUser(page, 'ccars2');

    // Enable maintenance on car 1 only
    await toggleMaintenance(page, 1, true, 'Only car 1');

    const res = await page.request.get('/api/cars');
    const body = await res.json();
    const car2 = body.cars.find((c: { id: number }) => c.id === 2);
    expect(car2).toBeDefined();
    expect(car2.status).toBe('available');
  });

  test('car returns to available after maintenance disabled', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'ccars3', 'ccars3@test.com');
    await activateUser(page, 'ccars3');
    await setUserRole(page, 'ccars3', 'admin');
    await loginUser(page, 'ccars3');

    await toggleMaintenance(page, 1, true, 'Temp');
    await toggleMaintenance(page, 1, false);

    const res = await page.request.get('/api/cars');
    const body = await res.json();
    const car1 = body.cars.find((c: { id: number }) => c.id === 1);
    expect(car1.status).toBe('available');
  });
});

// ---------------------------------------------------------------------------
// Session start blocked for maintenance car
// ---------------------------------------------------------------------------

test.describe('session start blocked for maintenance car', () => {
  test('socket start_session rejected with car_maintenance code', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await resetDb(page);

      const user = await registerUser(page, 'cmaintsess1', 'cmaintsess1@test.com');
      await activateUser(page, 'cmaintsess1');

      // Set up admin to enable maintenance
      const adminPage = await ctx.newPage();
      const admin = await registerUser(adminPage, 'cmaintsessa', 'cmaintsessa@test.com');
      await activateUser(adminPage, 'cmaintsessa');
      await setUserRole(adminPage, 'cmaintsessa', 'admin');
      await loginUser(adminPage, 'cmaintsessa');
      await toggleMaintenance(adminPage, 1, true, 'Session block test');
      await adminPage.close();

      // Login as user and try to start session via socket
      const csrfToken = await getCsrfToken(page);
      await page.request.post('/api/auth/login', {
        data: { identifier: 'cmaintsess1', password: 'Secure#Pass1' },
        headers: { 'X-CSRF-Token': csrfToken },
      });

      // Set up socket capture
      await page.addInitScript(() => {
        (window as any).__socketEventStore = {};
        const orig = (window as any).io;
        Object.defineProperty(window, 'io', {
          configurable: true,
          get() { return orig; },
          set(fn) {
            Object.defineProperty(window, 'io', {
              configurable: true,
              writable: true,
              value: function (...args: unknown[]) {
                const sock = fn(...args);
                (window as any).__testSocket = sock;
                const origOn = sock.on.bind(sock);
                sock.on = function (event: string, handler: (...a: unknown[]) => void) {
                  return origOn(event, (...a: unknown[]) => {
                    if (!(window as any).__socketEventStore[event]) {
                      (window as any).__socketEventStore[event] = [];
                    }
                    (window as any).__socketEventStore[event].push(a[0]);
                    handler(...a);
                  });
                };
                return sock;
              },
            });
          },
        });
      });

      await page.addInitScript(
        ({ carId, userId, dbUserId }) => {
          sessionStorage.setItem(
            'activeSession',
            JSON.stringify({
              carId, carName: 'Test Car', startTime: new Date().toISOString(),
              sessionId: 'pending', userId, dbUserId, ratePerMinute: 0.5,
            }),
          );
        },
        { carId: 1, userId: user.username, dbUserId: user.id },
      );

      await page.goto('/control');

      // Emit start_session for the maintenance car directly
      await page.evaluate(({ dbUserId }: { dbUserId: number }) => {
        (window as any).__testSocket.emit('start_session', { carId: 1, userId: 'cmaintsess1', dbUserId });
      }, { dbUserId: user.id });

      // Wait for session_error event
      await page.waitForFunction(() => {
        const store = (window as any).__socketEventStore || {};
        return Array.isArray(store['session_error']) && store['session_error'].length > 0;
      }, { timeout: 5000 });

      const errData = await page.evaluate(() => {
        return (window as any).__socketEventStore['session_error'][0];
      });
      expect(errData.code).toBe('car_maintenance');
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// UI tests
// ---------------------------------------------------------------------------

test.describe('admin landing page — cars card visibility', () => {
  test('admin sees cars card on admin landing page', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'uiadmin1', 'uiadmin1@test.com');
    await activateUser(page, 'uiadmin1');
    await setUserRole(page, 'uiadmin1', 'admin');
    await loginUser(page, 'uiadmin1');

    await page.goto('/admin');
    await page.waitForSelector('#admin-content:not([hidden])');

    const carsCard = page.locator('#card-cars');
    await expect(carsCard).not.toHaveAttribute('hidden');
  });

  test('moderator does not see cars card on admin landing page', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'uimod1', 'uimod1@test.com');
    await activateUser(page, 'uimod1');
    await setUserRole(page, 'uimod1', 'moderator');
    await loginUser(page, 'uimod1');

    await page.goto('/admin');
    await page.waitForSelector('#admin-content:not([hidden])');

    const carsCard = page.locator('#card-cars');
    await expect(carsCard).toHaveAttribute('hidden', '');
  });
});

test.describe('admin-cars page', () => {
  test('admin can open cars page and see car list', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'uiadmin2', 'uiadmin2@test.com');
    await activateUser(page, 'uiadmin2');
    await setUserRole(page, 'uiadmin2', 'admin');
    await loginUser(page, 'uiadmin2');

    await page.goto('/admin-cars');
    await page.waitForSelector('#admin-content:not([hidden])');
    await page.waitForSelector('#cars-grid:not([hidden])');

    const cards = page.locator('.car-card');
    await expect(cards).not.toHaveCount(0);
  });

  test('moderator is redirected away from cars page', async ({ page }) => {
    await resetDb(page);
    await registerUser(page, 'uimod2', 'uimod2@test.com');
    await activateUser(page, 'uimod2');
    await setUserRole(page, 'uimod2', 'moderator');
    await loginUser(page, 'uimod2');

    await page.goto('/admin-cars');
    // requireStrictAdmin redirects moderators to /garage
    await page.waitForURL('**/garage', { timeout: 5000 });
  });

  test('maintenance badge appears in admin cars UI after enabling', async ({ page }) => {
    await resetDb(page);
    const admin = await registerUser(page, 'uiadmin3', 'uiadmin3@test.com');
    await activateUser(page, 'uiadmin3');
    await setUserRole(page, 'uiadmin3', 'admin');
    await loginUser(page, 'uiadmin3');

    // Enable maintenance via API
    await toggleMaintenance(page, 1, true, 'UI Badge Test');

    await page.goto('/admin-cars');
    await page.waitForSelector('#admin-content:not([hidden])');
    await page.waitForSelector('#cars-grid:not([hidden])');

    const maintBadge = page.locator('.badge--maintenance').first();
    await expect(maintBadge).toBeVisible();
    await expect(maintBadge).toContainText('На обслуживании');
  });
});
