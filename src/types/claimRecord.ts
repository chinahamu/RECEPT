import type { MasterImport } from '../data/officialMasters';
import type { AuditFinding, PatientRecord, ReceiptCalculationResult } from './receipt';

export type ClaimActor =
  | { kind: 'authenticated'; userId: string; loginAt: string }
  | { kind: 'anonymous' };

export type ClaimEditor = { actor: ClaimActor; at: string };

export interface ClaimSnapshot {
  schemaVersion: 1;
  ruleVersion: 'recept-demo-v1';
  month: string;
  facility: { facilityCode: string; facilityName: string; prefectureCode: string; phone: string };
  patient: Omit<PatientRecord, 'notes'>;
  calculation: ReceiptCalculationResult;
  linePoints: Record<string, number>;
  findings: AuditFinding[];
  masters: MasterImport[];
}

export interface ClaimRecordSummary {
  id: string;
  patientId: string;
  chartNumber: string;
  patientName: string;
  month: string;
  version: number;
  previousId: string | null;
  confirmedAt: string;
}

export interface ClaimRecord extends ClaimRecordSummary {
  correctionReason: string | null;
  sha256: string;
  enteredBy: ClaimEditor | null;
  confirmedBy: ClaimActor;
  snapshot: ClaimSnapshot;
}

export interface ClaimConfirmation {
  revision: number;
  reviewHash: string;
  snapshot: ClaimSnapshot;
  previous: ClaimRecordSummary | null;
  hasChanges: boolean;
}

export interface ClaimRecordPage {
  records: ClaimRecordSummary[];
  nextBefore: number | null;
}
