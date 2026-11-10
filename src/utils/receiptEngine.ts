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
  MHLW_DISEASE_MASTER,
  MHLW_PROCEDURE_MASTER,
} from '../data/mhlwMaster';

const CATEGORY_LABELS: Record<typeBillingCategoryCode, string> = {
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
  const activeDiseaseCodes = new Set(activeDiagnoses.map((d) => d.diseaseCode));
  const billingCodes = new Set(patient.billingItems.map((b) => b.code));

  // Rule 1: 令和6年6月診療報酬改定 特定疾患療養管理料（113001810）の対象疾患除外チェック
  const tokuteiItem = patient.billingItems.find((b) => b.code === '113001810');
  if (tokuteiItem) {
    const hasValidTokuteiDisease = activeDiagnoses.some((d) => {
      const master = MHLW_DISEASE_MASTER.find((m) => m.code === d.diseaseCode);
      return master?.isTargetOfTokuteiShikkan === true;
    });
    const hasLifestyleDisease = activeDiagnoses.some((d) => {
      const master = MHLW_DISEASE_MASTER.find((m) => m.code === d.diseaseCode);
      return master?.isTargetOfSeikatsuShukan === true;
    });

    if (!hasValidTokuteiDisease && hasLifestyleDisease) {
      findings.push({
        id: `chk-r06-tokutei-${patient.id}`,
        ruleCode: 'R06-001',
        severity: 'error',
        category: '令和6年改定・算定要件',
        title: '特定疾患療養管理料の対象外傷病名（令和6年6月改定）',
        description:
          '高血圧症・脂質異常症・糖尿病は令和6年6月診療報酬改定により「特定疾患療養管理料（225点）」の対象から除外されました。対象特定疾患（気管支喘息・慢性心不全・慢性胃炎等）の登録がないため返戻・査定対象となります。「生活習慣病管理料(II)（333点）」への算定切替を推奨します。',
        mhlwReference: '保医発0305第4号 別表1 特定疾患療養管理料・生活習慣病管理料(II)算定留意事項',
        impactPoints: 225,
        relatedItemId: tokuteiItem.id,
        fixAction: {
          type: 'replace_item',
          label: '生活習慣病管理料(II)（333点）へ切替',
          targetItemId: tokuteiItem.id,
          replacementCode: '113046410',
          commentCode: '830100802',
          commentText: '療養計画書交付・患者署名同意済（生活習慣指導実施）',
        },
      });
    } else if (!hasValidTokuteiDisease) {
      findings.push({
        id: `chk-r06-tokutei-none-${patient.id}`,
        ruleCode: 'R06-002',
        severity: 'error',
        category: '令和6年改定・算定要件',
        title: '特定疾患療養管理料の対象傷病名未登録',
        description:
          '特定疾患療養管理料（225点）が算定されていますが、厚生労働大臣が定める対象特定疾患が傷病名欄に登録されていません。',
        mhlwReference: '医科診療報酬点数表 B000 特定疾患療養管理料',
        impactPoints: 225,
        relatedItemId: tokuteiItem.id,
        fixAction: {
          type: 'remove_item',
          label: '特定疾患療養管理料を算定から削除',
          targetItemId: tokuteiItem.id,
        },
      });
    }
  }

  // Rule 2: 外来管理加算（112011310）と処置（区分40）または生活習慣病管理料の併算定不可チェック
  const gairaiKanriItem = patient.billingItems.find((b) => b.code === '112011310');
  if (gairaiKanriItem) {
    const procedure40Item = patient.billingItems.find((b) => b.category === '40');
    const seikatsuItem = patient.billingItems.find((b) => b.code === '113046410');
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
        impactPoints: 52,
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
        impactPoints: 52,
        relatedItemId: gairaiKanriItem.id,
        fixAction: {
          type: 'remove_item',
          label: '外来管理加算（52点）を削除',
          targetItemId: gairaiKanriItem.id,
        },
      });
    }
  }

  // Rule 3: 初診料と再診料の同日重複チェック
  if (billingCodes.has('111000110') && billingCodes.has('112007410')) {
    const saishin = patient.billingItems.find((b) => b.code === '112007410');
    findings.push({
      id: `chk-con-shoshin-saishin-${patient.id}`,
      ruleCode: 'CON-003',
      severity: 'error',
      category: '併算定・回数制限',
      title: '初診料と再診料の同日重複算定',
      description: '同一受診日において初診料（291点）と再診料（75点）が重複して算定されています。',
      mhlwReference: '医科点数表 A000 初診料・A001 再診料',
      impactPoints: 75,
      relatedItemId: saishin?.id,
      fixAction: saishin
        ? {
            type: 'remove_item',
            label: '重複している再診料（75点）を削除',
            targetItemId: saishin.id,
          }
        : undefined,
    });
  }

  // Rule 4: 各診療行為・医薬品の適応傷病名チェック、禁忌傷病名チェック、必須コメントチェック、月内回数上限チェック
  for (const item of patient.billingItems) {
    const master = MHLW_PROCEDURE_MASTER.find((m) => m.code === item.code);
    if (!master) continue;

    // 4-A: 禁忌傷病名チェック（例：ロキソプロフェンNa錠 × 胃潰瘍）
    if (master.excludedIndications && master.code !== '113001810') {
      const contraindicatedDiag = activeDiagnoses.find((d) =>
        master.excludedIndications!.includes(d.diseaseCode)
      );
      if (contraindicatedDiag) {
        findings.push({
          id: `chk-contra-${item.id}`,
          ruleCode: 'DRG-001',
          severity: 'error',
          category: '適応傷病名不一致',
          title: `禁忌傷病名抵触：「${item.name}」×「${contraindicatedDiag.diseaseName}」`,
          description: `登録傷病名に「${contraindicatedDiag.diseaseName}（継続）」が存在するため、「${item.name}」は消化性潰瘍禁忌として審査支払機関で査定対象となります。`,
          mhlwReference: '医療用医薬品添付文書 禁忌項目・支払基金医薬品審査情報',
          impactPoints: calculateLineItemPoints(item),
          relatedItemId: item.id,
          relatedDiagnosisId: contraindicatedDiag.id,
          fixAction: {
            type: 'remove_item',
            label: `禁忌薬「${item.name}」を処方から削除`,
            targetItemId: item.id,
          },
        });
      }
    }

    // 4-B: 適応傷病名漏れチェック
    if (master.requiredIndications && master.requiredIndications.length > 0 && master.code !== '113001810') {
      const hasIndication = master.requiredIndications.some((reqCode) =>
        activeDiseaseCodes.has(reqCode)
      );
      if (!hasIndication) {
        const primaryCandidateCode = master.requiredIndications[0];
        const candidateDisease = MHLW_DISEASE_MASTER.find((d) => d.code === primaryCandidateCode);
        const candidateName = candidateDisease ? candidateDisease.name : primaryCandidateCode;

        findings.push({
          id: `chk-ind-${item.id}`,
          ruleCode: 'IND-001',
          severity: 'error',
          category: '適応傷病名不一致',
          title: `適応傷病名漏れ：「${item.name}」に対する傷病名未登録`,
          description: `「${item.name}（${calculateLineItemPoints(item)}点）」が算定されていますが、適応となる傷病名（例：${candidateName}）が傷病名欄に登録されていません。`,
          mhlwReference: '厚生労働省 電算処理レセプト傷病名・診療行為適応突合テーブル',
          impactPoints: calculateLineItemPoints(item),
          relatedItemId: item.id,
          fixAction: {
            type: 'add_diagnosis',
            label: `適応傷病名「${candidateName}」を傷病名欄に追加`,
            diseaseCodeToAdd: primaryCandidateCode,
          },
        });
      }
    }

    // 4-C: 別表I 選択式コメントコード必須チェック
    if (master.requiresComment && !item.commentText && !item.commentCode) {
      const [defaultCode, defaultText] = (master.defaultCommentTemplate || '830100001: 算定事由記載済').split(': ');
      findings.push({
        id: `chk-cmt-${item.id}`,
        ruleCode: 'CMT-001',
        severity: 'warning',
        category: 'コメント記載漏れ',
        title: `電算レセプト選択式コメント未記載：「${item.name}」`,
        description: `「${item.name}」は診療報酬明細書（レセプト）摘要欄への厚労省別表Iコメントコード記載が義務付けられています。未記載の場合、返戻対象となるリスクがあります。`,
        mhlwReference: '「診療報酬明細書の記載要領」別表I（選択式コメントコード一覧）',
        impactPoints: calculateLineItemPoints(item),
        relatedItemId: item.id,
        fixAction: {
          type: 'add_comment',
          label: `標準コメント（${defaultCode}）を自動付与`,
          targetItemId: item.id,
          commentCode: defaultCode,
          commentText: defaultText || master.defaultCommentTemplate,
        },
      });
    }

    // 4-D: 月内算定回数上限チェック
    if (master.monthlyLimit && item.quantity * item.days > master.monthlyLimit) {
      findings.push({
        id: `chk-lim-${item.id}`,
        ruleCode: 'CON-004',
        severity: 'error',
        category: '併算定・回数制限',
        title: `月内算定回数超過：「${item.name}」（上限 月${master.monthlyLimit}回）`,
        description: `「${item.name}」は月${master.monthlyLimit}回が算定上限ですが、現在${item.quantity * item.days}回分が計上されています。`,
        mhlwReference: '医科診療報酬点数表 月内算定回数制限規定',
        impactPoints: master.points * (item.quantity * item.days - master.monthlyLimit),
        relatedItemId: item.id,
      });
    }
  }

  // Rule 5: 縦覧点検 — 長期継続中の「疑い病名」チェック（開始日から2ヶ月以上経過）
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

  // Rule 6: 算定漏れ提案 — 内服薬処方があるのに処方箋料（120002910）が未算定
  const hasOralDrug = patient.billingItems.some((b) => b.itemType === 'drug');
  const hasPrescriptionFee = billingCodes.has('120002910');
  if (hasOralDrug && !hasPrescriptionFee) {
    findings.push({
      id: `chk-opp-rx-${patient.id}`,
      ruleCode: 'OPP-001',
      severity: 'opportunity',
      category: '算定漏れ提案',
      title: '算定漏れ候補：院外処方薬に対する「処方箋料（60点）」未計上',
      description:
        '投薬区分（21）に内服薬が計上されていますが、「処方箋料（その他）60点」が算定されていません。院外処方の場合は追加算定が可能です。',
      mhlwReference: '医科点数表 F400 処方箋料',
      impactPoints: 60,
      fixAction: {
        type: 'add_item',
        label: '処方箋料（60点）を算定明細に追加',
        itemCodeToAdd: '120002910',
      },
    });
  }

  // Rule 7: 算定漏れ提案 — 再診料算定時に「外来・在宅ベースアップ評価料(I)（2点）」が未算定
  if (billingCodes.has('112007410') && !billingCodes.has('112026770')) {
    findings.push({
      id: `chk-opp-baseup-${patient.id}`,
      ruleCode: 'OPP-002',
      severity: 'opportunity',
      category: '算定漏れ提案',
      title: '算定漏れ候補：「外来・在宅ベースアップ評価料(I)（2点）」未計上',
      description:
        '再診料（75点）算定時、届出済医療機関では令和6年度新設の「外来・在宅ベースアップ評価料(I)（再診時等）2点」を併せて算定可能です。',
      mhlwReference: '医科点数表 O100 外来・在宅ベースアップ評価料(I)',
      impactPoints: 2,
      fixAction: {
        type: 'add_item',
        label: 'ベースアップ評価料(I)（2点）を追加',
        itemCodeToAdd: '112026770',
      },
    });
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
    case 'add_diagnosis': {
      const diseaseMaster = MHLW_DISEASE_MASTER.find(
        (d) => d.code === fixAction.diseaseCodeToAdd
      );
      if (diseaseMaster && !updatedDiagnoses.some((d) => d.diseaseCode === diseaseMaster.code)) {
        updatedDiagnoses.push({
          id: `diag-auto-${Date.now()}-${diseaseMaster.code}`,
          diseaseCode: diseaseMaster.code,
          diseaseName: diseaseMaster.name,
          icd10: diseaseMaster.icd10,
          startDate: currentDate,
          outcome: '継続',
          isMain: updatedDiagnoses.length === 0,
          isSuspected: false,
        });
      }
      break;
    }

    case 'replace_item': {
      const newMaster = MHLW_PROCEDURE_MASTER.find(
        (m) => m.code === fixAction.replacementCode
      );
      if (newMaster && fixAction.targetItemId) {
        updatedBillingItems = updatedBillingItems.map((item) => {
          if (item.id !== fixAction.targetItemId) return item;
          return {
            ...item,
            code: newMaster.code,
            name: newMaster.name,
            category: newMaster.category,
            categoryName: newMaster.categoryName,
            itemType: newMaster.itemType,
            points: newMaster.points,
            unit: newMaster.unit,
            commentCode: fixAction.commentCode,
            commentText: fixAction.commentText,
          };
        });
      }
      break;
    }

    case 'remove_item': {
      if (fixAction.targetItemId) {
        updatedBillingItems = updatedBillingItems.filter(
          (item) => item.id !== fixAction.targetItemId
        );
      }
      break;
    }

    case 'add_item': {
      const masterToAdd = MHLW_PROCEDURE_MASTER.find(
        (m) => m.code === fixAction.itemCodeToAdd
      );
      if (masterToAdd) {
        updatedBillingItems.push({
          id: `bi-auto-${Date.now()}-${masterToAdd.code}`,
          code: masterToAdd.code,
          name: masterToAdd.name,
          category: masterToAdd.category,
          categoryName: masterToAdd.categoryName,
          itemType: masterToAdd.itemType,
          points: masterToAdd.points,
          quantity: 1,
          days: 1,
          unit: masterToAdd.unit,
          date: currentDate,
        });
      }
      break;
    }

    case 'add_comment': {
      if (fixAction.targetItemId) {
        updatedBillingItems = updatedBillingItems.map((item) => {
          if (item.id !== fixAction.targetItemId) return item;
          return {
            ...item,
            commentCode: fixAction.commentCode || '830100001',
            commentText: fixAction.commentText || '算定要件確認済',
          };
        });
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
export function generateDemoClaimCsv(patients: PatientRecord[]): string {
  const billingYearMonth = DEMO_MONTH;
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
      CLINIC_FACILITY_INFO.prefectureCode,
      '1', // 点数表 (1:医科)
      CLINIC_FACILITY_INFO.facilityCode.slice(3),
      '',
      CLINIC_FACILITY_INFO.facilityName,
      billingYearMonth,
      '00',
      CLINIC_FACILITY_INFO.phone,
    ].map(csvCell).join(',')
  );

  let totalAllPoints = 0;

  patients.forEach((pt, idx) => {
    const calc = calculateReceiptPointsAndCopay(pt);
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
          String(calculateLineItemPoints(item)),
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
