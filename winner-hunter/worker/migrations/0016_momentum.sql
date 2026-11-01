-- Momentum (momentum.mjs, a job once a day; the board: worker/src/momentum.mjs): where each product is heading.
-- Safe to run again and again: CREATE ... IF NOT EXISTS only, nothing dropped or changed in other tables.

-- The daily snapshots. One row a day (a few parts when it is big) holding every tracked product's numbers that day, as
-- JSON {"world|store.com/products/x": {"a": 12, "s": 89, ...}, "eu|<page id>|<title>": {...}, "tiktok|<id>": {...}}:
-- a day costs one write, and a month of history is about 30 rows read.
--   a  ads running for the product          s  the store's active ads             n  its ads started in the last 14 days
--   m  markets it advertises in              e  EU reach a day of its best ad      b  rank in its store's best-seller list (0: not in the top 50)
--   o  TikTok units sold (lifetime)          c  TikTok creators                    p  price
--   r  other stores selling the same item    x  0: no longer seen                  t  the day TikTok's numbers were read
CREATE TABLE IF NOT EXISTS momentum_daily (
  day TEXT NOT NULL,
  part INTEGER NOT NULL,
  body TEXT,
  updated_at TEXT,
  PRIMARY KEY (day, part)
);

-- The same snapshots as one row per product and day, for questions like "how did this product's ads move?". A view:
-- nothing is stored twice.  SELECT * FROM momentum_history WHERE product_key = 'world|store.com/products/x' ORDER BY day
CREATE VIEW IF NOT EXISTS momentum_history AS
SELECT d.day AS day, j.key AS product_key,
  json_extract(j.value, '$.a') AS ads, json_extract(j.value, '$.s') AS shop_ads, json_extract(j.value, '$.n') AS new_ads_14d,
  json_extract(j.value, '$.m') AS markets, json_extract(j.value, '$.e') AS eu_reach_per_day, json_extract(j.value, '$.b') AS best_seller_rank,
  json_extract(j.value, '$.o') AS tiktok_sold, json_extract(j.value, '$.c') AS tiktok_creators, json_extract(j.value, '$.p') AS price,
  json_extract(j.value, '$.r') AS rivals, json_extract(j.value, '$.x') AS seen
FROM momentum_daily d, json_each(d.body) j;

-- What the board reads and the job's own memory, a few rows: board:NN and tiktok:NN (a summary per product: score parts,
-- sparkline, ads survived, rivals, crowding, Google Trends), run (the last run), images (photo fingerprints, to find the
-- same item in other stores) and trends (Google Trends answers for shortlisted products).
CREATE TABLE IF NOT EXISTS momentum (
  key TEXT PRIMARY KEY,
  body TEXT,
  updated_at TEXT
);
