'use strict';

const https = require('https');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

/**
 * Mount payment routes.
 *
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {{ requireAuth: Function, requireActiveUser: Function, csrfMiddleware: Function, getActiveSessions?: () => Map<string, {dbUserId: number, holdAmount: number, carId: string|number, userId: string, startTime: Date}> }} deps
 */
module.exports = function mountPaymentRoutes(app, db, deps) {
  const { requireAuth, requireActiveUser, csrfMiddleware, getActiveSessions } = deps;

  const paymentReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много запросов. Попробуйте позже.' },
    keyGenerator: (req) => req.ip,
    skip: () => process.env.NODE_ENV === 'test',
  });

  const paymentCreateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много запросов. Попробуйте позже.' },
    keyGenerator: (req) => req.session && req.session.userId ? String(req.session.userId) : req.ip,
    skip: () => process.env.NODE_ENV === 'test',
  });

  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests.' },
    keyGenerator: (req) => req.ip,
    skip: () => process.env.NODE_ENV === 'test',
  });

  const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || '';
  const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || '';
  const YOOKASSA_RETURN_URL =
    process.env.YOOKASSA_RETURN_URL ||
    (process.env.APP_BASE_URL ? process.env.APP_BASE_URL + '/garage' : 'http://localhost:5000/garage');

  const VALID_AMOUNTS = [50, 100, 150, 200, 500];

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
          } catch (e) {
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
  app.get('/api/balance', paymentReadLimiter, requireAuth, (req, res) => {
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
  app.post('/api/payment/webhook', webhookLimiter, (req, res) => {
    const event = req.body;
    if (!event || event.type !== 'notification') return res.sendStatus(200);

    const obj = event.object;
    if (!obj || !obj.id) return res.sendStatus(200);

    const paymentId = obj.id;

    if (event.event === 'payment.succeeded') {
      const order = db.prepare(
        'SELECT * FROM payment_orders WHERE yookassa_payment_id = ?'
      ).get(paymentId);
      if (!order || order.status === 'succeeded') return res.sendStatus(200);

      db.transaction(() => {
        db.prepare(
          "UPDATE payment_orders SET status = 'succeeded', updated_at = CURRENT_TIMESTAMP WHERE yookassa_payment_id = ?"
        ).run(paymentId);
        db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(order.amount, order.user_id);
        const row = db.prepare('SELECT balance FROM users WHERE id = ?').get(order.user_id);
        const bal = row ? row.balance : order.amount;
        recordTransaction(order.user_id, 'topup', order.amount, bal, 'Пополнение баланса', paymentId);
      })();
    } else if (event.event === 'payment.canceled') {
      db.prepare(
        "UPDATE payment_orders SET status = 'canceled', updated_at = CURRENT_TIMESTAMP WHERE yookassa_payment_id = ?"
      ).run(paymentId);
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
  app.get('/api/transactions', paymentReadLimiter, requireAuth, (req, res) => {
    const transactions = db.prepare(
      'SELECT id, type, amount, balance_after, description, reference_id, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
    ).all(req.session.userId);
    res.json({ transactions });
  });
};
