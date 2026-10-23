-- Winner Hunter v2 tables. Safe to run again and again (IF NOT EXISTS everywhere).
-- winners existed before v2; it is created here only on a fresh database.
CREATE TABLE IF NOT EXISTS winners (
  ad_id TEXT PRIMARY KEY,
  score INTEGER,
  verdict TEXT,
  product_title TEXT,
  price REAL,
  compare_at_price REAL,
  currency TEXT,
  advertiser TEXT,
  advertiser_page_id TEXT,
  active_ads INTEGER,
  ad_age_days INTEGER,
  ad_start_date TEXT,
  reach_eu INTEGER,
  scaled_count INTEGER,
  keyword TEXT,
  market TEXT,
  store_url TEXT,
  product_url TEXT,
  ad_library_url TEXT,
  image_url TEXT,
  first_seen TEXT,
  last_seen TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS winners_score ON winners (score);
CREATE INDEX IF NOT EXISTS winners_last_seen ON winners (last_seen);
CREATE INDEX IF NOT EXISTS winners_keyword ON winners (keyword);
CREATE INDEX IF NOT EXISTS winners_first_seen ON winners (first_seen);

-- Small key/value memory: keyword_cursor ({"next": n}), last_run (summary for the board), PIN attempts.
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);

-- What you did on the board: 'seen' (done), 'rejected' (not for me) or 'starred'.
CREATE TABLE IF NOT EXISTS hidden (
  ad_id TEXT PRIMARY KEY,
  status TEXT,
  at TEXT
);

-- One row per nightly run.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  started_at TEXT,
  finished_at TEXT,
  ads_checked INTEGER,
  winners INTEGER,
  meta_usage_peak INTEGER,
  note TEXT
);
