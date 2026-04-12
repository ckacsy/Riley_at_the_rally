-- PR 7: additional transaction indexes for dashboard queries
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_type_created ON transactions(type, created_at);
