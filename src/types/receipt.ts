export type InsuranceCategory = '社保' | '国保' | '後期高齢者';
export type CopayRatio = 0.1 | 0.2 | 0.3;
export type typeBillingCategoryCode = '11' | '12' | '13' | '14' | '21' | '30' | '40' | '60' | '70' | '80';

export interface DencalDraftSource {
  facilityId: string;
  senderId: string;
  encounterId: string;
  transferRevision: number;
  sourceId: string;
}

export interface PatientDiagnosis {
  dencalSource?: DencalDraftSource;
  dencalMonths?: string[];
  id: string;
  masterImportId?: number;
  diseaseCode: string;
  diseaseName: string;
  icd10: string;
  startDate: string; // YYYY-MM-DD
  outcome: '継続' | '治癒' | '中止' | '移行' | '不明';
  isMain: boolean;
  isSuspected: boolean; // 疑い病名
}

export interface BillingLineItem {
  dencalSource?: DencalDraftSource;
  id: string;
  masterImportId?: number;
  code: string;
  name: string;
  category: typeBillingCategoryCode;
  categoryName: string;
  itemType: 'procedure' | 'drug' | 'material';
  points: number;
  quantity: number; // 1回量・回数
  days: number; // 日数・回数 (処置等は1、内服薬は処方日数)
  unit: string;
  commentCode?: string; // 8201... / 8301...
  commentText?: string;
  date: string; // YYYY-MM-DD
}

export type AuditSeverity = 'error' | 'warning' | 'opportunity';

export interface AuditFixAction {
  type: 'remove_item' | 'confirm_suspected';
  label: string;
  targetItemId?: string;
  diagnosisId?: string;
}

export interface AuditFinding {
  id: string;
  ruleCode: string; // e.g. R06-001, IND-002, CON-003, LNG-004, OPP-005
  severity: AuditSeverity;
  category: '令和6年改定・算定要件' | '適応傷病名不一致' | '併算定・回数制限' | '縦覧・長期疑い病名' | 'コメント記載漏れ' | '算定漏れ提案';
  title: string;
  description: string;
  mhlwReference: string;
  impactPoints: number; // 査定リスク点数または増点可能点数
  relatedItemId?: string;
  relatedDiagnosisId?: string;
  fixAction?: AuditFixAction;
}

export interface PatientRecord {
  id: string;
  chartNumber: string; // カルテ番号 e.g. PT-001042
  name: string;
  kana: string;
  birthDate: string;
  sex: '男' | '女';
  insuranceCategory: InsuranceCategory;
  insurerNumber: string; // 8桁 保険者番号
  symbolNumber: string; // 記号・番号
  copayRatio: CopayRatio;
  publicExpenseNumber?: string; // 公費負担番号
  mynaVerified: boolean; // デモ上の資格確認フラグ
  lastVisitDate: string;
  visitCountThisMonth: number;
  previousMonthTotalPoints: number;
  auditStatus: '未点検' | '要確認' | '点検済・適正';
  diagnoses: PatientDiagnosis[];
  billingItems: BillingLineItem[];
  notes?: string;
}

export interface ReceiptCalculationResult {
  categoryBreakdown: Record<typeBillingCategoryCode, { label: string; points: number; count: number }>;
  totalPoints: number;
  grossAmountYen: number; // 総医療費 (10円 × 総点数)
  copayRawYen: number;
  copayRoundedYen: number; // 四捨五入（五捨五超入/10円単位端数処理）後の窓口負担金
  insuranceClaimYen: number; // 保険請求額
}

export interface LocalActivityEntry {
  id: string;
  timestamp: string;
  actionType: 'BILLING_UPDATE' | 'DIAGNOSIS_ADD' | 'AUDIT_AUTO_FIX' | 'PATIENT_REGISTER' | 'CSV_EXPORT' | 'BACKUP_SNAPSHOT';
  patientChartNumber: string;
  summary: string;
}
