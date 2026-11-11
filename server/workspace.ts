import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DEMO_DATE, DEMO_MONTH, INITIAL_PATIENTS } from '../src/data/demoWorkspace';
import type { LocalActivityEntry, PatientRecord } from '../src/types/receipt';
import type { ClaimPreview, Workspace, WorkspaceResult } from '../src/types/workspace';
import {
  applyAutoFixToPatient, calculateLineItemPoints, calculateReceiptPointsAndCopay,
  generateDemoClaimCsv, patientForMonth, referenceDateForMonth, runMhlwReceiptCheck,
} from '../src/utils/receiptEngine';
import type { ValidRequest } from './validation';
import { dencalInbox } from './dencalInbox';
import { prepareDencalDraft, readDencalDrafts } from './dencalDrafts';
import type { IntegrationSource } from '../src/types/dencalInbox';
import { WorkspaceError } from './errors';
import { officialMasters } from './officialMasters';
import { clinicalMasters } from './clinicalMasters';
import { protectedDatabasePath, RECEPT_APPLICATION_ID, RECEPT_SCHEMA_VERSIONS } from './databaseFiles';
import { staffAccounts } from './staffAccounts';
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
    const drafts = readDencalDrafts(db, profile.id);
    return {
      ...profile,
      diagnoses: [...diagnoses.all(profile.id).map((entry) => JSON.parse(String(entry.detail))), ...drafts.flatMap((draft) => draft.diagnoses)],
      billingItems: [...items.all(profile.id).map((entry) => JSON.parse(String(entry.detail))), ...drafts.flatMap((draft) => draft.billingItems)],
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
  diagnoses.filter((entry) => !entry.dencalSource).forEach((entry, index) => diagnosis.run(patient.id, index, entry.id, JSON.stringify(entry)));
  billingItems.filter((entry) => !entry.dencalSource).forEach((entry, index) => item.run(patient.id, index, entry.id, JSON.stringify(entry)));
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

function claimPreview(records: ClaimRecord[], revision: number, month = DEMO_MONTH): ClaimPreview {
  const snapshots = records.map(({ snapshot }) => snapshot);
  const facility = snapshots[0]?.facility;
  if (snapshots.some((snapshot) => JSON.stringify(snapshot.facility) !== JSON.stringify(facility))) {
    throw new WorkspaceError(409, '医療機関情報が異なる確定記録を同じCSVに出力できません。');
  }
  return {
    revision, month,
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
  const month = 'month' in action ? action.month : undefined;
  const forMonth = (patient: PatientRecord) => month ? patientForMonth(patient, month) : patient;
  const referenceDate = month ? referenceDateForMonth(month) : DEMO_DATE;
  const findings = (patient: PatientRecord) => runMhlwReceiptCheck(forMonth(patient), referenceDate);
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
        const finding = findings(current).find((entry) => entry.severity !== 'opportunity' && entry.fixAction);
        if (!finding?.fixAction) break;
        current = applyAutoFixToPatient(current, finding.fixAction, referenceDate);
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
    const manualDiagnoses = patient.diagnoses.filter(({ dencalSource }) => !dencalSource);
    const manualItems = patient.billingItems.filter(({ dencalSource }) => !dencalSource);
    const sourceIds = new Set([...patient.diagnoses, ...patient.billingItems]
      .filter(({ dencalSource }) => dencalSource).map(({ id }) => id));
    const diagnoses = action.diagnoses.filter(({ id }) => !sourceIds.has(id));
    const billingItems = action.billingItems.filter(({ id }) => !sourceIds.has(id));
    if (month && (diagnoses.some(({ startDate }) => startDate.slice(0, 7) > month) ||
        billingItems.some(({ id, date }) => date.slice(0, 7) !== month ||
          manualItems.some((old) => old.id === id && old.date.slice(0, 7) !== month)))) {
      throw new WorkspaceError(400, '選択した診療月の明細を指定してください。');
    }
    const next = withMasterData(masters, {
      ...patient,
      diagnoses: month ? [...diagnoses, ...manualDiagnoses.filter(({ startDate }) => startDate.slice(0, 7) > month)] : diagnoses,
      billingItems: month ? [...billingItems, ...manualItems.filter(({ date }) => date.slice(0, 7) !== month)] : billingItems,
    }, patient);
    writePatient(db, evaluated(next));
    record(db, 'BILLING_UPDATE', patient.chartNumber, action.summary);
  } else {
    const finding = findings(patient).find((entry) => entry.id === action.findingId);
    if (!finding?.fixAction) throw new WorkspaceError(400, '現在の点検結果に補正候補がありません。');
    writePatient(db, applyAutoFixToPatient(patient, finding.fixAction, referenceDate));
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
      if (version < 4) db.exec(readFileSync(new URL('../database/004-claim-records.sql', import.meta.url), 'utf8'));
      if (version < 5) db.exec(readFileSync(new URL('../database/005-staff.sql', import.meta.url), 'utf8'));
      if (version < 6) db.exec(readFileSync(new URL('../database/006-dencal-inbox.sql', import.meta.url), 'utf8'));
      if (version < 7) db.exec(readFileSync(new URL('../database/007-dencal-drafts.sql', import.meta.url), 'utf8'));
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
  const inbox = dencalInbox(db, clinical);
  function reviewDencal(seq: number) {
    const entry = inbox.detail(seq);
    if (entry.receipt.status !== 'received' || !entry.patient) {
      throw new WorkspaceError(409, entry.receipt.status === 'applied' ? 'この版は反映済みです。' : '患者・マスター・受信順の確認が必要です。');
    }
    const patient = patientForClaim(entry.patient.id);
    return { entry, patient, ...prepareDencalDraft(db, clinical, entry, inbox.source(seq).message, patient, revisionNow()) };
  }

  const masters = officialMasters(db, (work) => transaction(db, work, true));
  return {
    close: () => db.close(),
    accounts: staffAccounts(db),
    clinical,
    masters,
    read: (access?: AuditAccess) => transaction(db, () => {
      const workspace = workspaceFromDb(db, dataExportsEnabled);
      if (access) appendAccessAudit(db, access, {
        status: 200, patientIds: workspace.patients.map(({ id }) => id),
      });
      return workspace;
    }, Boolean(access)),
    preview: (access?: AuditAccess, month = DEMO_MONTH) => transaction(db, () => {
      requireDataExports();
      const records = claims.latestForExport(month);
      const result = claimPreview(records, revisionNow(), month);
      if (access) appendAccessAudit(db, access, {
        status: 200, patientIds: records.map(({ patientId }) => patientId), claimRecordIds: records.map(({ id }) => id),
      });
      return result;
    }, Boolean(access)),
    previewConfirmation: (patientId: string, access?: AuditAccess, month = DEMO_MONTH) => transaction(db, () => {
      const result = claims.preview(patientForClaim(patientId), revisionNow(), month);
      if (access) appendAccessAudit(db, access, { status: 200, patientIds: [patientId] });
      return result;
    }, Boolean(access)),
    listClaimRecords: (query: string, before: number | null, access: AuditAccess, month: string | null = null) => transaction(db, () => {
      const page = claims.list(query, before, month);
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
      const actor = access?.actor;
      if (actor?.kind === 'integration') throw new WorkspaceError(403, '職員IDでログインしてください。');
      if (action.type === 'snapshot' || action.type === 'exportCsv') requireDataExports();
      if (revision !== revisionNow()) {
        throw new WorkspaceError(409, '別の画面でデータが更新されました。最新データを読み込んでから再操作してください。');
      }
      let claimRecord: ClaimRecord | undefined;
      let affectedPatientIds: string[];
      if (action.type === 'finalize') {
        const patient = patientForClaim(action.patientId);
        claimRecord = claims.finalize(patient, revision, action.reviewHash, action.correctionReason, actor, action.month);
        const calc = claimRecord.snapshot.calculation;
        record(db, 'BILLING_UPDATE', patient.chartNumber,
          `デモ会計確定 ${claimRecord.month}: 総点数 ${calc.totalPoints}点 / 窓口負担 ${calc.copayRoundedYen}円（第${claimRecord.version}版）`);
        affectedPatientIds = [patient.id];
      } else {
        affectedPatientIds = applyAction(db, clinical, action);
        if (action.type === 'register' || action.type === 'update' || action.type === 'fix' || action.type === 'batchFix') {
          claims.noteEdit(affectedPatientIds, {
            actor: actor ?? { kind: 'anonymous' }, at: new Date().toISOString(),
          }, 'month' in action ? action.month : undefined);
        }
      }
      db.exec('UPDATE workspace SET revision = revision + 1 WHERE id = 1');
      const workspace = workspaceFromDb(db, dataExportsEnabled);
      const exported = action.type === 'exportCsv' ? claims.latestForExport(action.month) : [];
      const claim = action.type === 'exportCsv' ? claimPreview(exported, workspace.revision, action.month) : undefined;
      if (access) appendAccessAudit(db, access, {
        status: 200, affectedPatientIds,
        patientIds: [...new Set([...workspace.patients.map(({ id }) => id), ...exported.map(({ patientId }) => patientId)])],
        claimRecordIds: claimRecord ? [claimRecord.id] : claim ? exported.map(({ id }) => id) : undefined,
      });
      return { workspace, claim, claimRecord };
    }, true),
    readMasters: (kind: 'b' | 's' | null, importId: number | null, query: string, access: AuditAccess, date = DEMO_DATE) =>
      transaction(db, () => {
        const result = kind ? clinical.search(kind, query, date)
          : importId === null ? masters.list() : masters.search(importId, query);
        appendAccessAudit(db, access, { status: 200, masterImportId: importId ?? undefined });
        return result;
      }, true),
    importMaster: (file: Parameters<typeof masters.import>[0], bytes: Buffer, access: AuditAccess) =>
      masters.import(file, bytes, ({ entry, duplicate }) => {
        appendAccessAudit(db, access, { status: 200, masterImportId: entry.id, duplicate });
      }),
    receiveDencal: (bytes: Buffer, source: IntegrationSource, access: AuditAccess) => transaction(db, () => {
      const result = inbox.receive(bytes, source);
      appendAccessAudit(db, access, {
        status: result.httpStatus, duplicate: result.duplicate,
        integrationIds: result.integrationId ? [result.integrationId] : undefined,
      });
      return result;
    }, true),
    readDencalReceipt: (source: IntegrationSource, id: string, access: AuditAccess) => transaction(db, () => {
      const result = inbox.receipt(source, id);
      appendAccessAudit(db, access, { status: result ? 200 : 404, integrationIds: result ? [id] : undefined });
      return result;
    }, true),
    listDencal: (before: number | null, access: AuditAccess) => transaction(db, () => {
      const result = inbox.list(before);
      appendAccessAudit(db, access, { status: 200, integrationIds: result.records.map(({ integrationId }) => integrationId) });
      return result;
    }, true),
    readDencal: (seq: number, access: AuditAccess) => transaction(db, () => {
      const result = inbox.detail(seq);
      appendAccessAudit(db, access, { status: 200, integrationIds: [result.integrationId], patientIds: result.patient ? [result.patient.id] : [] });
      return result;
    }, true),
    matchDencal: (seq: number, patientId: string, chartNumber: string, access: AuditAccess) => transaction(db, () => {
      if (access.actor.kind !== 'authenticated') throw new WorkspaceError(403, '職員IDでログインしてください。');
      const result = inbox.match(seq, patientId, chartNumber, access.actor.userId);
      appendAccessAudit(db, access, { status: 200, integrationIds: [result.integrationId], patientIds: [patientId] });
      return result;
    }, true),
    previewDencalDraft: (seq: number, access: AuditAccess) => transaction(db, () => {
      const { entry, patient, review } = reviewDencal(seq);
      appendAccessAudit(db, access, { status: 200, integrationIds: [entry.integrationId], patientIds: [patient.id] });
      return review;
    }, true),
    applyDencalDraft: (seq: number, reviewHash: string, access: AuditAccess) => transaction(db, () => {
      if (access.actor.kind !== 'authenticated') throw new WorkspaceError(403, '職員IDでログインしてください。');
      const { entry, patient, review, draft } = reviewDencal(seq);
      if (reviewHash !== review.reviewHash) throw new WorkspaceError(409, '確認時から内容が変わりました。差分を確認し直してください。');
      const at = new Date().toISOString();
      db.prepare(`INSERT INTO dencal_draft_applications(inbox_seq, patient_id, applied_by, applied_at, draft)
        VALUES (?,?,?,?,?)`).run(seq, patient.id, access.actor.userId, at, JSON.stringify(draft));
      for (const { month } of review.months) claims.noteEdit([patient.id], { actor: access.actor, at }, month);
      db.exec('UPDATE workspace SET revision = revision + 1 WHERE id = 1');
      record(db, 'BILLING_UPDATE', patient.chartNumber, `DENCAL第${entry.transferRevision}版を下書きに反映`);
      appendAccessAudit(db, access, {
        status: 200, integrationIds: [entry.integrationId], patientIds: [patient.id], affectedPatientIds: [patient.id],
      });
      return inbox.detail(seq);
    }, true),
    recordAccess: (access: AuditAccess, status: number) =>
      transaction(db, () => appendAccessAudit(db, access, { status }), true),
  };
}
