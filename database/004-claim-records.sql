CREATE TABLE claim_draft_editor (
  patient_id TEXT PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
  editor TEXT NOT NULL CHECK (json_valid(editor))
);

CREATE TABLE claim_records (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  patient_id TEXT NOT NULL,
  chart_number TEXT NOT NULL,
  patient_name TEXT NOT NULL,
  month TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  previous_id TEXT REFERENCES claim_records(id),
  body TEXT NOT NULL CHECK (json_valid(body)),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  UNIQUE (patient_id, month, version)
);

CREATE INDEX claim_records_chart ON claim_records(chart_number);
CREATE INDEX claim_records_month_seq ON claim_records(month, seq DESC);

CREATE TRIGGER claim_records_append
BEFORE INSERT ON claim_records
WHEN EXISTS (SELECT 1 FROM claim_records WHERE id = NEW.id OR seq = NEW.seq)
  OR NEW.version <> coalesce((
    SELECT version + 1 FROM claim_records
    WHERE patient_id = NEW.patient_id AND month = NEW.month
    ORDER BY version DESC LIMIT 1
  ), 1)
  OR NEW.previous_id IS NOT (
    SELECT id FROM claim_records
    WHERE patient_id = NEW.patient_id AND month = NEW.month
    ORDER BY version DESC LIMIT 1
  )
BEGIN
  SELECT raise(ABORT, 'claim record must be appended to its version history');
END;

CREATE TRIGGER claim_records_no_update
BEFORE UPDATE ON claim_records
BEGIN
  SELECT raise(ABORT, 'claim records are append-only');
END;

CREATE TRIGGER claim_records_no_delete
BEFORE DELETE ON claim_records
BEGIN
  SELECT raise(ABORT, 'claim records are append-only');
END;

PRAGMA user_version = 4;
