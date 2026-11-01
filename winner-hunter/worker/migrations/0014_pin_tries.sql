-- PIN tries per address (worker/src/app.mjs, POST /login): one statement counts a try before the PIN is compared, so
-- tries sent at the same moment cannot all be checked. An IPv6 address counts by its /64. A row is one 15-minute window;
-- older windows are removed through the index on since (no scan of the table per wrong PIN).
CREATE TABLE IF NOT EXISTS pin_tries (
  ip TEXT PRIMARY KEY,
  n INTEGER NOT NULL,     -- tries in this window, the right PIN included
  since INTEGER NOT NULL  -- when the window began (ms)
);
CREATE INDEX IF NOT EXISTS pin_tries_since ON pin_tries (since);
