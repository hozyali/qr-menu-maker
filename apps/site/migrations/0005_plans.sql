-- Plans stored in the database and edited by the admin (issue #38).
-- Additive only: two new tables, two indexes, one index on restaurants, and the seed plans.
-- restaurants.plan ('free' or 'pro') still picks a restaurant's plan through plans.legacy_key
-- until subscriptions replace it (issue #39).

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 40),
  is_free INTEGER NOT NULL CHECK (is_free IN (0, 1)),
  -- Prices in paisa. NULL means not set yet, so a paid plan is not offered for sale.
  monthly_price_minor INTEGER CHECK (monthly_price_minor IS NULL OR monthly_price_minor > 0),
  yearly_price_minor INTEGER CHECK (yearly_price_minor IS NULL OR yearly_price_minor > 0),
  currency TEXT NOT NULL DEFAULT 'PKR',
  is_signup_default INTEGER NOT NULL DEFAULT 0 CHECK (is_signup_default IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  legacy_key TEXT UNIQUE CHECK (legacy_key IN ('free', 'pro')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- A free plan never has prices.
  CHECK (is_free = 0 OR (monthly_price_minor IS NULL AND yearly_price_minor IS NULL))
);
-- Only one plan can be the signup default.
CREATE UNIQUE INDEX plans_one_signup_default ON plans (is_signup_default) WHERE is_signup_default = 1;
CREATE INDEX plans_order ON plans (sort_order, created_at, id);

-- One row per plan and feature. Switches use enabled. Limits use limit_value, where NULL means unlimited.
CREATE TABLE plan_entitlements (
  plan_id TEXT NOT NULL REFERENCES plans (id),
  feature_key TEXT NOT NULL,
  enabled INTEGER CHECK (enabled IN (0, 1)),
  limit_value INTEGER CHECK (limit_value IS NULL OR limit_value >= 0),
  PRIMARY KEY (plan_id, feature_key)
);

-- The admin plan list counts restaurants per plan without reading the whole table (Law 26).
CREATE INDEX IF NOT EXISTS restaurants_plan ON restaurants (plan);

-- Seed plans. Ids are random (Law 18). Pro has no prices until the admin sets them.
INSERT INTO plans (id, name, is_free, is_signup_default, legacy_key, sort_order, created_at, updated_at)
VALUES (lower(hex(randomblob(16))), 'Free', 1, 1, 'free', 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
INSERT INTO plans (id, name, is_free, is_signup_default, legacy_key, sort_order, created_at, updated_at)
VALUES (lower(hex(randomblob(16))), 'Pro', 0, 0, 'pro', 2, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));

-- One statement per row: D1 limits how many SELECTs one statement may join with UNION.
INSERT INTO plan_entitlements (plan_id, feature_key, enabled, limit_value) SELECT id, 'max_items', NULL, 25 FROM plans WHERE legacy_key = 'free';
INSERT INTO plan_entitlements (plan_id, feature_key, enabled, limit_value) SELECT id, 'custom_theme', 1, NULL FROM plans WHERE legacy_key = 'free';
INSERT INTO plan_entitlements (plan_id, feature_key, enabled, limit_value) SELECT id, 'hide_powered_by', 0, NULL FROM plans WHERE legacy_key = 'free';
INSERT INTO plan_entitlements (plan_id, feature_key, enabled, limit_value) SELECT id, 'dish_photos', 1, NULL FROM plans WHERE legacy_key = 'free';
INSERT INTO plan_entitlements (plan_id, feature_key, enabled, limit_value) SELECT id, 'logo', 1, NULL FROM plans WHERE legacy_key = 'free';
INSERT INTO plan_entitlements (plan_id, feature_key, enabled, limit_value) SELECT id, 'max_items', NULL, NULL FROM plans WHERE legacy_key = 'pro';
INSERT INTO plan_entitlements (plan_id, feature_key, enabled, limit_value) SELECT id, 'custom_theme', 1, NULL FROM plans WHERE legacy_key = 'pro';
INSERT INTO plan_entitlements (plan_id, feature_key, enabled, limit_value) SELECT id, 'hide_powered_by', 1, NULL FROM plans WHERE legacy_key = 'pro';
INSERT INTO plan_entitlements (plan_id, feature_key, enabled, limit_value) SELECT id, 'dish_photos', 1, NULL FROM plans WHERE legacy_key = 'pro';
INSERT INTO plan_entitlements (plan_id, feature_key, enabled, limit_value) SELECT id, 'logo', 1, NULL FROM plans WHERE legacy_key = 'pro';
