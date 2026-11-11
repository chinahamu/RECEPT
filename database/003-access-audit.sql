CREATE TABLE access_audit (
  seq INTEGER PRIMARY KEY,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  previous_hash TEXT NOT NULL CHECK (length(previous_hash) = 64),
  hash TEXT NOT NULL CHECK (length(hash) = 64)
);

CREATE TRIGGER access_audit_append_only
BEFORE INSERT ON access_audit
WHEN NEW.seq <> coalesce((SELECT max(seq) + 1 FROM access_audit), 1)
  OR NEW.previous_hash <> coalesce((SELECT hash FROM access_audit ORDER BY seq DESC LIMIT 1), printf('%064d', 0))
BEGIN
  SELECT raise(ABORT, 'access_audit must be appended in order');
END;

CREATE TRIGGER access_audit_no_update
BEFORE UPDATE ON access_audit
BEGIN
  SELECT raise(ABORT, 'access_audit is append-only');
END;

CREATE TRIGGER access_audit_no_delete
BEFORE DELETE ON access_audit
BEGIN
  SELECT raise(ABORT, 'access_audit is append-only');
END;

PRAGMA user_version = 3;
