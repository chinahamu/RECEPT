import type { BillingLineItem, PatientDiagnosis } from './receipt';

export type IntegrationSource = { facilityId: string; senderId: string };
export type InboxIssue = { code: string; path: string };
export type IntegrationReceipt = {
  integrationId: string;
  bodySha256: string;
  status: 'received' | 'confirmation_required' | 'applied' | 'rejected';
  issues: InboxIssue[];
};

export interface InboxRecord extends IntegrationSource {
  seq: number;
  integrationId: string;
  patientSourceId: string;
  encounterId: string;
  transferRevision: number;
  chartRevision: number;
  event: 'initial' | 'correction' | 'cancel';
  visitDate: string;
  receivedAt: string;
  receipt: IntegrationReceipt;
  patient: { id: string; chartNumber: string } | null;
}

export interface InboxDetail extends InboxRecord {
  reason: string | null;
  diagnoses: { id: string; code: string; startDate: string; isSuspected: boolean }[];
  performances: { id: string; code: string; performedOn: string; quantity: number; unit: string; status: 'performed' | 'cancelled' }[];
}

export interface InboxPage {
  records: InboxRecord[];
  nextBefore: number | null;
}

export interface DraftChange<T> {
  before: T | null;
  after: T | null;
}

export interface DencalDraftReview {
  reviewHash: string;
  previousTransferRevision: number | null;
  qualification: { insuranceCategory: string; insurerNumber: string; symbolNumber: string; verified: boolean };
  months: { month: string; confirmedVersion: number | null }[];
  diagnoses: DraftChange<PatientDiagnosis>[];
  billingItems: DraftChange<BillingLineItem>[];
}
