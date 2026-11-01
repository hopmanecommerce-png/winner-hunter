-- The Problem Database (docs/problem-db/README.md): problems people complain about or ask a fix for, collected from
-- public posts and comments (problems-collect.mjs) and grouped into problems (problems-process.mjs). Problems only, no
-- products: matched_products stays an empty list until a later step matches products to problems.
-- Only new tables. Nothing else on the board reads or changes them, and nothing here drops or rewrites a row.
-- Numbered 0040 on purpose: other branches add 0016 and up at the same time (migrate.mjs runs the files in name order;
-- these tables depend on no other migration).

-- One public post or comment. id: '<platform>:<the platform's own id>'. No usernames are kept: author_hash is a hash of
-- the platform and the author, only used to count different people.
CREATE TABLE IF NOT EXISTS problem_mentions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,           -- reddit, tiktok, youtube, threads, ...
  kind TEXT NOT NULL,               -- post or comment
  parent_id TEXT,                   -- a comment: the id of its post or video
  url TEXT NOT NULL,                -- https link to the post or comment
  community TEXT,                   -- subreddit or channel, '' when none
  title TEXT,                       -- a post's title; a comment: the title of its post or video
  body TEXT,                        -- the text, cut to 2000 characters
  area TEXT,                        -- the life area of the query that found it (problem-queries.json)
  query TEXT,                       -- the query that found it
  score INTEGER,                    -- upvotes or likes, as last seen
  replies INTEGER,                  -- comments or replies, as last seen
  created_at TEXT,                  -- when it was posted (ISO), '' when the platform does not say
  author_hash TEXT,                 -- '' when the platform gives no author
  lang TEXT,                        -- en, nl, de or '' (problems-process.mjs)
  country TEXT,                     -- a guess: NL, DE, US... or '' (problems-process.mjs)
  relevant INTEGER,                 -- 1: its own text states a problem or asks for a fix (problems-process.mjs)
  problem_id TEXT,                  -- the problem it is in, NULL when in none (problems-process.mjs)
  comments_at TEXT,                 -- a post or video: when its comments were last fetched
  first_seen TEXT,
  last_seen TEXT,
  run_id TEXT,
  sample INTEGER NOT NULL DEFAULT 0 -- 1: sample data written for tests, not a real post
);
CREATE INDEX IF NOT EXISTS problem_mentions_problem ON problem_mentions (problem_id);
CREATE INDEX IF NOT EXISTS problem_mentions_created ON problem_mentions (created_at);

-- One problem: near-identical complaints grouped together. id never changes once given, so your decision stays with it.
-- JSON columns: langs, countries, platforms {"en": 12}, monthly [["2026-10", 4], ...], wtp_signals {"pay": 1, ...},
-- keywords ["dog hair", ...], quotes [{"id", "text", "url", "platform", "lang", "at", "score"}, ...], flags ["noise"].
CREATE TABLE IF NOT EXISTS problems (
  id TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 1,             -- 0: no longer found by the last processing run; kept for its decision
  title TEXT NOT NULL,
  statement TEXT,                                -- one line: the problem, never a product or a fix
  area TEXT,                                     -- life area key of problem-queries.json
  lang TEXT,
  langs TEXT,
  country TEXT,                                  -- a guess, '' when unknown
  countries TEXT,
  platforms TEXT,
  mentions INTEGER,                              -- different posts and comments, after dedupe
  authors INTEGER,                               -- different people, where the platform says who
  engagement INTEGER,                            -- upvotes, likes and replies added up
  first_seen TEXT,                               -- the oldest post (when it was posted)
  last_seen TEXT,                                -- the newest post
  trend TEXT,                                    -- rising, steady, falling or new
  growth REAL,                                   -- last 90 days against the 90 days before (1 = the same)
  monthly TEXT,
  intensity REAL,                                -- 0-100: emotional words and engagement
  wtp REAL,                                      -- 0-100: "I would pay", "looking for a solution", "tried X and Y"
  wtp_signals TEXT,
  keywords TEXT,
  quotes TEXT,
  flags TEXT,
  matched_products TEXT NOT NULL DEFAULT '[]',   -- for later: products matched to this problem. Empty for now.
  named_by TEXT,                                 -- 'rules', or 'claude:<model>' when the optional Claude step named it
  llm_key TEXT,                                  -- what Claude was shown, so an unchanged problem is not asked again
  hash TEXT,                                     -- the row as written: an unchanged problem is not written again
  created_at TEXT,
  updated_at TEXT,
  sample INTEGER NOT NULL DEFAULT 0              -- 1: made from sample data, not real posts
);
CREATE INDEX IF NOT EXISTS problems_active ON problems (active);

-- Your decision on a problem (the board's Problems tab). Its own table, so processing never touches it.
CREATE TABLE IF NOT EXISTS problem_decisions (
  problem_id TEXT PRIMARY KEY,
  decision TEXT NOT NULL CHECK (decision IN ('saved', 'starred', 'ignored')),
  at TEXT
);
