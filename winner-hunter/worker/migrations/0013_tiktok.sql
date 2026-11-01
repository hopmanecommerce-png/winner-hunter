-- The TikTok tab: TikTok Shop products with real US sold counts, loaded by tiktok-import.mjs.
-- decision is yours (approved or rejected). The import never touches it.
CREATE TABLE IF NOT EXISTS tiktok_products (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  shop TEXT,
  url TEXT NOT NULL,
  image_url TEXT,
  price_min REAL,
  price_max REAL,
  rating REAL,
  reviews INTEGER,
  sold_us INTEGER NOT NULL,
  creators INTEGER,
  plays INTEGER,
  category TEXT,
  blockers TEXT,
  meta_status TEXT,
  meta_url TEXT,
  meta_unsure INTEGER,
  meta_us INTEGER,
  meta_au INTEGER,
  meta_nz INTEGER,
  updated_at TEXT,
  decision TEXT,
  decided_at TEXT
);
