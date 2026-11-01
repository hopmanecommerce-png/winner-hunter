-- The AI read (ai-check.mjs, lib/ai-check.mjs): what a cheap Claude model makes of one board product, for the board's
-- collapsed "AI read · experimental" (worker/src/ai.mjs) and for ai-eval.mjs. One row per product. Only data: nothing
-- is hidden, ranked or decided by it. Safe to run again and again (IF NOT EXISTS, no ALTER, nothing dropped).
-- product_key: 'eu|<page id>|<title>' (an EU product) or 'world|<store.com/products/handle>' (outside the EU), as in launches.
CREATE TABLE IF NOT EXISTS ai_checks (
  product_key TEXT PRIMARY KEY,
  status TEXT,          -- 'pending' (in a batch), 'ok' (answered), 'error' (asked again next run, 3 tries per input)
  model TEXT,
  version INTEGER,      -- the prompt and schema (worker/src/ai-schema.mjs VERSION): a new one asks every product again
  input_hash TEXT,      -- what the model was shown: a product is asked again when its title, price or photo changes
  batch_id TEXT,        -- the Message Batch it was last sent in
  custom_id TEXT,       -- its request in that batch
  input_flags TEXT,     -- JSON list: what the local check found in the product data ('injection')
  no_image INTEGER,     -- 1: the API could not read the photo, so it is asked again without it
  est REAL,             -- the most its request could cost, USD (the spend caps count this until the answer is in)
  tries INTEGER,
  asked_at TEXT,
  -- The last answer. A new request keeps it until its own answer comes in, so the card never goes blank.
  fit INTEGER,          -- 0-100
  confidence TEXT,      -- 'low', 'medium' or 'high'
  verdict TEXT,         -- JSON: the validated answer (product, niche, angle, customer, wow, saturation, claims, pros, cons)
  flags TEXT,           -- JSON list for that answer: 'injection' (the product data tried to instruct the AI)
  answer_model TEXT,    -- the model that gave that answer
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost REAL,            -- what that answer cost, USD (batch price)
  error TEXT,           -- why the last request failed ('' when it did not)
  checked_at TEXT,      -- when that answer came in
  opened_at TEXT        -- when you first opened the AI read on the board: ai-eval.mjs counts decisions after it as not blind
);
CREATE INDEX IF NOT EXISTS ai_checks_batch ON ai_checks (batch_id);
