import {
  AuditFinding,
  AuditFixAction,
  BillingLineItem,
  PatientDiagnosis,
  PatientRecord,
  ReceiptCalculationResult,
  typeBillingCategoryCode,
} from '../types/receipt';
import {
  CLINIC_FACILITY_INFO,
  DEMO_DATE,
  DEMO_MONTH,
} from '../data/demoWorkspace';

export const CATEGORY_LABELS: Record<typeBillingCategoryCode, string> = {
  '11': '初・再診料',
  '12': '医学管理等',
  '13': '医学管理等',
  '14': '在宅医療',
  '21': '投薬',
  '30': '注射',
  '40': '処置',
  '60': '検査',
  '70': '画像診断',
  '80': 'その他',
};

/**
 * 1明細行あたりの算定点数計算
 */
export function calculateLineItemPoints(item: BillingLineItem): number {
  return Math.max(0, Math.round(item.points * item.quantity * item.days));
}

/**
 * デモ窓口負担金の10円単位の四捨五入
 */
export function roundCopayToTenYen(rawYen: number): number {
  if (rawYen <= 0) return 0;
  return Math.round(rawYen / 10) * 10;
}

/**
 * 患者レセプトの診療区分別集計・総点数・総医療費・窓口負担金・保険請求額の算出
 */
export function calculateReceiptPointsAndCopay(patient: PatientRecord): ReceiptCalculationResult {
  const categoryBreakdown: Record<typeBillingCategoryCode, { label: string; points: number; count: number }> = {
    '11': { label: CATEGORY_LABELS['11'], points: 0, count: 0 },
    '12': { label: CATEGORY_LABELS['12'], points: 0, count: 0 },
    '13': { label: CATEGORY_LABELS['13'], points: 0, count: 0 },
    '14': { label: CATEGORY_LABELS['14'], points: 0, count: 0 },
    '21': { label: CATEGORY_LABELS['21'], points: 0, count: 0 },
    '30': { label: CATEGORY_LABELS['30'], points: 0, count: 0 },
    '40': { label: CATEGORY_LABELS['40'], points: 0, count: 0 },
    '60': { label: CATEGORY_LABELS['60'], points: 0, count: 0 },
    '70': { label: CATEGORY_LABELS['70'], points: 0, count: 0 },
    '80': { label: CATEGORY_LABELS['80'], points: 0, count: 0 },
  };

  let totalPoints = 0;

  for (const item of patient.billingItems) {
    const linePoints = calculateLineItemPoints(item);
    totalPoints += linePoints;
    const cat = categoryBreakdown[item.category] ? item.category : '80';
    categoryBreakdown[cat].points += linePoints;
    categoryBreakdown[cat].count += 1;
  }

  const grossAmountYen = totalPoints * 10;
  const copayRawYen = grossAmountYen * patient.copayRatio;
  const copayRoundedYen = roundCopayToTenYen(copayRawYen);
  const insuranceClaimYen = Math.max(0, grossAmountYen - copayRoundedYen);

  return {
    categoryBreakdown,
    totalPoints,
    grossAmountYen,
    copayRawYen,
    copayRoundedYen,
    insuranceClaimYen,
  };
}

/**
 * 2つの日付文字列 (YYYY-MM-DD) の月数差を計算（縦覧・長期疑い病名チェック用）
 */
export function getMonthsDifference(startDateStr: string, referenceDateStr = DEMO_DATE): number {
  const start = new Date(startDateStr);
  const ref = new Date(referenceDateStr);
  if (Number.isNaN(start.getTime()) || Number.isNaN(ref.getTime())) return 0;
  return (ref.getFullYear() - start.getFullYear()) * 12 + (ref.getMonth() - start.getMonth());
}

/**
 * サンプルルールによるデモレセプト点検
 */
