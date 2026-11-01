-- The TikTok tab, second round. blockers NULL means Jev never read the product, '' means it flagged none.
ALTER TABLE tiktok_products ADD COLUMN video_url TEXT;
ALTER TABLE tiktok_products ADD COLUMN sold_mixed INTEGER;
ALTER TABLE tiktok_products ADD COLUMN price_suspect INTEGER;
ALTER TABLE tiktok_products ADD COLUMN ads_mention_n INTEGER;
ALTER TABLE tiktok_products ADD COLUMN ads_mention_of INTEGER;
ALTER TABLE tiktok_products ADD COLUMN ads_domain TEXT;
ALTER TABLE tiktok_products ADD COLUMN meta_label TEXT;
