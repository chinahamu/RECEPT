import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { evaluateTransfer, readTransfer } from '../integration/recept-v1/contract.mjs';
import type { InboxDetail, InboxIssue, InboxPage, InboxRecord, IntegrationReceipt, IntegrationSource } from '../src/types/dencalInbox';
import type { clinicalMasters } from './clinicalMasters';
import { WorkspaceError } from './errors';

export type Message = IntegrationSource & {
  integrationId: string; patientId: string; encounterId: string; transferRevision: number; chartRevision: number;
  event: InboxRecord['event']; visitDate: string; reason: string | null;
  diagnoses: (InboxDetail['diagnoses'][number] & { isMain: boolean; outcome: 'ongoing' | 'cured' | 'discontinued' | 'transferred' | 'unknown' })[]; performances: InboxDetail['performances'];
};
type InboxRow = Record<string, SQLOutputValue> & {
  seq: number; facility_id: string; sender_id: string; integration_id: string; patient_source_id: string;
  encounter_id: string; transfer_revision: number; body: Uint8Array; body_sha256: string; received_at: string;
};
type Decoded = { row: InboxRow; message: Message };
type Masters = ReturnType<typeof clinicalMasters>;
type EvaluatedEntry = { message: Message; receipt: IntegrationReceipt };
type Evaluation = { httpStatus: number; body: IntegrationReceipt | { error: string } };

const evaluateContract = evaluateTransfer as unknown as (bytes: Uint8Array, options: {
  source: IntegrationSource;
  inbox: EvaluatedEntry[];
  hasMaster: (system: string, code: string, date: string) => boolean;
}) => Evaluation;

function bodyHash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function decode(row: InboxRow): Decoded {
  const parsed = readTransfer(row.body);
  const message = 'message' in parsed ? parsed.message as Message : undefined;
  if (!message || bodyHash(row.body) !== row.body_sha256 ||
      message.facilityId !== row.facility_id || message.senderId !== row.sender_id ||
      message.integrationId !== row.integration_id || message.patientId !== row.patient_source_id ||
      message.encounterId !== row.encounter_id || message.transferRevision !== row.transfer_revision) {
    throw new WorkspaceError(503, '受信済みデータの整合性を確認できません。');
  }
  return { row, message };
}

export function verifyDencalInbox(db: DatabaseSync) {
  for (const row of db.prepare('SELECT * FROM dencal_inbox').iterate()) decode(row as InboxRow);
}

