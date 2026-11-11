import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DencalDraftReview, DraftChange, InboxRecord } from '../src/types/dencalInbox';
import type { BillingLineItem, PatientDiagnosis, PatientRecord } from '../src/types/receipt';
import type { clinicalMasters } from './clinicalMasters';
import type { Message } from './dencalInbox';
import { WorkspaceError } from './errors';

type Draft = Pick<PatientRecord, 'diagnoses' | 'billingItems'>;
type ApplicationRow = { patient_id: string; transfer_revision: number; draft: string };
const outcomes = {
  ongoing: '継続', cured: '治癒', discontinued: '中止', transferred: '移行', unknown: '不明',
} as const;

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function changes<T extends BillingLineItem | PatientDiagnosis>(previous: T[], current: T[]): DraftChange<T>[] {
  const oldById = new Map(previous.map((item) => [item.id, item]));
  const result: DraftChange<T>[] = [];
  for (const item of current) {
    const before = oldById.get(item.id) ?? null;
    oldById.delete(item.id);
    if (before !== item) result.push({ before, after: item });
  }
  for (const before of oldById.values()) result.push({ before, after: null });
  return result;
}

function preserveUnchanged<T extends BillingLineItem | PatientDiagnosis>(previous: T[], current: T[]): T[] {
  const oldById = new Map(previous.map((item) => [item.id, item]));
  return current.sort((a, b) => a.id.localeCompare(b.id)).map((item) => {
    const old = oldById.get(item.id);
    if (old && hash({ ...old, dencalSource: undefined }) === hash({ ...item, dencalSource: undefined })) return old;
    if (old && hash({ ...old, dencalSource: undefined, dencalMonths: undefined }) ===
        hash({ ...item, dencalSource: undefined, dencalMonths: undefined })) {
      return { ...item, dencalSource: old.dencalSource };
    }
    return item;
  });
}

export function readDencalDrafts(db: DatabaseSync, patientId: string): Draft[] {
  const rows = db.prepare(`
    SELECT a.draft FROM dencal_draft_applications a JOIN dencal_inbox i ON i.seq = a.inbox_seq
    WHERE a.patient_id = ? AND NOT EXISTS (
      SELECT 1 FROM dencal_draft_applications next JOIN dencal_inbox n ON n.seq = next.inbox_seq
      WHERE n.facility_id = i.facility_id AND n.sender_id = i.sender_id AND n.encounter_id = i.encounter_id
        AND n.transfer_revision > i.transfer_revision
    )
    ORDER BY i.facility_id, i.sender_id, i.encounter_id
  `).all(patientId);
  return rows.map(({ draft }) => JSON.parse(String(draft)) as Draft);
}

export function prepareDencalDraft(
  db: DatabaseSync, masters: ReturnType<typeof clinicalMasters>, record: InboxRecord,
  message: Message, patient: PatientRecord, revision: number,
) {
  const { facilityId, senderId, encounterId, transferRevision } = message;
  const latest = db.prepare(`
    SELECT a.patient_id, i.transfer_revision, a.draft
    FROM dencal_draft_applications a JOIN dencal_inbox i ON i.seq = a.inbox_seq
    WHERE i.facility_id = ? AND i.sender_id = ? AND i.encounter_id = ?
    ORDER BY i.transfer_revision DESC LIMIT 1
  `).get(facilityId, senderId, encounterId) as ApplicationRow | undefined;
  if (latest && (latest.patient_id !== patient.id || latest.transfer_revision >= transferRevision)) {
    throw new WorkspaceError(409, 'この版以降のデータが反映済みです。');
  }
  const previous = latest ? JSON.parse(latest.draft) as Draft : { diagnoses: [], billingItems: [] };
  const source = (sourceId: string) => ({ facilityId, senderId, encounterId, transferRevision, sourceId });
  const itemId = (kind: string, sourceId: string) => 'dencal-' + hash([facilityId, senderId, encounterId, kind, sourceId]);

  const billingItems = message.performances.filter(({ status }) => status === 'performed').map((item): BillingLineItem => {
    const master = masters.lookup('s', item.code, item.performedOn);
    if (!master || master.unit !== item.unit) throw new WorkspaceError(409, '診療行為のマスターを確認してください。');
    return { id: itemId('performance', item.id), ...master, date: item.performedOn,
      quantity: item.quantity, days: 1, dencalSource: source(item.id) };
  });
  const encounterMonths = [...new Set([message.visitDate.slice(0, 7), ...billingItems.map(({ date }) => date.slice(0, 7))])].sort();
  const diagnoses = message.diagnoses.map((item): PatientDiagnosis => {
    const master = masters.lookup('b', item.code, item.startDate);
    if (!master) throw new WorkspaceError(409, '傷病名のマスターを確認してください。');
    return { id: itemId('diagnosis', item.id), diseaseCode: master.code, diseaseName: master.name,
      icd10: master.icd10, masterImportId: master.masterImportId, startDate: item.startDate,
      isSuspected: item.isSuspected, isMain: item.isMain, outcome: outcomes[item.outcome],
      dencalSource: source(item.id), dencalMonths: encounterMonths.filter((month) => month >= item.startDate.slice(0, 7)) };
  });
  const draft = {
    diagnoses: preserveUnchanged(previous.diagnoses, diagnoses),
    billingItems: preserveUnchanged(previous.billingItems, billingItems),
  };
  const diagnosisDiff = changes(previous.diagnoses, draft.diagnoses);
  const billingDiff = changes(previous.billingItems, draft.billingItems);
  const months = new Set<string>();
  for (const { before, after } of billingDiff) {
    for (const line of [before, after]) if (line) months.add(line.date.slice(0, 7));
  }
  for (const { before, after } of diagnosisDiff) {
    for (const month of new Set([...(before?.dencalMonths ?? []), ...(after?.dencalMonths ?? [])])) {
      const forMonth = (item: PatientDiagnosis | null) => item?.dencalMonths?.includes(month)
        ? { ...item, dencalMonths: undefined, dencalSource: undefined } : null;
      if (hash(forMonth(before)) !== hash(forMonth(after))) months.add(month);
    }
  }
  const confirmed = db.prepare('SELECT max(version) AS version FROM claim_records WHERE patient_id = ? AND month = ?');
  const review = {
    previousTransferRevision: latest?.transfer_revision ?? null,
    qualification: {
      insuranceCategory: patient.insuranceCategory, insurerNumber: patient.insurerNumber,
      symbolNumber: patient.symbolNumber, verified: patient.mynaVerified,
    },
    months: [...months].sort().map((month) => ({
      month, confirmedVersion: confirmed.get(patient.id, month)?.version as number | null,
    })),
    diagnoses: diagnosisDiff,
    billingItems: billingDiff,
  };
  const result: DencalDraftReview = {
    ...review, reviewHash: hash([revision, record.seq, record.receipt.bodySha256, patient.id, draft, review]),
  };
  return { draft, review: result };
}
