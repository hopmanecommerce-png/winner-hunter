-- Stars apart from seen / rejected: a starred product stays starred when you mark it seen or reject it.
CREATE TABLE IF NOT EXISTS stars (
  ad_id TEXT PRIMARY KEY,
  at TEXT
);
-- Stars used to live in hidden (status 'starred'): move them over. Runs again and again without harm.
INSERT OR IGNORE INTO stars (ad_id, at) SELECT ad_id, at FROM hidden WHERE status = 'starred';
DELETE FROM hidden WHERE status = 'starred';
