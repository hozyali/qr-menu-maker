-- Free trial offers (issue #42).
-- Additive only: two new tables and four indexes.

CREATE TABLE trial_offers (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans (id),
  days INTEGER NOT NULL CHECK (days BETWEEN 1 AND 90),
  -- 'all' or one 'restaurant'. Text, so 'city' or 'area' can be added later (plan issue #1).
  target_type TEXT NOT NULL CHECK (target_type IN ('all', 'restaurant')),
  restaurant_id TEXT REFERENCES restaurants (id),
  starts_at INTEGER NOT NULL,
  -- After this, no new trials can start. NULL means no end.
  ends_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK ((target_type = 'restaurant') = (restaurant_id IS NOT NULL))
);
-- Offers for everyone, newest first (the owner banner, on every dashboard view).
CREATE INDEX trial_offers_target ON trial_offers (target_type, status, created_at, id);
-- Offers for one restaurant, newest first.
CREATE INDEX trial_offers_restaurant ON trial_offers (restaurant_id, status, created_at, id);
-- The admin list, newest first, paged by keyset (Law 26).
CREATE INDEX trial_offers_created ON trial_offers (created_at, id);

-- One trial per plan per restaurant, ever. The primary key makes a second start fail.
CREATE TABLE trial_uses (
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  plan_id TEXT NOT NULL REFERENCES plans (id),
  offer_id TEXT NOT NULL REFERENCES trial_offers (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (restaurant_id, plan_id)
);
-- Counts how many trials each offer started, for the admin list.
CREATE INDEX trial_uses_offer ON trial_uses (offer_id);
