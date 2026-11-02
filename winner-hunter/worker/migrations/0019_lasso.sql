-- Lasso stores (lasso.mjs, off unless started): Shopify stores that use Lasso's hosted checkout, found with urlscan.io and
-- checked live every run. The board reads it for its "Lasso checkout" chip (worker/src/lasso.mjs; the research list: 0080);
-- their ads reach the board through world_ads (LASSO_ADS).
CREATE TABLE IF NOT EXISTS lasso_stores (
  store TEXT PRIMARY KEY,        -- store.com (no www)
  host TEXT,                     -- the address that answered
  confidence TEXT,               -- high: script + Lasso's checkout; medium: one of the two; low: script left, checkout gone; '': no Lasso now
  live INTEGER,                  -- 1: the store page opens (not closed, not a password page)
  script TEXT,                   -- lasso-script version on the store page: v4, v2, v1 ('' none)
  lasso_store_id TEXT,           -- the script's data-store-id
  lasso_since TEXT,              -- the day the store joined Lasso (from that id)
  checkout_url TEXT,
  name TEXT,
  country TEXT,                  -- the shop's own country (meta.json)
  currency TEXT,                 -- the shop's own currency
  lang TEXT,
  products INTEGER,              -- published products
  best_sellers TEXT,             -- JSON [{title, handle, type, created, price, compare_at, currency}], best first
  how TEXT,                      -- how it was found
  first_seen TEXT,
  last_seen TEXT,                -- the last check that still found Lasso
  checked_at TEXT
);
CREATE INDEX IF NOT EXISTS lasso_stores_seen ON lasso_stores (last_seen);
