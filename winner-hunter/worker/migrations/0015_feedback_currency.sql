-- The currency of a decision's price: the board learns "Too expensive" per currency (a price in yen is not one in
-- euros). Rows from before: the board takes the currency of the product they are about.
ALTER TABLE feedback ADD COLUMN currency TEXT;
