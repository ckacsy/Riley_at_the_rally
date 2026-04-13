// Webhook deduplication: ensure webhook_event_id column and unique index on payment_orders
module.exports = function (db) {
  const paymentCols = new Set(db.pragma('table_info(payment_orders)').map((c) => c.name));
  if (!paymentCols.has('webhook_event_id')) {
    try { db.exec('ALTER TABLE payment_orders ADD COLUMN webhook_event_id TEXT'); } catch (_e) { /* already exists */ }
  }
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_webhook_event ON payment_orders(webhook_event_id)');
  } catch (_e) { /* ignore unexpected errors (e.g. schema conflicts on old DBs) */ }
};
