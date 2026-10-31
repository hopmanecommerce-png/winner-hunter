-- Outside the EU (world.mjs). Meta's API has no shop ads for these markets, so the hunt reads the public Ad Library per
-- country. There is no reach figure there: the board shows proof signals instead. Nothing else depends on these tables.

-- One ad as seen in one market. A row stays until it has not been seen for a while.
CREATE TABLE IF NOT EXISTS world_ads (
  ad_id TEXT NOT NULL,
  cc TEXT NOT NULL,              -- the market it was seen in (lib/world.mjs MARKETS)
  page_id TEXT,
  page_name TEXT,
  likes INTEGER,                 -- the Facebook page's likes
  collation_id TEXT,             -- Meta groups copies of one creative under this id
  copies INTEGER,                -- ads using this creative (collation_count)
  start_at INTEGER,              -- when it started running (seconds)
  link TEXT,                     -- where it sends people
  caption TEXT,                  -- the domain shown on the ad
  title TEXT,
  image_url TEXT,
  keyword TEXT,
  store TEXT,                    -- store.com ('' when the ad has no shop link)
  product_key TEXT,              -- store.com/products/handle ('' until the product is known)
  first_seen TEXT,
  last_seen TEXT,
  PRIMARY KEY (ad_id, cc)
);
CREATE INDEX IF NOT EXISTS world_ads_seen ON world_ads (last_seen);
CREATE INDEX IF NOT EXISTS world_ads_page ON world_ads (page_id);

-- One shop: is it on Shopify?
CREATE TABLE IF NOT EXISTS world_stores (
  store TEXT PRIMARY KEY,
  shopify INTEGER,
  host TEXT,
  currency TEXT,
  products INTEGER,
  myshopify TEXT,
  checked_at TEXT
);

-- One product as its store describes it. out = 1: off the board (supplements, food and drink, gymwear, shipping protection, gift cards).
CREATE TABLE IF NOT EXISTS world_items (
  product_key TEXT PRIMARY KEY,
  title TEXT,
  price REAL,
  compare_at_price REAL,
  currency TEXT,
  image_url TEXT,
  product_type TEXT,
  out INTEGER,
  checked_at TEXT
);

-- One advertiser: its active ads per market, and whether it has active ads in the EU at all.
CREATE TABLE IF NOT EXISTS world_pages (
  page_id TEXT PRIMARY KEY,
  counts TEXT,                   -- JSON {"AU": 85, "NZ": 12}
  in_eu INTEGER,                 -- 1 yes, 0 no, NULL not checked (needs META_TOKEN)
  checked_at TEXT,
  eu_checked_at TEXT,
  eu_rpd REAL,                   -- EU reach a day of its best active ad in the EU (Meta's API), NULL when none
  eu_ads TEXT                    -- JSON {"ad id": EU reach a day}: only ads also seen outside the EU
);

-- What the board reads: one row per product. ad_id never changes, so your decisions (hidden, stars) stay with it.
CREATE TABLE IF NOT EXISTS world_products (
  product_key TEXT PRIMARY KEY,
  ad_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, -- 0: no longer seen; kept for ★ and ✓
  product_title TEXT,
  price REAL,
  compare_at_price REAL,
  currency TEXT,
  image_url TEXT,
  store_url TEXT,
  product_url TEXT,
  ad_library_url TEXT,               -- its oldest ad that still runs
  advertiser TEXT,
  page_id TEXT,
  likes INTEGER,
  keyword TEXT,
  markets TEXT,                      -- JSON {"AU": {"ads": 4, "days": 134, "new14": 1}}
  ads INTEGER,                       -- ads running for the product (copies counted)
  creatives INTEGER,                 -- different creatives among them
  days INTEGER,                      -- age of its oldest ad that still runs
  new14 INTEGER,                     -- ads started in the last 14 days
  shop_ads INTEGER,                  -- the shop's active ads in its biggest market here
  in_eu INTEGER,
  eu_rpd REAL,                       -- EU reach a day of this product's best ad, when that ad also runs in the EU
  shop_eu_rpd REAL,                  -- EU reach a day of the shop's best ad in the EU
  store_products INTEGER,
  first_seen TEXT,
  last_seen TEXT,
  run_id TEXT                        -- the run that last wrote it: rows of older runs are no longer seen
);
CREATE INDEX IF NOT EXISTS world_products_ad ON world_products (ad_id);
