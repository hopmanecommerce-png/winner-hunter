-- What you decided and why: one row per decision (seen = made ad, rejected, keep = ★), reasons (JSON list of
-- keys) and a note; 'general' rows are notes about the board itself (no ad). The product's facts are copied in,
-- so the board keeps learning from a product after it ages out of the rules. The board ranks the inbox with it.
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ad_id TEXT,
  action TEXT,
  reasons TEXT,
  note TEXT,
  keyword TEXT,
  store TEXT,
  advertiser TEXT,
  title TEXT,
  price REAL,
  at TEXT
);
CREATE INDEX IF NOT EXISTS feedback_ad ON feedback (ad_id);
