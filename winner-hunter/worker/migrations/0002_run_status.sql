-- How a run ended: 'ok', 'warning' or 'failed' (NULL while it runs). The short reason is in note.
-- SQLite has no ADD COLUMN IF NOT EXISTS: migrate.mjs skips this when the column is already there.
ALTER TABLE runs ADD COLUMN status TEXT;
