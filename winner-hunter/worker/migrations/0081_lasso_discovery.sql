-- The weekly Lasso discovery (lasso.mjs, workflow "Lasso stores"; docs/research/lasso-discovery.md). Additive only, and safe
-- to run on every workflow run (an ADD COLUMN that is already there is skipped by migrate.mjs).
-- lasso_stores: how the discovery first found a store, and when. Both stay NULL for every store saved before (the research
-- list of 0080, earlier runs of lasso.mjs): those are not new. The board's "Lasso checkout" chip shows how many live Lasso
-- stores have a found_at in the last 7 days (worker/src/lasso.mjs). The job also writes the aliases column of 0080 now: a
-- store found under a second domain (a redirect, the same Lasso store id) gets that domain as an alias, not a row of its own.
ALTER TABLE lasso_stores ADD COLUMN source TEXT;    -- dns | urlscan | board | ads | extra | sister: the method that found it first
ALTER TABLE lasso_stores ADD COLUMN found_at TEXT;  -- when the discovery first saved it (ISO time)
CREATE INDEX IF NOT EXISTS lasso_stores_found ON lasso_stores (found_at);

-- Every domain a source named and the discovery checked, so the next runs leave it for 30 days (7 when it did not answer):
-- most of what Whop's pixel, the board and ads name is no Lasso store. The Lasso stores themselves are in lasso_stores and
-- are checked again every run.
CREATE TABLE IF NOT EXISTS lasso_candidates (
  domain TEXT PRIMARY KEY,   -- the registrable domain (store.com), as the board matches stores
  source TEXT,               -- the source that named it first
  first_seen TEXT,           -- the run that checked it first
  checked_at TEXT,           -- the last check
  result TEXT,               -- lasso | closed (Lasso, the shop is not open) | left (Lasso's script, its checkout gone) | no | down (no answer)
  store TEXT                 -- the lasso_stores row it belongs to, when it is one
);
CREATE INDEX IF NOT EXISTS lasso_candidates_checked ON lasso_candidates (checked_at);