export function runMhlwReceiptCheck(
  patient: PatientRecord,
  referenceDate = DEMO_DATE
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const activeDiagnoses = patient.diagnoses.filter(
    (d) => d.outcome !== '治癒' && d.outcome !== '中止'
  );

  // 外来管理加算（112011010）と処置（区分40）または生活習慣病管理料の併算定不可チェック
  const gairaiKanriItem = patient.billingItems.find((b) => b.code === '112011010');
  if (gairaiKanriItem) {
    const procedure40Item = patient.billingItems.find((b) => b.category === '40' && b.date === gairaiKanriItem.date);
    const seikatsuItem = patient.billingItems.find((b) => b.name.startsWith('生活習慣病管理料'));
    if (procedure40Item) {
      findings.push({
        id: `chk-con-gairai-${patient.id}`,
        ruleCode: 'CON-001',
        severity: 'error',
        category: '併算定・回数制限',
        title: `外来管理加算（52点）と処置「${procedure40Item.name}」の併算定不可`,
        description:
          '外来管理加算は処置・リハビリテーション等を行わずに計画的な医学管理を行った場合に算定可能です。同日に区分40（処置）が算定されているため併算定不可です。',
        mhlwReference: '医科点数表 A001 再診料 注8 外来管理加算算定要件',
        impactPoints: calculateLineItemPoints(gairaiKanriItem),
        relatedItemId: gairaiKanriItem.id,
        fixAction: {
          type: 'remove_item',
          label: '外来管理加算（52点）を削除',
          targetItemId: gairaiKanriItem.id,
        },
      });
    } else if (seikatsuItem) {
      findings.push({
        id: `chk-con-gairai-seikatsu-${patient.id}`,
        ruleCode: 'CON-002',
        severity: 'error',
        category: '併算定・回数制限',
        title: '生活習慣病管理料(II)と外来管理加算の併算定不可',
        description:
          '生活習慣病管理料(II)には外来管理加算の費用が包括されているため、同一月に併算定することはできません。',
        mhlwReference: '医科点数表 B001-3 生活習慣病管理料(II) 注3',
        impactPoints: calculateLineItemPoints(gairaiKanriItem),
        relatedItemId: gairaiKanriItem.id,
        fixAction: {
          type: 'remove_item',
          label: '外来管理加算（52点）を削除',
          targetItemId: gairaiKanriItem.id,
        },
      });
    }
  }

  // 初診料と再診料の同日重複チェック
  const firstVisitDates = new Set(patient.billingItems.filter((item) => item.code === '111000110').map((item) => item.date));
  const saishin = patient.billingItems.find((item) => item.code === '112007410' && firstVisitDates.has(item.date));
  if (saishin) {
    findings.push({
      id: `chk-con-shoshin-saishin-${patient.id}`,
      ruleCode: 'CON-003',
      severity: 'error',
      category: '併算定・回数制限',
      title: '初診料と再診料の同日重複算定',
      description: '同一受診日において初診料と再診料が重複して算定されています。',
      mhlwReference: '医科点数表 A000 初診料・A001 再診料',
      impactPoints: calculateLineItemPoints(saishin),
      relatedItemId: saishin.id,
      fixAction: {
        type: 'remove_item',
        label: '重複している再診料を削除',
        targetItemId: saishin.id,
      },
    });
  }

  // 縦覧点検 — 長期継続中の「疑い病名」チェック（開始日から2ヶ月以上経過）
  for (const diag of activeDiagnoses) {
    if (diag.isSuspected) {
      const monthsElapsed = getMonthsDifference(diag.startDate, referenceDate);
      if (monthsElapsed >= 2) {
        findings.push({
          id: `chk-lng-susp-${diag.id}`,
          ruleCode: 'LNG-001',
          severity: 'warning',
          category: '縦覧・長期疑い病名',
          title: `長期「疑い病名」継続警告：${diag.diseaseName}の疑い（${monthsElapsed}ヶ月経過）`,
          description: `開始日（${diag.startDate}）から${monthsElapsed}ヶ月間「疑い」のまま継続しています。審査支払機関の縦覧点検により、確定診断への移行または中止・治癒の転帰記載が求められます。`,
          mhlwReference: '社会保険診療報酬支払基金 縦覧・突合点検基準（長期疑い傷病名の整理）',
          impactPoints: 130,
          relatedDiagnosisId: diag.id,
          fixAction: {
            type: 'confirm_suspected',
            label: `「${diag.diseaseName}」を確定病名に移行（疑い解除）`,
            diagnosisId: diag.id,
          },
        });
      }
    }
  }

  return findings;
}

/**
 * ワンクリック自動補正アクションを患者データに適用する純粋関数
 */
export function applyAutoFixToPatient(
  patient: PatientRecord,
  fixAction: AuditFixAction,
  currentDate = DEMO_DATE
): PatientRecord {
  let updatedDiagnoses: PatientDiagnosis[] = [...patient.diagnoses];
  let updatedBillingItems: BillingLineItem[] = [...patient.billingItems];

  switch (fixAction.type) {
    case 'remove_item': {
      if (fixAction.targetItemId) {
        updatedBillingItems = updatedBillingItems.filter(
          (item) => item.id !== fixAction.targetItemId
        );
      }
      break;
    }

    case 'confirm_suspected': {
      if (fixAction.diagnosisId) {
        updatedDiagnoses = updatedDiagnoses.map((diag) => {
          if (diag.id !== fixAction.diagnosisId) return diag;
          return {
            ...diag,
            isSuspected: false,
          };
        });
      }
      break;
    }
  }

  const nextPatient: PatientRecord = {
    ...patient,
    diagnoses: updatedDiagnoses,
    billingItems: updatedBillingItems,
  };

  const remainingFindings = runMhlwReceiptCheck(nextPatient, currentDate);
  const hasErrorOrWarning = remainingFindings.some(
    (f) => f.severity === 'error' || f.severity === 'warning'
  );

  nextPatient.auditStatus = hasErrorOrWarning ? '要確認' : '点検済・適正';
  return nextPatient;
}

