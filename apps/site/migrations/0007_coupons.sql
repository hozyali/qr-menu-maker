-- Discount coupons (issue #40).
-- Additive only: two new tables, two indexes, and three new subscription columns.

CREATE TABLE coupons (
  id TEXT PRIMARY KEY,
  -- Stored uppercase. NOCASE makes "ramzan" and "RAMZAN" the same code.
  code TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(code) BETWEEN 4 AND 20),
  percent_off INTEGER NOT NULL CHECK (percent_off BETWEEN 1 AND 100),
  billing_period TEXT NOT NULL CHECK (billing_period IN ('monthly', 'yearly', 'any')),
  -- 'once' discounts the first paid period only. 'recurring' discounts every renewal too.
  duration TEXT NOT NULL CHECK (duration IN ('once', 'recurring')),
  -- NULL means any paid plan, or any restaurant.
  plan_id TEXT REFERENCES plans (id),
  restaurant_id TEXT REFERENCES restaurants (id),
  -- NULL means no limit. The CHECK below stops the count from ever passing the limit, so a save
  -- that would go over it fails as a whole, together with the subscription change.
  max_redemptions INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  redeemed_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (max_redemptions IS NULL OR redeemed_count <= max_redemptions)
);
-- The admin list, newest first, paged by keyset (Law 26).
CREATE INDEX coupons_created ON coupons (created_at, id);

-- One restaurant can use one coupon once.
CREATE TABLE coupon_redemptions (
  id TEXT PRIMARY KEY,
  coupon_id TEXT NOT NULL REFERENCES coupons (id),
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  created_at INTEGER NOT NULL,
  UNIQUE (coupon_id, restaurant_id)
);

-- A copy of the coupon on the subscription, so a recurring discount keeps applying at renewal
-- even if the coupon is disabled later.
ALTER TABLE subscriptions ADD COLUMN coupon_id TEXT REFERENCES coupons (id);
ALTER TABLE subscriptions ADD COLUMN coupon_percent_off INTEGER CHECK (coupon_percent_off IS NULL OR coupon_percent_off BETWEEN 1 AND 100);
ALTER TABLE subscriptions ADD COLUMN coupon_duration TEXT CHECK (coupon_duration IS NULL OR coupon_duration IN ('once', 'recurring'));
