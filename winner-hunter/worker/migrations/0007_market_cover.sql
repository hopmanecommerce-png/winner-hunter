-- Untapped markets outside the EU (markets.mjs, after the hunt). Read by the board; nothing else depends on it.

-- Per shop (Facebook page): where its active ads are aimed, as Meta says (target_locations). The board turns this
-- into markets outside the EU (lib/markets.mjs coverOf) when it reads it, so a change there needs no new Meta calls.
CREATE TABLE IF NOT EXISTS market_cover (
  page_id TEXT PRIMARY KEY,     -- the advertiser's page id (winners.advertiser_page_id)
  aims TEXT,                    -- JSON: the shop's distinct targetings [[[name, type, excluded 0/1], ...], ...]
  sampled INTEGER,              -- active ads read (0: none running: unknown)
  partial INTEGER,              -- 1: more active ads than were read, or ads without targeting (unless worldwide)
  checked_at TEXT
);
