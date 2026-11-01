-- What Jev (TypeSafe's decision model) answered about a product outside the EU. Probabilities from 0 to 1. input: 'photo' or 'title'.
CREATE TABLE IF NOT EXISTS world_checks (
  product_key TEXT PRIMARY KEY,
  model TEXT,
  input TEXT,
  people REAL,
  animals REAL,
  gymwear REAL,
  physical REAL,
  category TEXT,
  category_conf REAL,
  tokens INTEGER,
  checked_at TEXT
);
