import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CLINIC_FACILITY_INFO, DEMO_DATE, DEMO_MONTH } from '../src/data/demoWorkspace';
import type { MasterImport } from '../src/data/officialMasters';
import type {
  ClaimActor, ClaimConfirmation, ClaimEditor, ClaimRecord, ClaimRecordPage, ClaimRecordSummary, ClaimSnapshot,
} from '../src/types/claimRecord';
import type { PatientRecord } from '../src/types/receipt';
import { calculateLineItemPoints, calculateReceiptPointsAndCopay, runMhlwReceiptCheck } from '../src/utils/receiptEngine';
import { WorkspaceError } from './errors';

type RecordBody = Pick<ClaimRecord, 'confirmedAt' | 'correctionReason' | 'enteredBy' | 'confirmedBy' | 'snapshot'>;
type RecordRow = {
  seq: number; id: string; patient_id: string; chart_number: string; patient_name: string;
  month: string; version: number; previous_id: string | null; body: string; sha256: string;
};

const anonymous: ClaimActor = { kind: 'anonymous' };
const columns = 'seq, id, patient_id, chart_number, patient_name, month, version, previous_id';

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function recordHash(row: Omit<RecordRow, 'sha256'>) {
  return hash(JSON.stringify([row.seq, row.id, row.patient_id, row.chart_number, row.patient_name,
    row.month, row.version, row.previous_id, row.body]));
}

function summary(row: Omit<RecordRow, 'body' | 'sha256'>, confirmedAt: string): ClaimRecordSummary {
  return {
    id: row.id, patientId: row.patient_id, chartNumber: row.chart_number, patientName: row.patient_name,
    month: row.month, version: row.version, previousId: row.previous_id,
    confirmedAt,
  };
}

function decode(row: RecordRow): ClaimRecord {
  if (recordHash(row) !== row.sha256) throw new WorkspaceError(500, '確定記録の整合性を確認できません。');
  const body = JSON.parse(row.body) as RecordBody;
  if (body.snapshot.schemaVersion !== 1) throw new WorkspaceError(500, '未対応の請求記録形式です。');
  return { ...summary(row, body.confirmedAt), ...body, sha256: row.sha256 };
}

function snapshotFor(db: DatabaseSync, source: PatientRecord): ClaimSnapshot {
  const { notes: _notes, ...profile } = source;
  const patient = {
    ...profile,
    diagnoses: profile.diagnoses.filter(({ startDate }) => startDate.slice(0, 7) <= DEMO_MONTH),
    billingItems: profile.billingItems.filter(({ date }) => date.slice(0, 7) === DEMO_MONTH),
  };
  const ids = new Set([...patient.diagnoses, ...patient.billingItems].flatMap(({ masterImportId }) =>
    masterImportId === undefined ? [] : [masterImportId]));
  const lookup = db.prepare(`SELECT id, kind, filename, published_on AS publishedOn, imported_at AS importedAt,
    sha256, row_count AS rowCount FROM master_imports WHERE id = ?`);
  const masters = [...ids].sort((a, b) => a - b).map((id) => {
    const entry = lookup.get(id);
    if (!entry) throw new WorkspaceError(500, '確定対象の公式マスターの版を確認できません。');
    return entry as unknown as MasterImport;
  });
  const findings = runMhlwReceiptCheck(patient, DEMO_DATE);
  patient.auditStatus = findings.some(({ severity }) => severity !== 'opportunity') ? '要確認' : '点検済・適正';
  return {
    schemaVersion: 1,
    ruleVersion: 'recept-demo-v1',
    month: DEMO_MONTH,
    facility: {
      facilityCode: CLINIC_FACILITY_INFO.facilityCode,
      facilityName: CLINIC_FACILITY_INFO.facilityName,
      prefectureCode: CLINIC_FACILITY_INFO.prefectureCode,
      phone: CLINIC_FACILITY_INFO.phone,
    },
    patient,
    calculation: calculateReceiptPointsAndCopay(patient),
    linePoints: Object.fromEntries(patient.billingItems.map((item) => [item.id, calculateLineItemPoints(item)])),
    findings,
    masters,
  };
}

