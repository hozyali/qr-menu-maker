-- Permanent menu codes (issue #32).
-- Menu links become tomatofry.com/r/<code>/<name-city>. Only the code finds the restaurant, so the
-- name and city can change without breaking printed QR codes (Law 28).
-- Additive only: one new column, codes for existing restaurants, and a unique index.

ALTER TABLE restaurants ADD COLUMN menu_code TEXT;

-- Six characters from an alphabet without look-alike characters (no 0, 1, i, l, o).
-- The app makes codes for new restaurants with the same alphabet and length.
-- ((random() % 31) + 31) % 31 gives 0 to 30 without abs(), which can overflow on the smallest number.
-- random() runs again for every character of every row. If two rows ever got the same code,
-- the unique index below would fail and stop this migration, so it can never save a duplicate.
UPDATE restaurants SET menu_code =
  substr('23456789abcdefghjkmnpqrstuvwxyz', ((random() % 31) + 31) % 31 + 1, 1) || substr('23456789abcdefghjkmnpqrstuvwxyz', ((random() % 31) + 31) % 31 + 1, 1) || substr('23456789abcdefghjkmnpqrstuvwxyz', ((random() % 31) + 31) % 31 + 1, 1) || substr('23456789abcdefghjkmnpqrstuvwxyz', ((random() % 31) + 31) % 31 + 1, 1) || substr('23456789abcdefghjkmnpqrstuvwxyz', ((random() % 31) + 31) % 31 + 1, 1) || substr('23456789abcdefghjkmnpqrstuvwxyz', ((random() % 31) + 31) % 31 + 1, 1)
WHERE menu_code IS NULL;

CREATE UNIQUE INDEX restaurants_menu_code ON restaurants (menu_code);
