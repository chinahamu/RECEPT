import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { INITIAL_PATIENTS, MHLW_DISEASE_MASTER, MHLW_PROCEDURE_MASTER } from '../src/data/mhlwMaster';
import type { LocalActivityEntry, PatientRecord } from '../src/types/receipt';
import type { ClaimPreview, Workspace, WorkspaceResult } from '../src/types/workspace';
import {
  applyAutoFixToPatient, calculateLineItemPoints, calculateReceiptPointsAndCopay,
  generateDemoClaimCsv, runMhlwReceiptCheck,
} from '../src/utils/receiptEngine';
import type { ValidRequest } from './validation';

export class WorkspaceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

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

function readPatients(db: DatabaseSync): PatientRecord[] {
  const profiles = db.prepare('SELECT profile FROM patients ORDER BY seq DESC').all();
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

function workspaceFromDb(db: DatabaseSync): Workspace {
  const settings = db.prepare('SELECT revision, offline FROM workspace WHERE id = 1').get()!;
  const activity = db.prepare('SELECT entry FROM activity ORDER BY seq DESC LIMIT 50').all();
  return {
    revision: Number(settings.revision),
    isOfflineMode: Boolean(settings.offline),
    activity: activity.map((row) => JSON.parse(String(row.entry))),
    patients: readPatients(db).map((patient) => ({
      ...patient,
      calculation: calculateReceiptPointsAndCopay(patient),
      findings: runMhlwReceiptCheck(patient),
      linePoints: Object.fromEntries(patient.billingItems.map((item) => [item.id, calculateLineItemPoints(item)])),
    })),
  };
}

function claimPreview(workspace: Workspace): ClaimPreview {
  return {
    csv: generateDemoClaimCsv(workspace.patients),
    patientCount: workspace.patients.length,
    errorCount: workspace.patients.reduce((sum, patient) => sum + patient.findings.filter((f) => f.severity === 'error').length, 0),
  };
}

function evaluated(patient: PatientRecord): PatientRecord {
  const hasIssues = runMhlwReceiptCheck(patient).some((finding) => finding.severity !== 'opportunity');
  return { ...patient, auditStatus: hasIssues ? '要確認' : '点検済・適正' };
}

function withMasterData(patient: PatientRecord, previous?: PatientRecord): PatientRecord {
  return {
    ...patient,
    diagnoses: patient.diagnoses.map((diagnosis) => {
      const old = previous?.diagnoses.find((entry) => entry.id === diagnosis.id && entry.diseaseCode === diagnosis.diseaseCode);
      const master = MHLW_DISEASE_MASTER.find((entry) => entry.code === diagnosis.diseaseCode);
      if (old) return { ...old, outcome: diagnosis.outcome, isMain: diagnosis.isMain, isSuspected: diagnosis.isSuspected };
      if (!master) throw new WorkspaceError(400, 'デモマスタにない傷病名です。');
      return { ...diagnosis, diseaseName: master.name, icd10: master.icd10 };
    }),
    billingItems: patient.billingItems.map((item) => {
      const old = previous?.billingItems.find((entry) => entry.id === item.id && entry.code === item.code);
      const master = MHLW_PROCEDURE_MASTER.find((entry) => entry.code === item.code);
      const source = old ?? master;
      if (!source) throw new WorkspaceError(400, 'デモマスタにない算定項目です。');
      const { code, name, category, categoryName, itemType, points, unit } = source;
      return { ...item, code, name, category, categoryName, itemType, points, unit, date: old?.date ?? item.date };
    }),
  };
}

function applyAction(db: DatabaseSync, action: ValidRequest['action'], revision: number) {
  switch (action.type) {
    case 'reset':
      replacePatients(db, INITIAL_PATIENTS);
      db.exec('DELETE FROM activity; UPDATE workspace SET offline = 0 WHERE id = 1');
      return;
    case 'toggleOffline':
      db.exec('UPDATE workspace SET offline = 1 - offline WHERE id = 1');
      return;
    case 'exportCsv':
      record(db, 'CSV_EXPORT', 'ALL-RECEIPTS', 'デモ請求CSVの出力を要求');
      return;
    case 'snapshot':
      record(db, 'BACKUP_SNAPSHOT', 'SYSTEM', 'デモデータのスナップショットJSON出力を要求');
      return;
    case 'importLegacy':
      if (revision !== 0) throw new WorkspaceError(409, '旧データは、操作履歴のない新規DBにのみ取り込めます。');
      replacePatients(db, action.patients.map(evaluated));
      for (const entry of [...action.activity].reverse()) {
        db.prepare('INSERT INTO activity (entry) VALUES (?)').run(JSON.stringify(entry));
      }
      db.prepare('UPDATE workspace SET offline = ? WHERE id = 1').run(Number(action.isOfflineMode));
      return;
  }

  const patients = readPatients(db);
  if (action.type === 'register') {
    if (patients.length >= 250) throw new WorkspaceError(400, 'デモ患者の登録上限に達しました。');
    let chartNumber = 1210 + patients.length;
    while (patients.some((patient) => patient.chartNumber === `PT-${String(chartNumber).padStart(6, '0')}`)) chartNumber++;
    const patient = evaluated(withMasterData({
      ...action.patient,
      id: randomUUID(),
      chartNumber: `PT-${String(chartNumber).padStart(6, '0')}`,
    }));
    writePatient(db, patient);
    record(db, 'PATIENT_REGISTER', patient.chartNumber, `デモ患者登録: ${patient.name}`);
    return;
  }

  if (action.type === 'batchFix') {
    for (const patient of patients) {
      let current = patient;
      for (let pass = 0; pass < 8; pass++) {
        const finding = runMhlwReceiptCheck(current).find((entry) => entry.severity !== 'opportunity' && entry.fixAction);
        if (!finding?.fixAction) break;
        current = applyAutoFixToPatient(current, finding.fixAction);
      }
      if (current !== patient) writePatient(db, current);
    }
    record(db, 'AUDIT_AUTO_FIX', 'ALL-RECEIPTS', 'デモ点検の一括補正を実行');
    return;
  }

  if (!('patientId' in action)) return;
  const patient = patients.find((entry) => entry.id === action.patientId);
  if (!patient) throw new WorkspaceError(404, '対象のデモ患者が見つかりません。');
  if (action.type === 'update') {
    const next = withMasterData({ ...patient, diagnoses: action.diagnoses, billingItems: action.billingItems }, patient);
    writePatient(db, evaluated(next));
    record(db, 'BILLING_UPDATE', patient.chartNumber, action.summary);
  } else if (action.type === 'fix') {
    const finding = runMhlwReceiptCheck(patient).find((entry) => entry.id === action.findingId);
    if (!finding?.fixAction) throw new WorkspaceError(400, '現在の点検結果に補正候補がありません。');
    writePatient(db, applyAutoFixToPatient(patient, finding.fixAction));
    record(db, 'AUDIT_AUTO_FIX', patient.chartNumber, `デモ点検補正: ${finding.title} → ${finding.fixAction.label}`);
  } else {
    const calc = calculateReceiptPointsAndCopay(patient);
    writePatient(db, evaluated(patient));
    record(db, 'BILLING_UPDATE', patient.chartNumber,
      `デモ会計確定: 総点数 ${calc.totalPoints}点 / 窓口負担 ${calc.copayRoundedYen}円`);
  }
}

export function openWorkspace(path = process.env.RECEPT_DB || 'data/recept.sqlite3') {
  const filename = resolve(path);
  if (!filename.endsWith('.sqlite3') || !existsSync(filename)) {
    throw new WorkspaceError(503, 'SQLite DBを開けません。npm run db:init と RECEPT_DB の設定を確認してください。');
  }
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON');
    if (db.prepare('PRAGMA application_id').get()?.application_id !== 0x52435054 ||
        db.prepare('PRAGMA user_version').get()?.user_version !== 1) {
      throw new WorkspaceError(503, '未対応のSQLiteスキーマです。RECEPT用DBを指定してください。');
    }
    transaction(db, () => {
      if (db.prepare('SELECT seeded FROM workspace WHERE id = 1').get()?.seeded) return;
      replacePatients(db, INITIAL_PATIENTS);
      db.exec('UPDATE workspace SET seeded = 1 WHERE id = 1');
    }, true);
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    close: () => db.close(),
    read: () => transaction(db, () => workspaceFromDb(db)),
    preview: () => transaction(db, () => claimPreview(workspaceFromDb(db))),
    apply: ({ revision, action }: ValidRequest): WorkspaceResult => transaction(db, () => {
      const current = db.prepare('SELECT revision FROM workspace WHERE id = 1').get()?.revision;
      if (revision !== current) {
        throw new WorkspaceError(409, '別の画面でデータが更新されました。最新データを読み込んでから再操作してください。');
      }
      applyAction(db, action, revision);
      db.exec('UPDATE workspace SET revision = revision + 1 WHERE id = 1');
      const workspace = workspaceFromDb(db);
      return action.type === 'exportCsv' ? { workspace, claim: claimPreview(workspace) } : { workspace };
    }, true),
  };
}
