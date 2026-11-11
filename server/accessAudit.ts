import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type AuditActor =
  | { kind: 'authenticated'; userId: string; loginAt: string }
  | { kind: 'anonymous' };

export type AuditAccess = {
  requestId: string;
  requestedAt: string;
  actor: AuditActor;
  resource: 'workspace' | 'claim-preview' | 'official-masters';
  operation: string;
};

type AuditResult = {
  status: number;
  patientIds?: string[];
  affectedPatientIds?: string[];
  masterImportId?: number;
  duplicate?: boolean;
};

type AuditRow = { seq: number; payload: string; previous_hash: string; hash: string };

const genesis = '0'.repeat(64);

function digest(previousHash: string, payload: string) {
  return createHash('sha256').update(previousHash).update(payload).digest('hex');
}

// The caller holds a write transaction for the operation and its audit event.
export function appendAccessAudit(db: DatabaseSync, access: AuditAccess, result: AuditResult) {
  const latest = db.prepare('SELECT seq, hash FROM access_audit ORDER BY seq DESC LIMIT 1').get();
  const seq = Number(latest?.seq ?? 0) + 1;
  const previousHash = String(latest?.hash ?? genesis);
  const payload = JSON.stringify({ ...access, ...result, recordedAt: new Date().toISOString() });
  db.prepare('INSERT INTO access_audit (seq, payload, previous_hash, hash) VALUES (?, ?, ?, ?)')
    .run(seq, payload, previousHash, digest(previousHash, payload));
}

export function verifyAccessAudit(db: DatabaseSync, checkpoint?: { seq: number; hash: string }) {
  let seq = 0;
  let hash = genesis;
  let checkpointMatched = checkpoint === undefined || (checkpoint.seq === seq && checkpoint.hash === hash);
  const entries = db.prepare('SELECT seq, payload, previous_hash, hash FROM access_audit ORDER BY seq');
  for (const row of entries.iterate() as Iterable<AuditRow>) {
    if (row.seq !== seq + 1 || row.previous_hash !== hash || row.hash !== digest(hash, row.payload)) {
      throw new Error(`監査ログの連鎖が不正です (seq=${row.seq})。`);
    }
    seq = row.seq;
    hash = row.hash;
    if (checkpoint?.seq === seq) checkpointMatched = checkpoint.hash === hash;
  }
  if (!checkpointMatched) throw new Error('監査ログが保管済みのチェックポイントと一致しません。');
  return { seq, hash };
}

export function readAccessAudit(db: DatabaseSync, after: number, limit: number) {
  const rows = db.prepare('SELECT seq, payload FROM access_audit WHERE seq > ? ORDER BY seq LIMIT ?');
  return [...rows.iterate(after, limit)].map((row) => ({
    seq: Number(row.seq),
    event: JSON.parse(String(row.payload)) as AuditAccess & AuditResult & { recordedAt: string },
  }));
}
