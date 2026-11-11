-- Per-restaurant admin history (issue #36).
-- The admin restaurant page shows the latest actions for one restaurant, newest first.
-- Additive only: one new index, so that query never scans the whole append-only log (Law 26).
CREATE INDEX IF NOT EXISTS audit_log_restaurant ON audit_log (restaurant_id, created_at, id);
