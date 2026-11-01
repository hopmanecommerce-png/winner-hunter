-- Without these, the hunt's title lookup scans all of world_ads for each ad (8,300 reads per update). D1's free tier allows 5M reads a day.
CREATE INDEX IF NOT EXISTS world_ads_store_title ON world_ads (store, title);
CREATE INDEX IF NOT EXISTS world_ads_product ON world_ads (product_key);
