CREATE TABLE dencal_inbox (
    seq INTEGER PRIMARY KEY,
    facility_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    integration_id TEXT NOT NULL,
    patient_source_id TEXT NOT NULL,
    encounter_id TEXT NOT NULL,
    transfer_revision INTEGER NOT NULL CHECK (transfer_revision >= 1),
    body BLOB NOT NULL CHECK (length(body) BETWEEN 1 AND 131072),
    body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
    received_at TEXT NOT NULL,
    UNIQUE (facility_id, sender_id, integration_id),
    UNIQUE (facility_id, sender_id, encounter_id, transfer_revision)
);

CREATE TRIGGER dencal_inbox_no_update BEFORE UPDATE ON dencal_inbox
BEGIN SELECT RAISE(ABORT, 'DENCAL inbox is immutable'); END;
CREATE TRIGGER dencal_inbox_no_delete BEFORE DELETE ON dencal_inbox
BEGIN SELECT RAISE(ABORT, 'DENCAL inbox is append-only'); END;
CREATE TRIGGER dencal_inbox_no_replace BEFORE INSERT ON dencal_inbox
WHEN EXISTS (SELECT 1 FROM dencal_inbox WHERE seq = NEW.seq OR
    (facility_id = NEW.facility_id AND sender_id = NEW.sender_id AND
        (integration_id = NEW.integration_id OR
            (encounter_id = NEW.encounter_id AND transfer_revision = NEW.transfer_revision))))
BEGIN SELECT RAISE(ABORT, 'DENCAL inbox record already exists'); END;

CREATE TABLE dencal_patient_matches (
    facility_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    patient_source_id TEXT NOT NULL,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    matched_by TEXT NOT NULL,
    matched_at TEXT NOT NULL,
    PRIMARY KEY (facility_id, sender_id, patient_source_id)
);
CREATE INDEX dencal_patient_matches_patient ON dencal_patient_matches(patient_id);

PRAGMA user_version = 6;
