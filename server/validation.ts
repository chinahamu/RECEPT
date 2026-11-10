import { z } from 'zod';

const text = z.string().min(1).max(250);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const date = z.iso.date();
const diagnosis = z.object({
  id,
  diseaseCode: z.string().regex(/^\d{7}$/),
  diseaseName: text,
  icd10: text,
  startDate: date,
  outcome: z.enum(['継続', '治癒', '中止', '移行']),
  isMain: z.boolean(),
  isSuspected: z.boolean(),
});
const billingItem = z.object({
  id,
  code: z.string().regex(/^\d{9}$/),
  name: text,
  category: z.enum(['11', '12', '13', '14', '21', '30', '40', '60', '70', '80']),
  categoryName: text,
  itemType: z.enum(['procedure', 'drug', 'material']),
  points: z.number().min(0).max(100_000),
  quantity: z.number().positive().max(90),
  days: z.number().int().min(1).max(90),
  unit: text,
  commentCode: z.string().max(30).optional(),
  commentText: z.string().max(2000).optional(),
  date,
});

function unique<T>(items: T[], key: (item: T) => string) {
  return new Set(items.map(key)).size === items.length;
}

const diagnoses = z.array(diagnosis).max(300).refine((items) => unique(items, (item) => item.id));
const billingItems = z.array(billingItem).max(300).refine((items) => unique(items, (item) => item.id));
const patient = z.object({
  id,
  chartNumber: text,
  name: text.trim().min(1),
  kana: text.trim().min(1),
  birthDate: date,
  sex: z.enum(['男', '女']),
  insuranceCategory: z.enum(['社保', '国保', '後期高齢者']),
  insurerNumber: z.string().regex(/^\d{6,8}$/),
  symbolNumber: text,
  copayRatio: z.literal([0.1, 0.2, 0.3]),
  publicExpenseNumber: text.optional(),
  mynaVerified: z.boolean(),
  lastVisitDate: date,
  visitCountThisMonth: z.number().int().min(0).max(31),
  previousMonthTotalPoints: z.number().int().min(0).max(10_000_000),
  auditStatus: z.enum(['未点検', '要確認', '点検済・適正']),
  diagnoses,
  billingItems,
  notes: z.string().max(4000).optional(),
});

const activity = z.object({
  id,
  timestamp: text,
  actionType: z.enum(['BILLING_UPDATE', 'DIAGNOSIS_ADD', 'AUDIT_AUTO_FIX', 'PATIENT_REGISTER', 'CSV_EXPORT', 'BACKUP_SNAPSHOT']),
  patientChartNumber: text,
  summary: z.string().min(1).max(2500),
});

export const requestSchema = z.object({
  revision: z.number().int().nonnegative(),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('register'), patient }),
    z.object({ type: z.literal('update'), patientId: id, diagnoses, billingItems, summary: z.string().min(1).max(2500) }),
    z.object({ type: z.literal('finalize'), patientId: id }),
    z.object({ type: z.literal('fix'), patientId: id, findingId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/) }),
    z.object({ type: z.literal(['batchFix', 'toggleOffline', 'reset', 'exportCsv', 'snapshot']) }),
    z.object({
      type: z.literal('importLegacy'),
      patients: z.array(patient).min(1).max(250)
        .refine((items) => unique(items, (item) => item.id) && unique(items, (item) => item.chartNumber)),
      activity: z.array(activity).max(50),
      isOfflineMode: z.boolean(),
    }),
  ]),
});

export type ValidRequest = z.infer<typeof requestSchema>;
