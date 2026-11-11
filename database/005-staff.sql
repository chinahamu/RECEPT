CREATE TABLE staff_accounts (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('reception', 'nurse', 'physician', 'admin')),
  salt BLOB NOT NULL CHECK (length(salt) = 16),
  password_hash BLOB NOT NULL CHECK (length(password_hash) = 32),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  credential_version INTEGER NOT NULL DEFAULT 1
);

PRAGMA user_version = 5;
