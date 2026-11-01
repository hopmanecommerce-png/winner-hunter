-- Unit economics and the decision log (worker/src/econ.mjs). Only CREATE … IF NOT EXISTS: safe to run on every deploy,
-- and nothing already there is changed or dropped.
-- product_key: the product's key on the board: 'eu|<store.com/products/handle>' (an EU product: its product page; an ad
-- without one: 'eu|<page id>|<title>', its advertiser + title), 'world|<store.com/products/handle>' (outside the EU) or
-- 'tiktok|<id>'.

-- What you typed for a product: its supplier price, parcel weight and your selling price. Empty: the board's guess.
CREATE TABLE IF NOT EXISTS econ_inputs (
  product_key TEXT PRIMARY KEY,
  cost REAL,          -- the supplier price per order in euros when it was saved (cost_text is what counts: its currency and range)
  cost_text TEXT,     -- the supplier price as typed or pasted: '¥23.50', '$3.20', '12.50-15.00 元'
  weight_g INTEGER,   -- the parcel's weight in grams
  price REAL,         -- your selling price in euros, VAT included; empty: the price their store asks
  updated_at TEXT
);

-- The settings the numbers use (cleanSettings in econ.mjs): VAT, payment fees, refunds, agent fee, shipping tiers, the
-- EU customs on parcels from China, exchange rates, the verdict's thresholds. One row, key 'settings', value JSON.
CREATE TABLE IF NOT EXISTS econ_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);

-- Every approve and reject, with the facts the board showed at that moment (facts: JSON, the product and its unit
-- economics, verdict and reasons). Never rewritten but for undone_at: a decision taken back or replaced keeps its row.
CREATE TABLE IF NOT EXISTS decision_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_key TEXT NOT NULL,
  ad_id TEXT,                                              -- the ad decided on (TikTok: the product's id): what Undo reverts
  source TEXT,                                             -- 'eu', 'world' or 'tiktok'
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  title TEXT,
  level TEXT CHECK (level IN ('green', 'amber', 'red')),   -- the verdict then
  profit REAL,                                             -- the margin per order before ads then, in euros
  be_roas REAL,                                            -- the break-even ROAS then (NULL: an order lost money)
  facts TEXT,
  at TEXT NOT NULL,
  undone_at TEXT,                                          -- when it was taken back or replaced; NULL: it stands
  undo_via TEXT                                            -- 'log' (Undo in the decision log), 'board' (Undo, Remove from ✓, Unhide), 'replaced'
);
-- A product's decisions, the newest last: the one that stands, and whether a decision is its newest.
CREATE INDEX IF NOT EXISTS decision_log_product ON decision_log (product_key, id);
