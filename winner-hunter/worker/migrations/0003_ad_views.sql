-- The board's ad viewer (GET /api/ad/:id): the ad as read from Meta's render_ad page, kept 24 hours.
CREATE TABLE IF NOT EXISTS ad_views (
  ad_id TEXT PRIMARY KEY,
  json TEXT,
  fetched_at TEXT
);
