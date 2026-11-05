-- Today's winners (daily.mjs, worker/src/today.mjs): the daily 5 to 10 picks, the run that made them, the Winner Score's
-- history and the nightly backtest. Only CREATE … IF NOT EXISTS: safe to run on every deploy, nothing existing changes.

-- One row per day (Asia/Bangkok): how the run went and the digest it wrote (Markdown and CSV, the board link as {{BOARD}}).
CREATE TABLE IF NOT EXISTS daily_runs (
  day TEXT PRIMARY KEY,           -- YYYY-MM-DD in Asia/Bangkok
  status TEXT NOT NULL,           -- 'running', 'ok', 'short' (fewer than 5 passed the bar), 'failed'
  started_at TEXT,
  finished_at TEXT,
  picks INTEGER DEFAULT 0,
  pool INTEGER DEFAULT 0,         -- products scored
  summary TEXT,                   -- JSON: stages with their time and outcome, counts, budgets spent, why products were passed over
  digest_md TEXT,
  digest_csv TEXT,
  error TEXT,
  updated_at TEXT
);

-- The picks of a day, one row each, with everything the card shows (score breakdown, evidence, audience card, product sheet).
CREATE TABLE IF NOT EXISTS daily_picks (
  day TEXT NOT NULL,
  product_key TEXT NOT NULL,      -- the board's key: eu|…, world|…, tiktok|…
  rank INTEGER NOT NULL,
  id TEXT,                        -- a file-safe id (the card's link: #today/<id>)
  score INTEGER,
  level INTEGER,                  -- rungs of the evidence ladder (0 to 4)
  title TEXT,
  data TEXT,                      -- JSON: the scored product, its audience card and its product sheet
  decision TEXT,                  -- 'keep', 'reject', 'launch' (from the Today tab), else NULL
  reason TEXT,
  decided_at TEXT,
  PRIMARY KEY (day, product_key)
);
CREATE INDEX IF NOT EXISTS daily_picks_key ON daily_picks (product_key, day);

-- The Winner Score of the day's top products, in parts of about 400 KB (JSON { key: [score, level, proof, demand,
-- competition, margin, fit] }), so a score can be followed over the days without a row per product.
CREATE TABLE IF NOT EXISTS winner_scores (
  day TEXT NOT NULL,
  part INTEGER NOT NULL,
  body TEXT,
  updated_at TEXT,
  PRIMARY KEY (day, part)
);

-- The nightly backtest: how well the score follows Connor's decisions, day by day (the accuracy trend), and the weekly report.
CREATE TABLE IF NOT EXISTS score_backtests (
  day TEXT PRIMARY KEY,
  n INTEGER,                      -- decisions with a product
  pos INTEGER,                    -- of which approved
  auc REAL,                       -- the score with the weights in use
  cv REAL,                        -- cross-validated AUC (niches learned without the scored products)
  weights TEXT,                   -- JSON: the weights in use and the ones the decisions suggest
  report TEXT,                    -- Markdown, on the weekly run
  updated_at TEXT
);

-- Problem and audience data the daily prepare step keeps between days (wh-audience's cache), with an end date.
CREATE TABLE IF NOT EXISTS daily_cache (
  key TEXT PRIMARY KEY,
  body TEXT,
  until TEXT,
  updated_at TEXT
);
