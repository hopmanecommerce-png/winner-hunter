-- Jev's fuller answers: category tree, scores, and everything else as JSON in answers. version: which question set answered.
ALTER TABLE world_checks ADD COLUMN version INTEGER DEFAULT 1;
ALTER TABLE world_checks ADD COLUMN main TEXT;
ALTER TABLE world_checks ADD COLUMN sub TEXT;
ALTER TABLE world_checks ADD COLUMN main_conf REAL;
ALTER TABLE world_checks ADD COLUMN sub_conf REAL;
ALTER TABLE world_checks ADD COLUMN product_score REAL;
ALTER TABLE world_checks ADD COLUMN ad_score REAL;
ALTER TABLE world_checks ADD COLUMN answers TEXT;
ALTER TABLE world_checks ADD COLUMN used TEXT;
ALTER TABLE world_checks ADD COLUMN ad_text INTEGER DEFAULT 0;
-- The ad's own words, for Jev. Empty for ads last seen before this column existed.
ALTER TABLE world_ads ADD COLUMN body TEXT DEFAULT '';
