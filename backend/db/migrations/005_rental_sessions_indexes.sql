-- PR 6 + PR 8: rental_sessions indexes
CREATE INDEX IF NOT EXISTS idx_rental_sessions_user_id ON rental_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_rental_sessions_car_id ON rental_sessions(car_id);
CREATE INDEX IF NOT EXISTS idx_rental_sessions_created_at ON rental_sessions(created_at);
-- PR 8: analytics composite index
CREATE INDEX IF NOT EXISTS idx_rental_sessions_car_created ON rental_sessions(car_id, created_at);