export function claimRecords(db: DatabaseSync) {
  function preview(patient: PatientRecord, revision: number): ClaimConfirmation {
    const row = db.prepare(`SELECT ${columns}, body, sha256 FROM claim_records
      WHERE patient_id = ? AND month = ? ORDER BY version DESC LIMIT 1`).get(patient.id, DEMO_MONTH);
    const previous = row ? decode(row as RecordRow) : null;
    const snapshot = snapshotFor(db, patient);
    const reviewHash = hash(JSON.stringify(snapshot));
    return {
      revision, snapshot, reviewHash,
      previous: row && previous ? summary(row as RecordRow, previous.confirmedAt) : null,
      hasChanges: !previous || hash(JSON.stringify(previous.snapshot)) !== reviewHash,
    };
  }

  return {
    preview,
    noteEdit(patientIds: string[], editor: ClaimEditor) {
      const save = db.prepare(`INSERT INTO claim_draft_editor (patient_id, editor) VALUES (?, ?)
        ON CONFLICT (patient_id) DO UPDATE SET editor = excluded.editor`);
      for (const id of patientIds) save.run(id, JSON.stringify(editor));
    },
    finalize(patient: PatientRecord, revision: number, reviewHash: string, reason?: string, actor = anonymous) {
      const reviewed = preview(patient, revision);
      if (reviewHash !== reviewed.reviewHash) throw new WorkspaceError(409, '確認時から内容が変わりました。内容を確認し直してください。');
      if (!reviewed.hasChanges) throw new WorkspaceError(409, '確定済みの記録から変更がありません。');
      if (Boolean(reviewed.previous) !== Boolean(reason)) {
        throw new WorkspaceError(400, reviewed.previous ? '訂正理由を入力してください。' : '初回確定に訂正理由は指定できません。');
      }
      const editor = db.prepare('SELECT editor FROM claim_draft_editor WHERE patient_id = ?').get(patient.id);
      const body: RecordBody = {
        confirmedAt: new Date().toISOString(),
        confirmedBy: actor,
        enteredBy: editor ? JSON.parse(String(editor.editor)) as ClaimEditor : null,
        correctionReason: reason ?? null,
        snapshot: reviewed.snapshot,
      };
      const row = {
        seq: Number(db.prepare('SELECT coalesce(max(seq), 0) + 1 AS seq FROM claim_records').get()?.seq),
        id: randomUUID(), patient_id: patient.id, chart_number: patient.chartNumber, patient_name: patient.name,
        month: DEMO_MONTH, version: (reviewed.previous?.version ?? 0) + 1,
        previous_id: reviewed.previous?.id ?? null, body: JSON.stringify(body),
      };
      const sha256 = recordHash(row);
      db.prepare(`INSERT INTO claim_records (${columns}, body, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.seq, row.id, row.patient_id, row.chart_number, row.patient_name, row.month, row.version,
          row.previous_id, row.body, sha256);
      return { ...summary(row, body.confirmedAt), ...body, sha256 };
    },
    get(id: string) {
      const row = db.prepare(`SELECT ${columns}, body, sha256 FROM claim_records WHERE id = ?`).get(id);
      if (!row) throw new WorkspaceError(404, '確定記録が見つかりません。');
      return decode(row as RecordRow);
    },
    list(query: string, before: number | null): ClaimRecordPage {
      const limit = 30;
      const rows = db.prepare(`SELECT ${columns}, json_extract(body, '$.confirmedAt') AS confirmedAt
        FROM claim_records
        WHERE (? IS NULL OR seq < ?)
          AND (instr(chart_number, ?) > 0 OR instr(patient_name, ?) > 0)
        ORDER BY seq DESC LIMIT ?`).all(before, before, query, query, limit + 1) as
        (Omit<RecordRow, 'body' | 'sha256'> & Pick<RecordBody, 'confirmedAt'>)[];
      const page = rows.slice(0, limit);
      return { records: page.map((row) => summary(row, row.confirmedAt)), nextBefore: rows.length > limit ? page[limit - 1].seq : null };
    },
    latestForExport() {
      return (db.prepare(`SELECT ${columns}, body, sha256 FROM claim_records AS current
        WHERE month = ? AND NOT EXISTS (SELECT 1 FROM claim_records
          WHERE patient_id = current.patient_id AND month = current.month AND version > current.version)
        ORDER BY patient_id`).all(DEMO_MONTH) as RecordRow[]).map(decode);
    },
  };
}
