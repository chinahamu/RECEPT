import type { ClaimRecord } from './claimRecord';
import type { MasterKind } from '../data/officialMasters';
import type {
  AuditFinding, BillingLineItem, LocalActivityEntry, PatientDiagnosis,
  PatientRecord, ReceiptCalculationResult,
} from './receipt';

export interface PatientView extends PatientRecord {
  calculation: ReceiptCalculationResult;
  findings: AuditFinding[];
  linePoints: Record<string, number>;
}

export interface Workspace {
  revision: number;
  dataExportsEnabled: boolean;
  masterKinds: MasterKind[];
  patients: PatientView[];
  activity: LocalActivityEntry[];
  isOfflineMode: boolean;
}

export interface ClaimPreview {
  month: string;
  revision: number;
  csv: string;
  patientCount: number;
  errorCount: number;
}

export type WorkspaceAction =
  | { type: 'register'; patient: PatientRecord }
  | { type: 'update'; patientId: string; month?: string; diagnoses: PatientDiagnosis[]; billingItems: BillingLineItem[]; summary: string }
  | { type: 'finalize'; patientId: string; month?: string; reviewHash: string; correctionReason?: string }
  | { type: 'fix'; patientId: string; month?: string; findingId: string }
  | { type: 'batchFix' | 'exportCsv'; month?: string }
  | { type: 'toggleOffline' | 'reset' | 'snapshot' };

export interface WorkspaceResult {
  workspace: Workspace;
  claim?: ClaimPreview;
  claimRecord?: ClaimRecord;
}
