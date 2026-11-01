-- Lasso stores (lasso.mjs, optional, off by default): Shopify stores whose checkout runs on Lasso, checked on the store
-- itself, with their best sellers. verdict: 'script' (Lasso's script on the store), 'checkout' (only checkout.<store>
-- serves Lasso's checkout) or 'gone' (seen before, not any more). best: JSON [{ title, url, price, compare_at, currency,
-- image }], best first (Shopify's own sales order). first_seen: when this store was first found; last_seen: last
-- verified. The board does not read this table yet (docs/research/lasso-stores.md, "Into the board").
CREATE TABLE IF NOT EXISTS lasso_stores (
  domain TEXT PRIMARY KEY,
  store_id TEXT,
  checkout_host TEXT,
  verdict TEXT NOT NULL,
  script TEXT,
  title TEXT,
  lang TEXT,
  currency TEXT,
  country TEXT,
  products INTEGER,
  kind TEXT,
  best TEXT,
  sources TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT,
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lasso_stores_first_seen ON lasso_stores (first_seen);
