CREATE TABLE master_imports (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  published_on TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count > 0),
  UNIQUE (kind, published_on, sha256)
);

CREATE TABLE master_rows (
  import_id INTEGER NOT NULL REFERENCES master_imports(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  fields TEXT NOT NULL CHECK (json_valid(fields)),
  PRIMARY KEY (import_id, code)
);

PRAGMA user_version = 2;
