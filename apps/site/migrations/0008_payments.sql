-- Offline payments: bank details, receipt upload, and admin approval (issue #41).
-- Additive only: two new tables, three indexes, and one trigger.

-- Admin settings, one row per key, updated in place. The first key is bank_details, which is shown
-- to owners when they pay. It is never a secret (Law 21).
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE payment_requests (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id),
  plan_id TEXT NOT NULL REFERENCES plans (id),
  billing_period TEXT NOT NULL CHECK (billing_period IN ('monthly', 'yearly')),
  -- A new coupon to count as used when this payment is approved.
  coupon_id TEXT REFERENCES coupons (id),
  -- The coupon terms to copy onto the subscription. A recurring coupon from the current
  -- subscription is carried over here at renewal without counting a new use.
  coupon_percent_off INTEGER CHECK (coupon_percent_off IS NULL OR coupon_percent_off BETWEEN 1 AND 100),
  coupon_duration TEXT CHECK (coupon_duration IS NULL OR coupon_duration IN ('once', 'recurring')),
  -- The price worked out when the owner sent the request, in paisa.
  list_price_minor INTEGER NOT NULL CHECK (list_price_minor >= 0),
  discount_minor INTEGER NOT NULL CHECK (discount_minor >= 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  -- restaurants/<restaurant_id>/receipts/<random>.<ext>. Private: never served by /media.
  receipt_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  owner_note TEXT CHECK (owner_note IS NULL OR length(owner_note) <= 300),
  review_note TEXT CHECK (review_note IS NULL OR length(review_note) <= 300),
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by TEXT
);
-- The admin lists: waiting payments oldest first, the rest newest first, both by keyset (Law 26).
CREATE INDEX payment_requests_status ON payment_requests (status, created_at, id);
-- The owner's latest request.
CREATE INDEX payment_requests_restaurant ON payment_requests (restaurant_id, created_at, id);
-- One waiting request per restaurant, enforced by the database even when two arrive at once.
CREATE UNIQUE INDEX payment_requests_one_pending ON payment_requests (restaurant_id) WHERE status = 'pending';

-- A reviewed payment can never be reviewed again. If two approvals race, the second one fails as a
-- whole, together with its subscription change.
CREATE TRIGGER payment_requests_review_once BEFORE UPDATE OF status ON payment_requests
WHEN OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'payment already reviewed');
END;
