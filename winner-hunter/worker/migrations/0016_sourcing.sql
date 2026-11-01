-- Sourcing (worker/src/sourcing.mjs): the supplier match pipeline on a launch card. Only CREATE … IF NOT EXISTS: safe to
-- run again and again, and it never changes or drops a row of another table.
-- product_key: the launch card's key, exactly as launches.product_key holds it ('eu|…', 'world|…' or 'tiktok|…').

-- One row per product: what you settled on. THE shared place for the chosen supplier's numbers: other parts of the
-- board (the landed cost and break-even gate) read supplier_cost, supplier_url and weight_g here by product_key.
CREATE TABLE IF NOT EXISTS product_sourcing (
  product_key TEXT PRIMARY KEY NOT NULL,
  supplier_cost REAL,   -- the chosen supplier's price for one unit, in euros: the product only (no shipping, no EU import fees)
  supplier_url TEXT,    -- the chosen supplier's link (https)
  weight_g INTEGER,     -- one unit, packed, in grams: typed in (weighed on the sample), else from a chosen supplier that gives one
  ship_cost REAL,       -- shipping one order to the Netherlands, in euros, as the chosen supplier quotes it; NULL: not known
  moq INTEGER,          -- the chosen supplier's minimum order (units)
  lead_days INTEGER,    -- the chosen supplier's days from order to the customer's door
  supplier_id INTEGER,  -- product_suppliers.id of the chosen supplier; NULL: none chosen
  zh TEXT,              -- Chinese search words for 1688
  eur_cny REAL,         -- yuan for one euro; NULL: the default in sourcing.mjs
  eur_usd REAL,         -- dollars for one euro; NULL: the default in sourcing.mjs
  checks TEXT,          -- JSON {"vet": {"factory": true}, "sample": {"qc": true}}: the vetting and sample-order checklists
  updated_at TEXT
);

-- The supplier candidates of a product, typed in or pasted (a link, or the text the 1688 / AliExpress app shares), or
-- added from CJ Dropshipping. Prices are in the supplier's own currency.
CREATE TABLE IF NOT EXISTS product_suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, -- never reused: a phone that still shows a removed supplier cannot change another
  product_key TEXT NOT NULL,
  platform TEXT,        -- '1688', 'aliexpress', 'alibaba', 'cj' or 'other' (from the link)
  url TEXT,             -- https
  title TEXT,
  unit_price REAL,      -- one unit, in currency
  currency TEXT CHECK (currency IN ('CNY', 'USD', 'EUR')),
  moq INTEGER,
  rating REAL,          -- 0 to 5
  kind TEXT CHECK (kind IN ('factory', 'trader')),
  repeat_rate REAL,     -- repeat buyers, % (1688: 回头率)
  ship_price REAL,      -- shipping one order to the Netherlands, in currency
  weight_g INTEGER,     -- one unit, packed
  lead_days INTEGER,    -- days from order to the customer's door
  origin TEXT CHECK (origin IN ('cn', 'eu')), -- ships from China (EU import fees) or from stock in the EU (none)
  notes TEXT,
  source TEXT,          -- 'manual' or 'cj'
  data TEXT,            -- JSON: what CJ said (stock, freight to NL/DE/FR, its product and variant ids)
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS product_suppliers_key ON product_suppliers (product_key);
