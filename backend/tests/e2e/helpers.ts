/**
 * Shared helpers for backend Playwright E2E specs.
 *
 * All helpers accept either a `Page` or a bare `APIRequestContext` as their
 * first argument so they can be used from both `page`-fixture tests and
 * `request`-fixture tests (e.g. rank.spec.ts).
 */
import { type Page, type APIRequestContext, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape returned by /api/auth/register (.user property). */
export type UserShape = { id: number; username: string; status: string };

/**
 * Either a full Playwright `Page` (whose `page.request` is an
 * `APIRequestContext`) or a bare `APIRequestContext` (the `request` fixture).
 */
export type PageOrRequest = Page | APIRequestContext;

// ---------------------------------------------------------------------------
// Internal utility
// ---------------------------------------------------------------------------

/** Extract the underlying APIRequestContext from a Page or bare request. */
function getReq(pageOrRequest: PageOrRequest): APIRequestContext {
  return (pageOrRequest as Page).request ?? (pageOrRequest as APIRequestContext);
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/** Reset the database via the dev endpoint (no-op in production). */
export async function resetDb(pageOrRequest: PageOrRequest): Promise<void> {
  await getReq(pageOrRequest).post('/api/dev/reset-db');
}

/** Fetch a fresh CSRF token for the current session. */
export async function getCsrfToken(pageOrRequest: PageOrRequest): Promise<string> {
  const res = await getReq(pageOrRequest).get('/api/csrf-token');
  const body = await res.json();
  return body.csrfToken as string;
}

/**
 * Register a new user via the API.
 * The resulting session is shared with the browser context.
 */
export async function registerUser(
  pageOrRequest: PageOrRequest,
  username: string,
  email: string,
  password = 'Secure#Pass1',
): Promise<UserShape> {
  const csrfToken = await getCsrfToken(pageOrRequest);
  const res = await getReq(pageOrRequest).post('/api/auth/register', {
    data: { username, email, password, confirm_password: password },
    headers: { 'X-CSRF-Token': csrfToken },
  });
  expect(res.status(), `register failed: ${await res.text()}`).toBe(200);
  const body = await res.json();
  return body.user as UserShape;
}

/**
 * Log in a user.
 * After this call the session cookie is set in the browser context.
 */
export async function loginUser(
  pageOrRequest: PageOrRequest,
  identifier: string,
  password = 'Secure#Pass1',
): Promise<void> {
  const csrfToken = await getCsrfToken(pageOrRequest);
  const res = await getReq(pageOrRequest).post('/api/auth/login', {
    data: { identifier, password },
    headers: { 'X-CSRF-Token': csrfToken },
  });
  expect(res.status(), `login failed: ${await res.text()}`).toBe(200);
}

/**
 * Activate a user (bypasses email-verification flow).
 * Uses the /api/dev/activate-user endpoint.
 */
export async function activateUser(
  pageOrRequest: PageOrRequest,
  username: string,
): Promise<void> {
  const res = await getReq(pageOrRequest).post('/api/dev/activate-user', {
    data: { username },
  });
  expect(res.status(), `activateUser failed: ${await res.text()}`).toBe(200);
}

/** Set a user's role via the dev endpoint. */
export async function setUserRole(
  pageOrRequest: PageOrRequest,
  username: string,
  role: 'user' | 'moderator' | 'admin',
): Promise<void> {
  const res = await getReq(pageOrRequest).post('/api/dev/set-user-role', {
    data: { username, role },
  });
  expect(res.status(), `setUserRole failed: ${await res.text()}`).toBe(200);
}

/**
 * Invalidate all active sessions for a given user (by numeric DB id).
 * Calls POST /api/dev/invalidate-user-sessions.
 */
export async function invalidateUserSessions(
  pageOrRequest: PageOrRequest,
  userId: number,
): Promise<void> {
  const res = await getReq(pageOrRequest).post('/api/dev/invalidate-user-sessions', {
    data: { userId },
  });
  expect(res.status(), `invalidateUserSessions failed: ${await res.text()}`).toBe(200);
}

// ---------------------------------------------------------------------------
// Socket capture helpers (page-only — require a full browser context)
// ---------------------------------------------------------------------------

/**
 * Install a socket.io intercept on the page so that every incoming event
 * is captured in `window.__socketEventStore[eventName]`.
 *
 * **Must be called before `page.goto()`.**
 *
 * The implementation wraps `window.io` via `Object.defineProperty` and hooks
 * both `socket.onAny` (for bulk capture) and the original `socket.on` (so
 * that application-code handlers such as those in `control.js` still fire).
 */
export async function setupSocketCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__socketEventStore = {};

    let _ioValue: any;
    Object.defineProperty(window, 'io', {
      configurable: true,
      get() {
        return _ioValue;
      },
      set(v: any) {
        _ioValue = function (this: any, ...args: any[]) {
          const sock = v.apply(this, args);
          (window as any).__testSocket = sock;

          // Capture every event via onAny (socket.io v4+).
          sock.onAny((event: string, ...cbArgs: any[]) => {
            (window as any).__socketEventStore[event] =
              cbArgs.length === 1 ? cbArgs[0] : cbArgs;
          });

          // Also wrap sock.on so that app-code handlers continue to work
          // AND the event is stored even for listeners registered after this
          // init script runs.
          const origOn = sock.on.bind(sock);
          sock.on = function (event: string, cb: Function) {
            origOn(event, (...cbArgs: any[]) => {
              (window as any).__socketEventStore[event] =
                cbArgs.length === 1 ? cbArgs[0] : cbArgs;
              cb(...cbArgs);
            });
            return sock;
          };

          return sock;
        };
        // Preserve static methods and prototype so the intercepted function
        // behaves identically to the real io() from a caller's perspective.
        Object.assign(_ioValue, v);
        _ioValue.prototype = v.prototype;
      },
    });
  });
}

/**
 * Wait for a named socket event to appear in `window.__socketEventStore`
 * and return its payload.  Polls every 50 ms up to `timeout` ms.
 */
export async function waitForSocketEvent(
  page: Page,
  eventName: string,
  timeout = 10_000,
): Promise<any> {
  return page.evaluate(
    ({ evt, ms }) =>
      new Promise<any>((resolve, reject) => {
        const store = (window as any).__socketEventStore;
        if (store && Object.prototype.hasOwnProperty.call(store, evt)) {
          resolve(store[evt]);
          return;
        }
        const timer = setTimeout(
          () => {
            clearInterval(interval);
            reject(new Error(`Socket event '${evt}' not received within ${ms}ms`));
          },
          ms,
        );
        const interval = setInterval(() => {
          const s = (window as any).__socketEventStore;
          if (s && Object.prototype.hasOwnProperty.call(s, evt)) {
            clearInterval(interval);
            clearTimeout(timer);
            resolve(s[evt]);
          }
        }, 50);
      }),
    { evt: eventName, ms: timeout },
  );
}

/**
 * Remove a previously captured socket event from the store so that a
 * subsequent `waitForSocketEvent` call waits for the next occurrence.
 */
export async function clearSocketEvent(page: Page, eventName: string): Promise<void> {
  await page.evaluate(
    (evt) => {
      delete (window as any).__socketEventStore[evt];
    },
    eventName,
  );
}

/**
 * Wait until the `#status-dot` element has the `connected` CSS class,
 * indicating the socket is fully connected.
 */
export async function waitForSocketConnected(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.getElementById('status-dot')?.classList.contains('connected'),
    { timeout: 10_000 },
  );
}
