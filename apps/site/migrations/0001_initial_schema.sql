-- First database schema. Times are milliseconds since 1970. IDs are random text, never sequential.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('admin', 'owner')),
  created_at INTEGER NOT NULL
);

-- Only hashes of login and password-link tokens are stored (Law 19).
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user_id ON sessions (user_id);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

CREATE TABLE password_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX password_tokens_user_id ON password_tokens (user_id);

-- One row per login key, updated in place rather than one row per attempt (Law 26).
CREATE TABLE login_attempts (
  attempt_key TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL
);

-- One owner has one restaurant. The slug never changes because printed QR codes use it (Law 28).
CREATE TABLE restaurants (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL UNIQUE REFERENCES users (id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo_key TEXT,
  city TEXT,
  address TEXT,
  phone TEXT,
  whatsapp TEXT,
  maps_url TEXT,
  hours TEXT,
  note TEXT,
  country TEXT NOT NULL DEFAULT 'PK',
  currency TEXT NOT NULL DEFAULT 'PKR',
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  plan_expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- The admin list pages through restaurants by newest first using a keyset.
CREATE INDEX restaurants_created ON restaurants (created_at, id);

-- UNIQUE (restaurant_id, id) lets child tables reference both columns, so the database itself
-- rejects a row that points at another restaurant's data (Law 18).
CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (restaurant_id, id)
);
CREATE INDEX categories_restaurant_order ON categories (restaurant_id, sort_order, id);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  photo_key TEXT,
  is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, category_id) REFERENCES categories (restaurant_id, id) ON DELETE CASCADE
);
-- Also serves the plan limit count, which filters by restaurant_id alone.
CREATE INDEX items_restaurant_category_order ON items (restaurant_id, category_id, sort_order, id);

-- amount_minor is the price in the smallest currency unit: Rs 1,200 is 120000.
CREATE TABLE item_prices (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  sort_order INTEGER NOT NULL,
  FOREIGN KEY (restaurant_id, item_id) REFERENCES items (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX item_prices_item_order ON item_prices (restaurant_id, item_id, sort_order);

-- Records admin actions. Rows are only added (Law 26).
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  restaurant_id TEXT,
  details TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_log_created ON audit_log (created_at, id);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
