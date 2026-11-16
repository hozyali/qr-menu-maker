-- Restaurant subscriptions (issue #39).
-- Additive only: one new table, two indexes, and one subscription row for every existing restaurant.
-- restaurants.plan and restaurants.plan_expires_at are no longer read after this, but they stay,
-- because removing columns is destructive (Law 25).

-- One row per restaurant, updated in place (Law 26). Changes are recorded in audit_log.
CREATE TABLE subscriptions (
  restaurant_id TEXT PRIMARY KEY REFERENCES restaurants (id),
  plan_id TEXT NOT NULL REFERENCES plans (id),
  -- 'none' means no billing period: a free plan, or a plan the admin gave without one.
  billing_period TEXT NOT NULL CHECK (billing_period IN ('monthly', 'yearly', 'none')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trial')),
  started_at INTEGER NOT NULL,
  -- NULL means no end. After this time the restaurant uses the signup plan.
  ends_at INTEGER,
  -- The price agreed for this period, copied so later price changes do not affect it.
  price_minor INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  updated_at INTEGER NOT NULL
);
-- Counts restaurants per plan for the admin plan list.
CREATE INDEX subscriptions_plan ON subscriptions (plan_id);

-- Finds a restaurant's oldest dishes quickly. Dishes past the plan's limit are hidden (archived).
CREATE INDEX IF NOT EXISTS items_restaurant_created ON items (restaurant_id, created_at, id);

-- Every existing restaurant keeps its current plan. A Pro end date is copied. An ended Pro falls back
-- to the signup plan when read, as before.
INSERT INTO subscriptions (restaurant_id, plan_id, billing_period, status, started_at, ends_at, price_minor, updated_at)
SELECT r.id, p.id, 'none', 'active', r.created_at, CASE WHEN r.plan = 'pro' THEN r.plan_expires_at ELSE NULL END, 0, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM restaurants r JOIN plans p ON p.legacy_key = r.plan;
