-- Store best sellers (bestsellers.mjs, once a day): a board product's rank in its own store's best-seller list.
CREATE TABLE IF NOT EXISTS bestseller (
  product_key TEXT PRIMARY KEY, -- store.com/products/handle
  store TEXT,
  product_id TEXT,
  rank INTEGER,                 -- 1 = the store's best seller; NULL = not in its top 50 (or unknown when ok = 0)
  ok INTEGER,                   -- 1: the store's list was read; 0: the store gives no list (headless, API off)
  checked_at TEXT,
  history TEXT                  -- JSON [["2026-10-25", 3], ...]: one rank a day, the last 15 days
);
