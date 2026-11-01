-- The Google hunt (google.mjs): products Shopify stores advertise on Google, from Google's ad library (the Ads Transparency
-- Center) through the Scrape Creators API. New tables only, nothing else changes: safe to run again and again. The board's
-- Google tab, Jev's check (world-check.mjs) and the store signals (bestsellers.mjs) read google_products.

-- What the board reads: one row per product page. ad_id ('g' + the id of the ad that found it) never changes, so your
-- decisions (hidden, stars, feedback, notes) stay with the product.
CREATE TABLE IF NOT EXISTS google_products (
  product_key TEXT PRIMARY KEY,      -- store.com/products/handle (lib/bestsellers.mjs productKey, the board's key)
  ad_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, -- 0: it failed a rule when it was checked again, kept for ✓ and notes
  verdict TEXT,                      -- 'winner': all four rules pass, exactly or approximately. 'partial': none fails, reach unknown
  rules TEXT,                        -- JSON [{ key, label, state, how, text }]: how = 'exact', 'approx' or 'none' (not checked)
  product_title TEXT,
  price REAL,
  compare_at_price REAL,
  currency TEXT,
  image_url TEXT,
  product_type TEXT,
  store_url TEXT,
  product_url TEXT,
  advertiser TEXT,
  advertiser_id TEXT,                -- AR…: the advertiser's page in the Transparency Center
  creative_id TEXT,                  -- CR…: its best ad there
  region TEXT,                       -- the region its advertiser was found in ('' = by domain)
  ads_estimate INTEGER,              -- Google's estimate of the advertiser's ads shown in the last ads_window days
  ads_window INTEGER,
  first_shown TEXT,                  -- its best ad, as Google says: first and last shown
  last_shown TEXT,
  days INTEGER,                      -- days live when it was checked
  regions TEXT,                      -- JSON ["DE", "NL"]: where its ads were shown
  formats TEXT,                      -- JSON ["image", "text"]
  copies INTEGER,                    -- its ads (creatives) seen
  impr_lower INTEGER,                -- the impressions range Google published for its best ad, NULL when it published none
  impr_upper INTEGER,
  impr_scope TEXT,                   -- 'eu': the EU countries' ranges added up, 'all': Google's total
  store_products INTEGER,
  keyword TEXT,                      -- the keyword that found it ('' when found by a domain)
  via TEXT,                          -- 'keyword', 'typed' (a typed domain or advertiser) or 'board' (a shop on the Meta or TikTok tab)
  first_seen TEXT,
  last_seen TEXT,
  run_id TEXT                        -- the run that wrote it: an older run never overwrites a newer one
);
CREATE INDEX IF NOT EXISTS google_products_ad ON google_products (ad_id);

-- One ad (a creative) and what its details said, so the hunt does not pay for them again within a week.
CREATE TABLE IF NOT EXISTS google_ads (
  creative_id TEXT PRIMARY KEY,
  advertiser_id TEXT,
  advertiser TEXT,
  format TEXT,                       -- text, image or video
  first_shown TEXT,
  last_shown TEXT,
  domain TEXT,                       -- where it sends people
  product_key TEXT,                  -- '' when no product page was found
  headline TEXT,
  image_url TEXT,
  regions TEXT,                      -- JSON
  impr_lower INTEGER,
  impr_upper INTEGER,
  eu_lower INTEGER,
  eu_upper INTEGER,
  details_at TEXT,
  seen_at TEXT
);
CREATE INDEX IF NOT EXISTS google_ads_product ON google_ads (product_key);

-- An advertiser or a domain the hunt looked at: not looked at (or paid for) again for 3 days.
CREATE TABLE IF NOT EXISTS google_targets (
  target TEXT PRIMARY KEY,           -- 'adv:AR…' or 'domain:store.com'
  name TEXT,
  estimate INTEGER,                  -- its ads shown in the last days (Google's estimate)
  result TEXT,                       -- 'products', 'fewer than 75 ads', 'not shopify', 'no ad 7–42 days old', …
  checked_at TEXT
);

-- A store: does it run on Shopify? The same check as the other hunts (lib/world.mjs checkStore).
CREATE TABLE IF NOT EXISTS google_stores (
  store TEXT PRIMARY KEY,
  shopify INTEGER,
  host TEXT,
  currency TEXT,
  products INTEGER,
  myshopify TEXT,
  checked_at TEXT
);