/**
 * 請求画面の操作確認用CSVを生成する
 * レコード識別: IR(医療機関情報), RE(レセプト共通), HO(保険者), SY(傷病名), SI(診療行為), IY(医薬品), CO(コメント), GO(総括)
 */
export function generateDemoClaimCsv(
  patients: (PatientRecord & { calculation?: ReceiptCalculationResult; linePoints?: Record<string, number> })[],
  facility: Pick<typeof CLINIC_FACILITY_INFO, 'facilityCode' | 'facilityName' | 'prefectureCode' | 'phone'> = CLINIC_FACILITY_INFO,
  billingYearMonth = DEMO_MONTH,
): string {
  const lines: string[] = ['DEMO,架空データ専用・請求提出不可'];
  const csvCell = (value: string) => {
    // 表計算ソフトに取り込んだ場合も入力値を式として扱わせない。
    const text = /^\s*[=+\-@＝＋－＠]|^[\t\r\n]/.test(value) ? `'${value}` : value;
    return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };

  // IR: 医療機関情報レコード
  lines.push(
    [
      'IR',
      '1', // 審査支払機関 (1:社保/国保共通出力プレビュー)
      facility.prefectureCode,
      '1', // 点数表 (1:医科)
      facility.facilityCode.slice(3),
      '',
      facility.facilityName,
      billingYearMonth,
      '00',
      facility.phone,
    ].map(csvCell).join(',')
  );

  let totalAllPoints = 0;

  patients.forEach((pt, idx) => {
    const calc = pt.calculation ?? calculateReceiptPointsAndCopay(pt);
    totalAllPoints += calc.totalPoints;
    const receiptNo = String(idx + 1).padStart(4, '0');
    const sexCode = pt.sex === '男' ? '1' : '2';
    const birthCompact = pt.birthDate.replace(/-/g, '');

    // RE: レセプト共通レコード
    lines.push(
      [
        'RE',
        receiptNo,
        pt.insuranceCategory === '後期高齢者' ? '1312' : pt.insuranceCategory === '国保' ? '1112' : '1112',
        billingYearMonth,
        pt.name,
        sexCode,
        birthCompact,
        String(Math.round(pt.copayRatio * 100)),
        '',
        pt.chartNumber,
        pt.kana,
      ].map(csvCell).join(',')
    );

    // HO: 保険者レコード
    lines.push(
      [
        'HO',
        pt.insurerNumber.padStart(8, '0'),
        pt.symbolNumber.split('-')[0] || '',
        pt.symbolNumber.split('-')[1] || '',
        String(pt.visitCountThisMonth),
        String(calc.totalPoints),
        '',
        String(calc.copayRoundedYen),
      ].map(csvCell).join(',')
    );

    // SY: 傷病名レコード
    pt.diagnoses.forEach((diag) => {
      const outcomeCode =
        diag.outcome === '継続' ? '1' : diag.outcome === '治癒' ? '2' : diag.outcome === '中止' ? '4' : '1';
      lines.push(
        [
          'SY',
          diag.diseaseCode,
          diag.startDate.replace(/-/g, ''),
          outcomeCode,
          diag.isSuspected ? '8002' : '', // 8002: の疑い
          diag.diseaseName,
          diag.isMain ? '01' : '',
        ].map(csvCell).join(',')
      );
    });

    // SI / IY / CO: 診療行為・医薬品・コメントレコード
    pt.billingItems.forEach((item) => {
      const recType = item.itemType === 'drug' ? 'IY' : 'SI';
      lines.push(
        [
          recType,
          item.category,
          '1', // 負担区分
          item.code,
          String(item.quantity),
          String(pt.linePoints?.[item.id] ?? calculateLineItemPoints(item)),
          String(item.days),
          item.name,
        ].map(csvCell).join(',')
      );

      if (item.commentCode || item.commentText) {
        lines.push(
          [
            'CO',
            item.category,
            '1',
            item.commentCode || '830100001',
            item.commentText || '',
          ].map(csvCell).join(',')
        );
      }
    });
  });

  // GO: 診療報酬請求書（総括）レコード
  lines.push(
    [
      'GO',
      String(patients.length),
      String(totalAllPoints),
      '99',
    ].map(csvCell).join(',')
  );

  return lines.join('\n');
}
