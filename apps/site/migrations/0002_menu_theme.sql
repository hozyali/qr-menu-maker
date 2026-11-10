-- Menu theme for the public menu page (issue #24).
-- Additive only: three new columns with defaults, so existing restaurants keep working unchanged.
-- The CHECK constraints keep only safe, known values in the database, because these values are
-- written into the menu's stylesheet.

ALTER TABLE restaurants ADD COLUMN theme_color TEXT NOT NULL DEFAULT '#c8321f'
  CHECK (theme_color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]');

ALTER TABLE restaurants ADD COLUMN theme_mode TEXT NOT NULL DEFAULT 'light'
  CHECK (theme_mode IN ('light', 'dark'));

ALTER TABLE restaurants ADD COLUMN photo_size TEXT NOT NULL DEFAULT 'large'
  CHECK (photo_size IN ('large', 'small'));