export function dencalInbox(db: DatabaseSync, masters: Masters) {
  const byId = db.prepare('SELECT * FROM dencal_inbox WHERE facility_id = ? AND sender_id = ? AND integration_id = ?');
  const bySeq = db.prepare('SELECT * FROM dencal_inbox WHERE seq = ?');
  const encounterHistory = db.prepare(`
    SELECT * FROM dencal_inbox WHERE facility_id = ? AND sender_id = ? AND encounter_id = ?
      AND transfer_revision < ? ORDER BY transfer_revision
  `);
  const findPatient = db.prepare(`
    SELECT p.id, p.chart_number AS chartNumber FROM dencal_patient_matches m JOIN patients p ON p.id = m.patient_id
    WHERE m.facility_id = ? AND m.sender_id = ? AND m.patient_source_id = ?
  `);
  const hasMaster = (system: string, code: string, date: string) =>
    Boolean(masters.lookup(system === 'recept-diagnosis' ? 'b' : 's', code, date));

  function evaluate(bytes: Uint8Array, source: IntegrationSource, inbox: EvaluatedEntry[]) {
    return evaluateContract(bytes, { source, inbox, hasMaster });
  }

  function evaluatedReceipt({ row, message }: Decoded, issues: InboxIssue[]): IntegrationReceipt {
    const patient = findPatient.get(message.facilityId, message.senderId, message.patientId);
    const checks = issues.map((issue) => {
      if (issue.code !== 'unknown_master_code') return issue;
      const [, kind, index] = issue.path.split('/');
      const dateAndCode = kind === 'diagnoses'
        ? { kind: 'b' as const, code: message.diagnoses[Number(index)].code, date: message.diagnoses[Number(index)].startDate }
        : { kind: 's' as const, code: message.performances[Number(index)].code, date: message.performances[Number(index)].performedOn };
      return masters.contains(dateAndCode.kind, dateAndCode.code, dateAndCode.date)
        ? { ...issue, code: 'unsupported_billing_rule' } : issue;
    });
    for (const [index, line] of message.performances.entries()) {
      if (line.status === 'cancelled') continue;
      const master = masters.lookup('s', line.code, line.performedOn);
      if (master && master.unit !== line.unit) checks.push({ code: 'unsupported_billing_rule', path: `/performances/${index}/unit` });
    }
    if (!patient) checks.push({ code: 'patient_unmatched', path: '/patientId' });
    return { integrationId: message.integrationId, bodySha256: row.body_sha256,
      status: checks.length ? 'confirmation_required' : 'received', issues: checks };
  }

  function recheck(current: Decoded, inbox: EvaluatedEntry[]): IntegrationReceipt {
    if (db.prepare('SELECT 1 FROM dencal_draft_applications WHERE inbox_seq = ?').get(current.row.seq)) {
      return { integrationId: current.message.integrationId, bodySha256: current.row.body_sha256, status: 'applied', issues: [] };
    }
    const result = evaluate(current.row.body, current.message, inbox);
    if (result.httpStatus === 202 && 'issues' in result.body) {
      return evaluatedReceipt(current, result.body.issues);
    }
    // A version received out of order can conflict once its predecessor is known.
    return { integrationId: current.message.integrationId, bodySha256: current.row.body_sha256, status: 'rejected',
      issues: [{ code: 'review_rejected', path: '' }, { code: 'predecessor_pending', path: '/previousTransferRevision' }] };
  }

  function previous(message: Message) {
    const inbox: EvaluatedEntry[] = [];
    for (const row of encounterHistory.iterate(message.facilityId, message.senderId, message.encounterId, message.transferRevision)) {
      const decoded = decode(row as InboxRow);
      inbox.push({ message: decoded.message, receipt: recheck(decoded, inbox) });
    }
    return inbox;
  }

  function review(current: Decoded): InboxRecord {
    const { row, message } = current;
    const patient = findPatient.get(message.facilityId, message.senderId, message.patientId) as InboxRecord['patient'] | undefined;
    return { seq: row.seq, facilityId: message.facilityId, senderId: message.senderId, integrationId: message.integrationId,
      patientSourceId: message.patientId, encounterId: message.encounterId, transferRevision: message.transferRevision,
      chartRevision: message.chartRevision, event: message.event, visitDate: message.visitDate, receivedAt: row.received_at,
      receipt: recheck(current, previous(message)), patient: patient ?? null };
  }

  function source(seq: number) {
    const row = bySeq.get(seq) as InboxRow | undefined;
    if (!row) throw new WorkspaceError(404, '受信データが見つかりません。');
    return decode(row);
  }

  function detail(seq: number): InboxDetail {
    const current = source(seq);
    const { diagnoses, performances, reason } = current.message;
    return { ...review(current), reason,
      diagnoses: diagnoses.map(({ id, code, startDate, isSuspected }) => ({ id, code, startDate, isSuspected })),
      performances: performances.map(({ id, code, performedOn, quantity, unit, status }) => ({ id, code, performedOn, quantity, unit, status })) };
  }

  return {
    receive(bytes: Buffer, source: IntegrationSource) {
      const parsed = readTransfer(bytes);
      if (!('message' in parsed)) return { ...parsed, duplicate: false, integrationId: undefined };
      const message = parsed.message as Message;
      if (message.facilityId !== source.facilityId || message.senderId !== source.senderId) {
        return { httpStatus: 403, body: { error: 'source_scope_mismatch' }, duplicate: false, integrationId: undefined };
      }
      const integrationId = message.integrationId;
      const hash = bodyHash(bytes);
      const existing = byId.get(source.facilityId, source.senderId, integrationId) as InboxRow | undefined;
      if (existing) {
        const current = decode(existing);
        if (hash !== existing.body_sha256) return { httpStatus: 409, body: { error: 'integration_id_conflict' }, duplicate: false, integrationId };
        return { httpStatus: 200, body: recheck(current, previous(current.message)), duplicate: true, integrationId };
      }
      const occupied = db.prepare(`
        SELECT 1 FROM dencal_inbox WHERE facility_id = ? AND sender_id = ? AND encounter_id = ? AND transfer_revision = ?
      `).get(source.facilityId, source.senderId, message.encounterId, message.transferRevision);
      if (occupied) return { httpStatus: 409, body: { error: 'transfer_revision_conflict' }, duplicate: false, integrationId };
      const history = previous(message);
      const result = evaluate(bytes, source, history);
      if (result.httpStatus !== 202 || !('issues' in result.body)) return { ...result, duplicate: false, integrationId };
      const receivedAt = new Date().toISOString();
      const inserted = db.prepare(`
        INSERT INTO dencal_inbox(facility_id,sender_id,integration_id,patient_source_id,encounter_id,transfer_revision,
          body,body_sha256,received_at) VALUES (?,?,?,?,?,?,?,?,?)
      `).run(source.facilityId, source.senderId, integrationId, message.patientId,
        message.encounterId, message.transferRevision, bytes, hash, receivedAt);
      const row = bySeq.get(inserted.lastInsertRowid) as InboxRow;
      return { httpStatus: 202, body: evaluatedReceipt({ row, message }, result.body.issues), duplicate: false, integrationId };
    },
    receipt(source: IntegrationSource, id: string) {
      const row = byId.get(source.facilityId, source.senderId, id) as InboxRow | undefined;
      if (!row) return undefined;
      const decoded = decode(row);
      return recheck(decoded, previous(decoded.message));
    },
    list(before: number | null): InboxPage {
      const rows = db.prepare('SELECT * FROM dencal_inbox WHERE seq < ? ORDER BY seq DESC LIMIT 26')
        .all(before ?? Number.MAX_SAFE_INTEGER) as InboxRow[];
      const records = rows.slice(0, 25).map((row) => review(decode(row)));
      return { records, nextBefore: rows.length > 25 ? records.at(-1)!.seq : null };
    },
    detail,
    source,
    match(seq: number, patientId: string, chartNumber: string, staffId: string) {
      const current = detail(seq);
      if (current.patient && current.patient.id !== patientId) {
        throw new WorkspaceError(409, 'この送信元の患者は別の患者に紐付け済みです。');
      }
      const target = db.prepare('SELECT chart_number FROM patients WHERE id = ?').get(patientId);
      if (!target || target.chart_number !== chartNumber) throw new WorkspaceError(409, '患者台帳が更新されました。再読込してください。');
      db.prepare(`
        INSERT INTO dencal_patient_matches(facility_id,sender_id,patient_source_id,patient_id,matched_by,matched_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(facility_id,sender_id,patient_source_id) DO NOTHING
      `).run(current.facilityId, current.senderId, current.patientSourceId, patientId, staffId, new Date().toISOString());
      return detail(seq);
    },
  };
}
