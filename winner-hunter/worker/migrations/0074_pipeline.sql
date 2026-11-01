-- 🧭 Pipeline (worker/src/pipeline.mjs): every approved product from Approved to Launched, step by step. Only CREATE …
-- IF NOT EXISTS: safe to run again and again, and it never changes or drops a row of another table.
-- product_key: the launch card's key, exactly as launches.product_key holds it ('eu|…', 'world|…' or 'tiktok|…').
-- Not here on purpose: the 1688 links are Sourcing's supplier candidates (product_suppliers, 0016_sourcing.sql) and the
-- chosen one is product_sourcing.supplier_id, so the landed-cost comparison and the launch card read them as they are.
-- The stage names are checked in pipeline.mjs (STAGES), not by a CHECK: a new stage later needs no table rebuild.

-- One row per product in the pipeline: where it is, and what its sourcing request says.
CREATE TABLE IF NOT EXISTS pipeline_items (
  product_key TEXT PRIMARY KEY NOT NULL,
  stage TEXT NOT NULL DEFAULT 'approved', -- approved, request, link, supplier, sample, sample_ok, ads, launched
  stage_at TEXT,       -- when it came into this stage (the "stuck for N days" filter counts from here)
  outcome TEXT,        -- at Launched: 'scale' or 'kill'; NULL: not decided yet
  markets TEXT,        -- JSON ["US", "GB"]: the target markets you picked; NULL: the suggested ones (where it runs ads)
  pack TEXT,           -- JSON: the request pack's own fields (English title, variants, must-haves, quality, quantities)
  notes TEXT,          -- JSON {"link": "…"}: your note per stage
  created_at TEXT,
  updated_at TEXT
);

-- Every move from one stage to another: by you (a button or a drag) or by what you did (a link pasted, a supplier chosen).
CREATE TABLE IF NOT EXISTS pipeline_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_key TEXT NOT NULL,
  from_stage TEXT,     -- NULL: the first move of a product
  to_stage TEXT NOT NULL,
  note TEXT,
  actor TEXT,          -- 'you', or what moved it: 'link' (a link pasted), 'choose' (a supplier chosen), 'copy' (the pack copied), 'outcome'
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pipeline_history_key ON pipeline_history (product_key, id);

-- Board-wide pipeline settings, one JSON value per key: 'markets' (the countries in the list, in order) and 'template'
-- (the agent form the request pack opens on).
CREATE TABLE IF NOT EXISTS pipeline_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT,
  updated_at TEXT
);
