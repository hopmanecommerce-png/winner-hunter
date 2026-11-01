-- The Launch view (worker/src/launch.mjs): one launch card per approved product, its checklist and your decision.
-- product_key: the product's key on the board when the launch started, never rewritten. 'eu|<store.com/products/handle>'
-- (EU: its product page; an ad without one: 'eu|<page id>|<title>', the key every EU card had before the board grouped
-- by product page, still found as its product's card, see cardProduct in launch.mjs), 'world|<store.com/products/handle>'
-- (outside the EU) or 'tiktok|<id>'.
-- facts: JSON, the product as the board showed it when the launch started, so the card stays when the product leaves
-- the board. steps: JSON {"margin": {"done": true, "note": "", "v": {"price": 39.95}}, ...}, one key per checklist step.
CREATE TABLE IF NOT EXISTS launches (
  product_key TEXT PRIMARY KEY,
  title TEXT,
  facts TEXT,
  steps TEXT,
  pinned INTEGER CHECK (pinned = 1),             -- 1: the launch pin, the product you launch now; NULL: not pinned
  decision TEXT CHECK (decision IN ('go', 'no')), -- your launch decision; NULL: not decided yet
  created_at TEXT,
  updated_at TEXT
);
-- Only one product can be the launch pin: a second pinned = 1 fails. Clear the old pin first (one batch, see launch.mjs).
CREATE UNIQUE INDEX IF NOT EXISTS launches_one_pin ON launches (pinned) WHERE pinned = 1;
