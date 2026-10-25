-- Store signals (bestsellers.mjs, once a day). Both tables are read by the board; nothing else depends on them.

-- A board product's rank in its own store's best-seller list.
CREATE TABLE IF NOT EXISTS bestseller (
  product_key TEXT PRIMARY KEY, -- store.com/products/handle
  store TEXT,
  product_id TEXT,
  rank INTEGER,                 -- 1 = the store's best seller; NULL = not in its top 50 (or unknown when ok = 0)
  ok INTEGER,                   -- 1: the store's list was read; 0: the store gives no list (headless, API off)
  checked_at TEXT,
  history TEXT                  -- JSON [["2026-10-25", 3], ...]: one rank a day, the last 15 days
);

-- The store's Trustpilot score, read from the real Trustpilot widget the store shows (lib/trust.mjs).
CREATE TABLE IF NOT EXISTS store_trust (
  store TEXT PRIMARY KEY,       -- store.com
  status TEXT,                  -- 'widget': real Trustpilot widget; 'badge': names Trustpilot, no real widget; 'none'
  score REAL,                   -- TrustScore (0-5), widget only
  reviews INTEGER,              -- number of Trustpilot reviews, widget only
  profile TEXT,                 -- the Trustpilot profile it belongs to (identifying name), widget only
  checked_at TEXT
);
