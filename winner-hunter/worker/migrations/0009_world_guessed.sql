-- 1: its store's search was asked about the ad's title and answered, so it is not asked again.
ALTER TABLE world_ads ADD COLUMN guessed INTEGER DEFAULT 0;
