import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { INITIAL_PATIENTS } from '../src/data/demoWorkspace';
import type { LocalActivityEntry, PatientRecord } from '../src/types/receipt';
import type { ClaimPreview, Workspace, WorkspaceResult } from '../src/types/workspace';
import {
  applyAutoFixToPatient, calculateLineItemPoints, calculateReceiptPointsAndCopay,
  generateDemoClaimCsv, runMhlwReceiptCheck,
} from '../src/utils/receiptEngine';
import type { ValidRequest } from './validation';
import { WorkspaceError } from './errors';
import { officialMasters } from './officialMasters';
import { clinicalMasters } from './clinicalMasters';
import { protectedDatabasePath, RECEPT_APPLICATION_ID, RECEPT_SCHEMA_VERSIONS } from './databaseFiles';
import { claimRecords } from './claimRecords';
import type { ClaimRecord } from '../src/types/claimRecord';
import { appendAccessAudit, type AuditAccess } from './accessAudit';
import type { MasterKind } from '../src/data/officialMasters';

export { WorkspaceError } from './errors';

type Profile = Omit<PatientRecord, 'diagnoses' | 'billingItems'>;

function transaction<T>(db: DatabaseSync, work: () => T, write = false) {
  db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function readPatients(db: DatabaseSync, patientId?: string): PatientRecord[] {
  const profiles = patientId === undefined ? db.prepare('SELECT profile FROM patients ORDER BY seq DESC').all()
    : db.prepare('SELECT profile FROM patients WHERE id = ?').all(patientId);
  const diagnoses = db.prepare('SELECT detail FROM diagnoses WHERE patient_id = ? ORDER BY position');
  const items = db.prepare('SELECT detail FROM billing_items WHERE patient_id = ? ORDER BY position');
  return profiles.map((row) => {
    const profile: Profile = JSON.parse(String(row.profile));
    return {
      ...profile,
      diagnoses: diagnoses.all(profile.id).map((entry) => JSON.parse(String(entry.detail))),
      billingItems: items.all(profile.id).map((entry) => JSON.parse(String(entry.detail))),
    };
  });
}

function writePatient(db: DatabaseSync, patient: PatientRecord) {
  const { diagnoses, billingItems, ...profile } = patient;
  db.prepare(`
    INSERT INTO patients (id, chart_number, profile) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET chart_number = excluded.chart_number, profile = excluded.profile
  `).run(patient.id, patient.chartNumber, JSON.stringify(profile));

  db.prepare('DELETE FROM diagnoses WHERE patient_id = ?').run(patient.id);
  db.prepare('DELETE FROM billing_items WHERE patient_id = ?').run(patient.id);
  const diagnosis = db.prepare('INSERT INTO diagnoses VALUES (?, ?, ?, ?)');
  const item = db.prepare('INSERT INTO billing_items VALUES (?, ?, ?, ?)');
  diagnoses.forEach((entry, index) => diagnosis.run(patient.id, index, entry.id, JSON.stringify(entry)));
  billingItems.forEach((entry, index) => item.run(patient.id, index, entry.id, JSON.stringify(entry)));
}

function replacePatients(db: DatabaseSync, patients: PatientRecord[]) {
  db.exec('DELETE FROM patients');
  for (const patient of [...patients].reverse()) writePatient(db, patient);
}

function record(db: DatabaseSync, actionType: LocalActivityEntry['actionType'], patientChartNumber: string, summary: string) {
  const entry: LocalActivityEntry = {
    id: randomUUID(), timestamp: new Date().toISOString(), actionType, patientChartNumber, summary,
  };
  db.prepare('INSERT INTO activity (entry) VALUES (?)').run(JSON.stringify(entry));
}

function workspaceFromDb(db: DatabaseSync, dataExportsEnabled: boolean): Workspace {
  const settings = db.prepare('SELECT revision, offline FROM workspace WHERE id = 1').get()!;
  const activity = db.prepare('SELECT entry FROM activity ORDER BY seq DESC LIMIT 50').all();
  return {
    revision: Number(settings.revision),
    dataExportsEnabled,
    isOfflineMode: Boolean(settings.offline),
    masterKinds: db.prepare('SELECT DISTINCT kind FROM master_imports').all().map((row) => row.kind as MasterKind),
    activity: activity.map((row) => JSON.parse(String(row.entry))),
    patients: readPatients(db).map((patient) => ({
      ...patient,
      calculation: calculateReceiptPointsAndCopay(patient),
      findings: runMhlwReceiptCheck(patient),
      linePoints: Object.fromEntries(patient.billingItems.map((item) => [item.id, calculateLineItemPoints(item)])),
    })),
  };
}

function claimPreview(records: ClaimRecord[], revision: number): ClaimPreview {
  const snapshots = records.map(({ snapshot }) => snapshot);
  const facility = snapshots[0]?.facility;
  const month = snapshots[0]?.month;
  if (snapshots.some((snapshot) => JSON.stringify(snapshot.facility) !== JSON.stringify(facility))) {
    throw new WorkspaceError(409, '医療機関情報が異なる確定記録を同じCSVに出力できません。');
  }
  return {
    revision,
    csv: generateDemoClaimCsv(snapshots.map(({ patient, calculation, linePoints }) =>
      ({ ...patient, calculation, linePoints })), facility, month),
    patientCount: records.length,
    errorCount: snapshots.reduce((sum, { findings }) => sum + findings.filter((f) => f.severity === 'error').length, 0),
  };
}

function evaluated(patient: PatientRecord): PatientRecord {
  const hasIssues = runMhlwReceiptCheck(patient).some((finding) => finding.severity !== 'opportunity');
  return { ...patient, auditStatus: hasIssues ? '要確認' : '点検済・適正' };
}

function withMasterData(masters: ReturnType<typeof clinicalMasters>, patient: PatientRecord, previous?: PatientRecord): PatientRecord {
  return {
    ...patient,
    diagnoses: patient.diagnoses.map((diagnosis) => {
      const old = previous?.diagnoses.find((entry) => entry.id === diagnosis.id && entry.diseaseCode === diagnosis.diseaseCode);
      if (old) return { ...old, outcome: diagnosis.outcome, isMain: diagnosis.isMain, isSuspected: diagnosis.isSuspected };
      const master = masters.lookup('b', diagnosis.diseaseCode, diagnosis.startDate);
      if (!master) throw new WorkspaceError(400, '取り込み済みの公式マスターに登録可能な傷病名がありません。');
      return { ...diagnosis, diseaseName: master.name, icd10: master.icd10, masterImportId: master.masterImportId };
    }),
    billingItems: patient.billingItems.map((item) => {
      const old = previous?.billingItems.find((entry) => entry.id === item.id && entry.code === item.code);
      const source = old ?? masters.lookup('s', item.code, item.date);
      if (!source) throw new WorkspaceError(400, '取り込み済みの公式マスターに登録可能な診療行為がありません。');
      const { code, name, category, categoryName, itemType, points, unit, masterImportId } = source;
      return { ...item, code, name, category, categoryName, itemType, points, unit, masterImportId, date: old?.date ?? item.date };
    }),
  };
}

function applyAction(db: DatabaseSync, masters: ReturnType<typeof clinicalMasters>, action: Exclude<ValidRequest['action'], { type: 'finalize' }>) {
  switch (action.type) {
    case 'reset': {
      const previousIds = db.prepare('SELECT id FROM patients').all().map((row) => String(row.id));
      replacePatients(db, INITIAL_PATIENTS);
      db.exec('DELETE FROM activity; UPDATE workspace SET offline = 0 WHERE id = 1');
      return [...new Set([...previousIds, ...INITIAL_PATIENTS.map(({ id }) => id)])];
    }
    case 'toggleOffline':
      db.exec('UPDATE workspace SET offline = 1 - offline WHERE id = 1');
      return [];
    case 'exportCsv':
      record(db, 'CSV_EXPORT', 'ALL-RECEIPTS', 'デモ請求CSVの出力を要求');
      return [];
    case 'snapshot':
      record(db, 'BACKUP_SNAPSHOT', 'SYSTEM', 'デモデータのスナップショットJSON出力を要求');
      return [];
  }

  const patients = readPatients(db);
  if (action.type === 'register') {
    if (patients.length >= 250) throw new WorkspaceError(400, 'デモ患者の登録上限に達しました。');
    let chartNumber = 1210 + patients.length;
    const archived = db.prepare('SELECT 1 FROM claim_records WHERE chart_number = ? LIMIT 1');
    const chart = (number: number) => `PT-${String(number).padStart(6, '0')}`;
    while (patients.some((patient) => patient.chartNumber === chart(chartNumber)) || archived.get(chart(chartNumber))) chartNumber++;
    const patient = evaluated(withMasterData(masters, {
      ...action.patient,
      id: randomUUID(),
      chartNumber: chart(chartNumber),
    }));
    writePatient(db, patient);
    record(db, 'PATIENT_REGISTER', patient.chartNumber, `デモ患者登録: ${patient.name}`);
    return [patient.id];
  }

  if (action.type === 'batchFix') {
    const affectedPatientIds: string[] = [];
    for (const patient of patients) {
      let current = patient;
      for (let pass = 0; pass < 8; pass++) {
        const finding = runMhlwReceiptCheck(current).find((entry) => entry.severity !== 'opportunity' && entry.fixAction);
        if (!finding?.fixAction) break;
        current = applyAutoFixToPatient(current, finding.fixAction);
      }
      if (current !== patient) {
        writePatient(db, current);
        affectedPatientIds.push(current.id);
      }
    }
    record(db, 'AUDIT_AUTO_FIX', 'ALL-RECEIPTS', 'デモ点検の一括補正を実行');
    return affectedPatientIds;
  }
  if (!('patientId' in action)) return [];
  const patient = patients.find((entry) => entry.id === action.patientId);
  if (!patient) throw new WorkspaceError(404, '対象のデモ患者が見つかりません。');
  if (action.type === 'update') {
    const next = withMasterData(masters, { ...patient, diagnoses: action.diagnoses, billingItems: action.billingItems }, patient);
    writePatient(db, evaluated(next));
    record(db, 'BILLING_UPDATE', patient.chartNumber, action.summary);
  } else {
    const finding = runMhlwReceiptCheck(patient).find((entry) => entry.id === action.findingId);
    if (!finding?.fixAction) throw new WorkspaceError(400, '現在の点検結果に補正候補がありません。');
    writePatient(db, applyAutoFixToPatient(patient, finding.fixAction));
    record(db, 'AUDIT_AUTO_FIX', patient.chartNumber, `デモ点検補正: ${finding.title} → ${finding.fixAction.label}`);
  }
  return [patient.id];
}

export function openWorkspace(path?: string, dataExportsEnabled = process.env.RECEPT_ENABLE_DEMO_EXPORTS === '1') {
  const filename = protectedDatabasePath(path);
  function requireDataExports() {
    if (!dataExportsEnabled) throw new WorkspaceError(403, 'デモデータ出力は無効です。');
  }
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY; PRAGMA secure_delete = ON');
    transaction(db, () => {
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if (db.prepare('PRAGMA application_id').get()?.application_id !== RECEPT_APPLICATION_ID ||
          !RECEPT_SCHEMA_VERSIONS.includes(version)) {
        throw new WorkspaceError(503, '未対応のSQLiteスキーマです。RECEPT用DBを指定してください。');
      }
      if (version === 1) db.exec(readFileSync(new URL('../database/002-official-masters.sql', import.meta.url), 'utf8'));
      if (version === 1 || version === 2) db.exec(readFileSync(new URL('../database/003-access-audit.sql', import.meta.url), 'utf8'));
      if (version !== 4) db.exec(readFileSync(new URL('../database/004-claim-records.sql', import.meta.url), 'utf8'));
      if (db.prepare('SELECT seeded FROM workspace WHERE id = 1').get()?.seeded) return;
      replacePatients(db, INITIAL_PATIENTS);
      db.exec('UPDATE workspace SET seeded = 1 WHERE id = 1');
    }, true);
  } catch (error) {
    db.close();
    throw error;
  }

  const claims = claimRecords(db);
  const revisionNow = () => Number(db.prepare('SELECT revision FROM workspace WHERE id = 1').get()?.revision);
  function patientForClaim(id: string) {
    const patient = readPatients(db, id)[0];
    if (!patient) throw new WorkspaceError(404, '対象のデモ患者が見つかりません。');
    return patient;
  }

  const clinical = clinicalMasters(db);
  const masters = officialMasters(db, (work) => transaction(db, work, true));
  return {
    close: () => db.close(),
    clinical,
    masters,
    read: (access?: AuditAccess) => transaction(db, () => {
      const workspace = workspaceFromDb(db, dataExportsEnabled);
      if (access) appendAccessAudit(db, access, {
        status: 200, patientIds: workspace.patients.map(({ id }) => id),
      });
      return workspace;
    }, Boolean(access)),
    preview: (access?: AuditAccess) => transaction(db, () => {
      requireDataExports();
      const records = claims.latestForExport();
      const result = claimPreview(records, revisionNow());
      if (access) appendAccessAudit(db, access, {
        status: 200, patientIds: records.map(({ patientId }) => patientId), claimRecordIds: records.map(({ id }) => id),
      });
      return result;
    }, Boolean(access)),
    previewConfirmation: (patientId: string, access?: AuditAccess) => transaction(db, () => {
      const result = claims.preview(patientForClaim(patientId), revisionNow());
      if (access) appendAccessAudit(db, access, { status: 200, patientIds: [patientId] });
      return result;
    }, Boolean(access)),
    listClaimRecords: (query: string, before: number | null, access: AuditAccess) => transaction(db, () => {
      const page = claims.list(query, before);
      appendAccessAudit(db, access, {
        status: 200, patientIds: [...new Set(page.records.map(({ patientId }) => patientId))],
        claimRecordIds: page.records.map(({ id }) => id),
      });
      return page;
    }, true),
    readClaimRecord: (id: string, access: AuditAccess, exporting = false) => transaction(db, () => {
      if (exporting) requireDataExports();
      const result = claims.get(id);
      appendAccessAudit(db, access, { status: 200, patientIds: [result.patientId], claimRecordIds: [id] });
      return result;
    }, true),
    apply: ({ revision, action }: ValidRequest, access?: AuditAccess): WorkspaceResult => transaction(db, () => {
      if (action.type === 'snapshot' || action.type === 'exportCsv') requireDataExports();
      if (revision !== revisionNow()) {
        throw new WorkspaceError(409, '別の画面でデータが更新されました。最新データを読み込んでから再操作してください。');
      }
      let claimRecord: ClaimRecord | undefined;
      let affectedPatientIds: string[];
      if (action.type === 'finalize') {
        const patient = patientForClaim(action.patientId);
        claimRecord = claims.finalize(patient, revision, action.reviewHash, action.correctionReason, access?.actor);
        const calc = claimRecord.snapshot.calculation;
        record(db, 'BILLING_UPDATE', patient.chartNumber,
          `デモ会計確定: 総点数 ${calc.totalPoints}点 / 窓口負担 ${calc.copayRoundedYen}円（第${claimRecord.version}版）`);
        affectedPatientIds = [patient.id];
      } else {
        affectedPatientIds = applyAction(db, clinical, action);
        if (action.type === 'register' || action.type === 'update' || action.type === 'fix' || action.type === 'batchFix') {
          claims.noteEdit(affectedPatientIds, {
            actor: access?.actor ?? { kind: 'anonymous' }, at: new Date().toISOString(),
          });
        }
      }
      db.exec('UPDATE workspace SET revision = revision + 1 WHERE id = 1');
      const workspace = workspaceFromDb(db, dataExportsEnabled);
      const exported = action.type === 'exportCsv' ? claims.latestForExport() : [];
      const claim = action.type === 'exportCsv' ? claimPreview(exported, workspace.revision) : undefined;
      if (access) appendAccessAudit(db, access, {
        status: 200, affectedPatientIds,
        patientIds: [...new Set([...workspace.patients.map(({ id }) => id), ...exported.map(({ patientId }) => patientId)])],
        claimRecordIds: claimRecord ? [claimRecord.id] : claim ? exported.map(({ id }) => id) : undefined,
      });
      return { workspace, claim, claimRecord };
    }, true),
    readMasters: (kind: 'b' | 's' | null, importId: number | null, query: string, access: AuditAccess) =>
      transaction(db, () => {
        const result = kind ? clinical.search(kind, query)
          : importId === null ? masters.list() : masters.search(importId, query);
        appendAccessAudit(db, access, { status: 200, masterImportId: importId ?? undefined });
        return result;
      }, true),
    importMaster: (file: Parameters<typeof masters.import>[0], bytes: Buffer, access: AuditAccess) =>
      masters.import(file, bytes, ({ entry, duplicate }) => {
        appendAccessAudit(db, access, { status: 200, masterImportId: entry.id, duplicate });
      }),
    recordFailure: (access: AuditAccess, status: number) =>
      transaction(db, () => appendAccessAudit(db, access, { status }), true),
  };
}
