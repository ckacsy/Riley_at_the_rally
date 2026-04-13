'use strict';

const https = require('https');
const crypto = require('crypto');
const { createRateLimiter } = require('../middleware/rateLimiter');

/**
 * Mount payment routes.
 *
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {{ requireAuth: Function, requireActiveUser: Function, csrfMiddleware: Function, getActiveSessions?: () => Map<string, {dbUserId: number, holdAmount: number, carId: string|number, userId: string, startTime: Date}> }} deps
 */
module.exports = function mountPaymentRoutes(app, db, deps) {
  const { requireAuth, requireActiveUser, csrfMiddleware, getActiveSessions } = deps;

  const paymentReadLimiter = createRateLimiter({ max: 60 });

  const paymentCreateLimiter = createRateLimiter({
    max: 10,
    keyGenerator: (req) => req.session && req.session.userId ? String(req.session.userId) : req.ip,
  });

  const webhookLimiter = createRateLimiter({ max: 30, message: 'Too many requests.' });

  const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || '';
  const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || '';
  const YOOKASSA_WEBHOOK_SECRET = process.env.YOOKASSA_WEBHOOK_SECRET || '';
  const YOOKASSA_RETURN_URL =
    process.env.YOOKASSA_RETURN_URL ||
    (process.env.APP_BASE_URL ? process.env.APP_BASE_URL + '/garage' : 'http://localhost:5000/garage');

  // Cache whether the webhook_events table exists (created by migration 016).
  // Tables do not disappear at runtime so we only need to check once.
  const webhookEventsTableExists = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='webhook_events' LIMIT 1"
  ).get();

  // Cache whether the audit columns added by migration 017 exist.
  const webhookAuditColumnsExist = webhookEventsTableExists && (() => {
    const cols = new Set(db.pragma('table_info(webhook_events)').map((c) => c.name));
    return cols.has('status') && cols.has('ip_address') && cols.has('raw_body_hash');
  })();

  if (!YOOKASSA_WEBHOOK_SECRET) {
    console.warn('[Payment] YOOKASSA_WEBHOOK_SECRET is not set — HMAC signature verification disabled. Server-side API verification is still active.');
  }

  const VALID_AMOUNTS = [50, 100, 150, 200, 500];

  /**
   * Verify the HMAC-SHA256 signature of a webhook request.
   * Returns true if the secret is not configured (verification disabled),
   * or if the provided signature header matches the expected HMAC.
   * Returns false if the secret is configured but the signature is missing or invalid.
   *
   * @param {Buffer|string} rawBody - Raw request body bytes
   * @param {string} secret - Webhook secret (YOOKASSA_WEBHOOK_SECRET)
   * @param {string} signatureHeader - Value of the X-YooKassa-Signature header
   * @returns {boolean}
   */
  function verifyWebhookSignature(rawBody, secret, signatureHeader) {
    if (!secret) return true; // not configured — skip
    if (!signatureHeader) return false;
    const sig = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
    if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
    } catch {
      return false;
    }
  }

  /**
   * Write an audit entry to webhook_events.
   * Uses a synthetic auto_<uuid> key when no event_id is available (e.g. rejected/malformed)
   * so that every webhook call gets a row regardless of dedup state.
   *
   * @param {{ eventId?: string|null, paymentId?: string|null, eventType?: string|null, status: string, ipAddress?: string|null, rawBodyHash?: string|null }} opts
   */
  function auditWebhookEvent({ eventId, paymentId, eventType, status, ipAddress, rawBodyHash }) {
    if (!webhookEventsTableExists) return;
    // For audit entries without a real event_id (rejected/malformed/duplicate), generate a
    // synthetic key so the NOT NULL UNIQUE constraint is satisfied without collisions.
    const id = eventId || ('auto_' + crypto.randomUUID());
    try {
      if (webhookAuditColumnsExist) {
        db.prepare(
          `INSERT INTO webhook_events (event_id, payment_id, event_type, status, ip_address, raw_body_hash)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(id, paymentId || null, eventType || null, status, ipAddress || null, rawBodyHash || null);
      } else if (eventId) {
        // Migration 017 not yet applied — fall back to existing schema (no audit columns).
        db.prepare(
          'INSERT OR IGNORE INTO webhook_events (event_id, payment_id, event_type) VALUES (?, ?, ?)'
        ).run(id, paymentId || null, eventType || null);
      }
    } catch (e) {
      // Log but never crash the webhook handler due to audit failures.
      console.warn('[Payment] Failed to write webhook audit entry:', e.message || e);
    }
  }

  /** Call YooKassa REST API v3. */
  function yookassaRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      const authToken = Buffer.from(YOOKASSA_SHOP_ID + ':' + YOOKASSA_SECRET_KEY).toString('base64');
      const payload = body ? JSON.stringify(body) : null;
      const options = {
        hostname: 'api.yookassa.ru',
        path: '/v3' + path,
        method,
        headers: {
          Authorization: 'Basic ' + authToken,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      };
      if (method === 'POST') {
        options.headers['Idempotence-Key'] = crypto.randomUUID();
        if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch (_e) {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Record a transaction and return the new balance. */
  function recordTransaction(userId, type, amount, balanceAfter, description, referenceId) {
    db.prepare(
      `INSERT INTO transactions (user_id, type, amount, balance_after, description, reference_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(userId, type, amount, balanceAfter, description || null, referenceId || null);
  }

  // -------------------------------------------------------------------------
  // GET /api/balance
  // -------------------------------------------------------------------------
  app.get('/api/balance', paymentReadLimiter, requireActiveUser, (req, res) => {
    const row = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.session.userId);
    if (!row) return res.status(404).json({ error: 'Пользователь не найден.' });
    let activeHold = 0;
    if (typeof getActiveSessions === 'function') {
      const sessions = getActiveSessions();
      if (sessions) {
        for (const session of sessions.values()) {
          if (session.dbUserId === req.session.userId) {
            activeHold += session.holdAmount || 0;
          }
        }
      }
    }
    res.json({ balance: row.balance || 0, activeHold });
  });

  // -------------------------------------------------------------------------
  // POST /api/payment/create
  // -------------------------------------------------------------------------
  app.post('/api/payment/create', paymentCreateLimiter, requireAuth, requireActiveUser, csrfMiddleware, async (req, res) => {
    const userId = req.session.userId;
    const amount = Number(req.body && req.body.amount);
    if (!VALID_AMOUNTS.includes(amount)) {
      return res.status(400).json({ error: 'Недопустимая сумма. Доступные суммы: ' + VALID_AMOUNTS.join(', ') + ' ₽.' });
    }

    // Mock mode (no YooKassa credentials configured)
    if (!YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) {
      const mockPaymentId = 'mock_' + crypto.randomUUID();
      const newBalance = db.transaction(() => {
        db.prepare(
          `INSERT INTO payment_orders (user_id, yookassa_payment_id, amount, status)
           VALUES (?, ?, ?, 'succeeded')`
        ).run(userId, mockPaymentId, amount);
        db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, userId);
        const row = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
        const bal = row ? row.balance : amount;
        recordTransaction(userId, 'topup', amount, bal, 'Пополнение баланса', mockPaymentId);
        return bal;
      })();
      console.log('[Payment] MOCK MODE: Credited ' + amount + ' RC to user ' + userId);
      return res.json({ confirmationUrl: null, mock: true, balance: newBalance });
    }

    // Real YooKassa payment
    try {
      const paymentBody = {
        amount: { value: amount.toFixed(2), currency: 'RUB' },
        confirmation: { type: 'redirect', return_url: YOOKASSA_RETURN_URL },
        capture: true,
        description: 'Пополнение баланса Riley RC — ' + amount + ' ₽',
        metadata: { user_id: String(userId) },
      };
      const result = await yookassaRequest('POST', '/payments', paymentBody);
      if (result.status !== 200 && result.status !== 201) {
        console.error('[Payment] YooKassa error:', result.body);
        return res.status(502).json({ error: 'Ошибка платёжной системы. Попробуйте позже.' });
      }
      const payment = result.body;
      db.prepare(
        `INSERT INTO payment_orders (user_id, yookassa_payment_id, amount, status)
         VALUES (?, ?, ?, 'pending')`
      ).run(userId, payment.id, amount);
      return res.json({ confirmationUrl: payment.confirmation.confirmation_url });
    } catch (e) {
      console.error('[Payment] YooKassa request failed:', e);
      return res.status(502).json({ error: 'Ошибка платёжной системы. Попробуйте позже.' });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/payment/webhook  (called by YooKassa — no auth/CSRF)
  // -------------------------------------------------------------------------
  app.post('/api/payment/webhook', webhookLimiter, async (req, res) => {
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
    const rawBodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    const clientIp = req.ip || null;

    // ── Step 0: HMAC signature verification (defense-in-depth) ────────────
    const signatureHeader = req.headers['x-yookassa-signature'] || '';
    if (!verifyWebhookSignature(rawBody, YOOKASSA_WEBHOOK_SECRET, signatureHeader)) {
      console.warn('[Payment] Webhook HMAC verification failed from IP:', clientIp);
      auditWebhookEvent({ eventType: 'sig_invalid', status: 'sig_invalid', ipAddress: clientIp, rawBodyHash });
      return res.sendStatus(403);
    }

    // ── Step 1: Validate body structure ───────────────────────────────────
    const event = req.body;
    if (!event) {
      auditWebhookEvent({ eventType: 'malformed', status: 'malformed', ipAddress: clientIp, rawBodyHash });
      return res.status(400).json({ error: 'Missing request body.' });
    }
    if (event.type !== 'notification') {
      auditWebhookEvent({ eventType: event.type || 'unknown', status: 'malformed', ipAddress: clientIp, rawBodyHash });
      return res.status(400).json({ error: 'Unexpected event type.' });
    }

    const obj = event.object;
    if (!obj || !obj.id) {
      auditWebhookEvent({ eventType: event.event || 'unknown', status: 'malformed', ipAddress: clientIp, rawBodyHash });
      return res.status(400).json({ error: 'Missing event object or object.id.' });
    }

    const knownEvents = new Set(['payment.succeeded', 'payment.canceled', 'payment.waiting_for_capture', 'refund.succeeded']);
    if (!event.event || !knownEvents.has(event.event)) {
      auditWebhookEvent({ eventType: event.event || 'unknown', status: 'malformed', ipAddress: clientIp, rawBodyHash });
      return res.status(400).json({ error: 'Unrecognised event: ' + (event.event || '(none)') });
    }

    const paymentId = obj.id;
    const eventId = event.event_id || null; // YooKassa may send event_id for deduplication

    console.log('[Payment] Webhook received:', event.event, 'paymentId:', paymentId, 'eventId:', eventId);

    if (event.event === 'payment.succeeded') {
      // 1. Find the local pending order
      const order = db.prepare(
        'SELECT * FROM payment_orders WHERE yookassa_payment_id = ?'
      ).get(paymentId);

      // Already processed or unknown payment — acknowledge silently
      if (!order || order.status === 'succeeded') {
        console.log('[Payment] Webhook dedup hit — order not found or already succeeded for paymentId:', paymentId);
        auditWebhookEvent({ eventId, paymentId, eventType: 'payment.succeeded', status: 'duplicate', ipAddress: clientIp, rawBodyHash });
        return res.sendStatus(200);
      }

      // 2. Deduplicate by webhook_event_id (if provided) — check both payment_orders AND webhook_events table
      if (eventId) {
        const duplicateOrder = db.prepare(
          'SELECT id FROM payment_orders WHERE webhook_event_id = ?'
        ).get(eventId);
        if (duplicateOrder) {
          console.log('[Payment] Webhook dedup hit (payment_orders) — duplicate event_id ignored:', eventId);
          auditWebhookEvent({ paymentId, eventType: 'payment.succeeded', status: 'duplicate', ipAddress: clientIp, rawBodyHash });
          return res.sendStatus(200);
        }

        // Also check the dedicated webhook_events table (second guard layer)
        if (webhookEventsTableExists) {
          const duplicateEvent = db.prepare(
            'SELECT id FROM webhook_events WHERE event_id = ?'
          ).get(eventId);
          if (duplicateEvent) {
            console.log('[Payment] Webhook dedup hit (webhook_events) — duplicate event_id ignored:', eventId);
            auditWebhookEvent({ paymentId, eventType: 'payment.succeeded', status: 'duplicate', ipAddress: clientIp, rawBodyHash });
            return res.sendStatus(200);
          }
        }
      }

      // 3. Server-side verification: GET /v3/payments/:id from YooKassa
      //    Only verify if YooKassa credentials are configured (skip in mock mode)
      if (YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY) {
        try {
          const verification = await yookassaRequest('GET', '/payments/' + paymentId, null);

          if (verification.status !== 200) {
            console.warn('[Payment] Webhook verification API error for', paymentId, '— status:', verification.status);
            // Return 200 to prevent YooKassa from retrying, but don't credit
            auditWebhookEvent({ eventId, paymentId, eventType: 'payment.succeeded', status: 'rejected', ipAddress: clientIp, rawBodyHash });
            return res.sendStatus(200);
          }

          const verifiedPayment = verification.body;

          // 3a. Verify status is actually succeeded
          if (verifiedPayment.status !== 'succeeded') {
            console.warn('[Payment] Webhook claimed succeeded but API says:', verifiedPayment.status, 'for', paymentId);
            auditWebhookEvent({ eventId, paymentId, eventType: 'payment.succeeded', status: 'rejected', ipAddress: clientIp, rawBodyHash });
            return res.sendStatus(200);
          }

          // 3b. Verify amount matches local order
          if (!verifiedPayment.amount || !verifiedPayment.amount.value) {
            console.error('[Payment] Amount missing in verified payment for', paymentId);
            auditWebhookEvent({ eventId, paymentId, eventType: 'payment.succeeded', status: 'rejected', ipAddress: clientIp, rawBodyHash });
            return res.sendStatus(200);
          }
          const verifiedAmount = parseFloat(verifiedPayment.amount.value);
          if (verifiedAmount !== order.amount) {
            console.error('[Payment] Amount mismatch for', paymentId, '— expected:', order.amount, 'got:', verifiedAmount);
            auditWebhookEvent({ eventId, paymentId, eventType: 'payment.succeeded', status: 'rejected', ipAddress: clientIp, rawBodyHash });
            return res.sendStatus(200);
          }

          // 3c. Verify currency is RUB
          if (verifiedPayment.amount && verifiedPayment.amount.currency !== 'RUB') {
            console.error('[Payment] Currency mismatch for', paymentId, '— expected: RUB, got:', verifiedPayment.amount.currency);
            auditWebhookEvent({ eventId, paymentId, eventType: 'payment.succeeded', status: 'rejected', ipAddress: clientIp, rawBodyHash });
            return res.sendStatus(200);
          }

          // 3d. Verify metadata.user_id matches local order
          const verifiedUserId = verifiedPayment.metadata && verifiedPayment.metadata.user_id;
          if (!verifiedUserId || String(verifiedUserId) !== String(order.user_id)) {
            console.error('[Payment] user_id mismatch for', paymentId, '— expected:', order.user_id, 'got:', verifiedUserId);
            auditWebhookEvent({ eventId, paymentId, eventType: 'payment.succeeded', status: 'rejected', ipAddress: clientIp, rawBodyHash });
            return res.sendStatus(200);
          }

        } catch (e) {
          console.error('[Payment] Webhook verification request failed for', paymentId, ':', e.message || e);
          // Don't credit on verification failure — YooKassa will retry
          return res.sendStatus(500);
        }
      }

      // 4. All checks passed — credit balance atomically
      db.transaction(() => {
        // Re-check status inside transaction to prevent race conditions
        const freshOrder = db.prepare(
          'SELECT status FROM payment_orders WHERE yookassa_payment_id = ?'
        ).get(paymentId);
        if (freshOrder && freshOrder.status === 'succeeded') {
          console.log('[Payment] Race condition prevented — payment already processed in parallel for:', paymentId);
          return; // already processed
        }

        db.prepare(
          "UPDATE payment_orders SET status = 'succeeded', webhook_event_id = ?, updated_at = CURRENT_TIMESTAMP WHERE yookassa_payment_id = ?"
        ).run(eventId, paymentId);

        // Record in webhook_events table for comprehensive deduplication tracking
        if (webhookEventsTableExists) {
          if (webhookAuditColumnsExist) {
            try {
              db.prepare(
                `INSERT INTO webhook_events (event_id, payment_id, event_type, status, ip_address, raw_body_hash)
                 VALUES (?, ?, ?, 'processed', ?, ?)`
              ).run(eventId || ('auto_' + crypto.randomUUID()), paymentId, 'payment.succeeded', clientIp, rawBodyHash);
            } catch (_dupErr) {
              // Unique constraint — event already recorded, safe to continue
              console.log('[Payment] webhook_events insert skipped (duplicate):', eventId);
            }
          } else if (eventId) {
            try {
              db.prepare(
                'INSERT INTO webhook_events (event_id, payment_id, event_type) VALUES (?, ?, ?)'
              ).run(eventId, paymentId, 'payment.succeeded');
            } catch (_dupErr) {
              console.log('[Payment] webhook_events insert skipped (duplicate):', eventId);
            }
          }
        }

        db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(order.amount, order.user_id);
        const row = db.prepare('SELECT balance FROM users WHERE id = ?').get(order.user_id);
        const bal = row ? row.balance : order.amount;
        recordTransaction(order.user_id, 'topup', order.amount, bal, 'Пополнение баланса', paymentId);
      })();

      console.log('[Payment] Verified and credited', order.amount, 'RC to user', order.user_id, 'for payment', paymentId);

    } else if (event.event === 'payment.canceled') {
      // Only transition pending → canceled; never overwrite a succeeded status.
      const cancelOrder = db.prepare(
        "SELECT status FROM payment_orders WHERE yookassa_payment_id = ?"
      ).get(paymentId);
      if (cancelOrder && cancelOrder.status === 'pending') {
        db.prepare(
          "UPDATE payment_orders SET status = 'canceled', updated_at = CURRENT_TIMESTAMP WHERE yookassa_payment_id = ? AND status = 'pending'"
        ).run(paymentId);
        console.log('[Payment] Payment canceled for paymentId:', paymentId);
      } else {
        console.log('[Payment] payment.canceled ignored — order not pending (status:', cancelOrder ? cancelOrder.status : 'not found', ') for paymentId:', paymentId);
      }
      auditWebhookEvent({ eventId, paymentId, eventType: 'payment.canceled', status: 'processed', ipAddress: clientIp, rawBodyHash });
    } else {
      // Known event type but no special handling — log for audit
      console.log('[Payment] Webhook event type not handled:', event.event, 'paymentId:', paymentId);
      auditWebhookEvent({ eventId, paymentId, eventType: event.event, status: 'processed', ipAddress: clientIp, rawBodyHash });
    }

    res.sendStatus(200);
  });

  // -------------------------------------------------------------------------
  // GET /api/payment/status/:paymentOrderId
  // -------------------------------------------------------------------------
  app.get('/api/payment/status/:paymentOrderId', paymentReadLimiter, requireAuth, (req, res) => {
    const orderId = parseInt(req.params.paymentOrderId, 10);
    if (!Number.isInteger(orderId)) return res.status(400).json({ error: 'Неверный идентификатор.' });
    const order = db.prepare(
      'SELECT * FROM payment_orders WHERE id = ? AND user_id = ?'
    ).get(orderId, req.session.userId);
    if (!order) return res.status(404).json({ error: 'Заказ не найден.' });
    const row = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.session.userId);
    res.json({ status: order.status, balance: row ? row.balance : 0 });
  });

  // -------------------------------------------------------------------------
  // GET /api/transactions
  // -------------------------------------------------------------------------
  app.get('/api/transactions', paymentReadLimiter, requireActiveUser, (req, res) => {
    const transactions = db.prepare(
      "SELECT id, type, amount, balance_after, description, reference_id, created_at FROM transactions WHERE user_id = ? AND type NOT IN ('hold', 'release') ORDER BY created_at DESC LIMIT 50"
    ).all(req.session.userId);
    res.json({ transactions });
  });
};
