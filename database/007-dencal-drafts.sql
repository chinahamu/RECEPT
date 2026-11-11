CREATE TABLE dencal_draft_applications (
  inbox_seq INTEGER PRIMARY KEY REFERENCES dencal_inbox(seq),
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  applied_by TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  draft TEXT NOT NULL CHECK (json_valid(draft))
);

CREATE INDEX dencal_draft_applications_patient ON dencal_draft_applications(patient_id);

CREATE TABLE claim_month_editor (
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  editor TEXT NOT NULL CHECK (json_valid(editor)),
  PRIMARY KEY (patient_id, month)
);

PRAGMA user_version = 7;
