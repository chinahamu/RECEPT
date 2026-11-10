PRAGMA application_id = 0x52435054;
PRAGMA user_version = 1;

CREATE TABLE workspace (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  seeded INTEGER NOT NULL DEFAULT 0 CHECK (seeded IN (0, 1)),
  offline INTEGER NOT NULL DEFAULT 0 CHECK (offline IN (0, 1))
);
INSERT INTO workspace (id) VALUES (1);

CREATE TABLE patients (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  chart_number TEXT NOT NULL UNIQUE,
  profile TEXT NOT NULL CHECK (json_valid(profile))
);

CREATE TABLE diagnoses (
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  detail TEXT NOT NULL CHECK (json_valid(detail)),
  PRIMARY KEY (patient_id, position),
  UNIQUE (patient_id, id)
);

CREATE TABLE billing_items (
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  detail TEXT NOT NULL CHECK (json_valid(detail)),
  PRIMARY KEY (patient_id, position),
  UNIQUE (patient_id, id)
);

CREATE TABLE activity (
  seq INTEGER PRIMARY KEY,
  entry TEXT NOT NULL CHECK (json_valid(entry))
);
