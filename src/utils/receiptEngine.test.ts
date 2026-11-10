import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAutoFixToPatient,
  calculateLineItemPoints,
  calculateReceiptPointsAndCopay,
  generateDemoClaimCsv,
  roundCopayToTenYen,
  runMhlwReceiptCheck,
} from './receiptEngine';
import { INITIAL_PATIENTS } from '../data/mhlwMaster';

test('roundCopayToTenYen rounds to the nearest ten yen', () => {
  assert.equal(roundCopayToTenYen(1234), 1230);
  assert.equal(roundCopayToTenYen(1235), 1240);
  assert.equal(roundCopayToTenYen(2250), 2250);
  assert.equal(roundCopayToTenYen(0), 0);
});

test('calculateReceiptPointsAndCopay computes accurate category totals, gross yen, and rounded copay', () => {
  const pt1 = INITIAL_PATIENTS[0]; // 高橋 誠一 (3割負担)
  // 75 + 225 + 49 + 60 + (2*1*28=56) + (3*1*28=84) = 549 points
  const result = calculateReceiptPointsAndCopay(pt1);
  assert.equal(result.totalPoints, 549);
  assert.equal(result.grossAmountYen, 5490);
  // 5490 * 0.3 = 1647 -> rounded to 1650 yen
  assert.equal(result.copayRoundedYen, 1650);
  assert.equal(result.insuranceClaimYen, 5490 - 1650);
  assert.equal(result.categoryBreakdown['11'].points, 75);
  assert.equal(result.categoryBreakdown['13'].points, 225);
  assert.equal(result.categoryBreakdown['21'].points, 60 + 56 + 84);
  assert.equal(result.categoryBreakdown['60'].points, 49);
});

test('runMhlwReceiptCheck detects R06 revision error (特定疾患療養管理料 on hypertension/dyslipidemia) and missing HbA1c indication', () => {
  const pt1 = INITIAL_PATIENTS[0];
  const findings = runMhlwReceiptCheck(pt1, '2026-11-10');
  const ruleCodes = findings.map((f) => f.ruleCode);

  // Should flag R06-001 (特定疾患療養管理料 on lifestyle diseases)
  assert.ok(ruleCodes.includes('R06-001'), 'Expected R06-001 for 特定疾患療養管理料');
  // Should flag IND-001 (HbA1c without diabetes diagnosis)
  assert.ok(ruleCodes.includes('IND-001'), 'Expected IND-001 for HbA1c missing 2型糖尿病');
});

test('runMhlwReceiptCheck detects concomitant billing error (外来管理加算 + 処置) and drug contraindication (ロキソプロフェン + 胃潰瘍)', () => {
  const pt2 = INITIAL_PATIENTS[1]; // 山本 美咲
  const findings = runMhlwReceiptCheck(pt2, '2026-11-10');
  const ruleCodes = findings.map((f) => f.ruleCode);

  assert.ok(ruleCodes.includes('CON-001'), 'Expected CON-001 for 外来管理加算 + ネブライザ');
  assert.ok(ruleCodes.includes('DRG-001'), 'Expected DRG-001 for ロキソプロフェン × 胃潰瘍');
});

test('applyAutoFixToPatient resolves R06-001 and IND-001 findings cleanly', () => {
  let pt1 = INITIAL_PATIENTS[0];
  let findings = runMhlwReceiptCheck(pt1, '2026-11-10');

  // Fix R06-001 by switching to 生活習慣病管理料(II)
  const r06Finding = findings.find((f) => f.ruleCode === 'R06-001');
  assert.ok(r06Finding?.fixAction);
  pt1 = applyAutoFixToPatient(pt1, r06Finding.fixAction, '2026-11-10');

  // Fix IND-001 by adding 2型糖尿病
  findings = runMhlwReceiptCheck(pt1, '2026-11-10');
  const indFinding = findings.find((f) => f.ruleCode === 'IND-001');
  assert.ok(indFinding?.fixAction);
  pt1 = applyAutoFixToPatient(pt1, indFinding.fixAction, '2026-11-10');

  // Verify no errors or warnings remain
  const finalFindings = runMhlwReceiptCheck(pt1, '2026-11-10');
  const remainingErrorsOrWarnings = finalFindings.filter(
    (f) => f.severity === 'error' || f.severity === 'warning'
  );
  assert.equal(remainingErrorsOrWarnings.length, 0);
  assert.equal(pt1.auditStatus, '点検済・適正');
});

test('generateDemoClaimCsv marks demo data and includes IR, RE, HO, SY, SI, IY, GO records', () => {
  const uke = generateDemoClaimCsv(INITIAL_PATIENTS.slice(0, 2));
  const lines = uke.split('\n');
  assert.ok(lines[0].startsWith('DEMO,'));
  assert.ok(lines[1].startsWith('IR,1,13,1,'));
  assert.ok(lines.some((l) => l.startsWith('RE,0001,')));
  assert.ok(lines.some((l) => l.startsWith('HO,')));
  assert.ok(lines.some((l) => l.startsWith('SY,8833421,')));
  assert.ok(lines.some((l) => l.startsWith('SI,11,')));
  assert.ok(lines.some((l) => l.startsWith('IY,21,')));
  assert.ok(lines[lines.length - 1].startsWith('GO,2,'));
});

test('calculateLineItemPoints computes points * quantity * days', () => {
  const pts = calculateLineItemPoints({
    id: 'test-item',
    code: '622415601',
    name: 'アムロジピンOD錠5mg',
    category: '21',
    categoryName: '投薬',
    itemType: 'drug',
    points: 2,
    quantity: 1,
    days: 28,
    unit: '錠',
    date: '2026-11-10',
  });
  assert.equal(pts, 56);
});

test('generateDemoClaimCsv escapes user-entered separators and spreadsheet expressions', () => {
  const patient = { ...INITIAL_PATIENTS[0], name: '架空, "テスト"', kana: '=1+1' };
  const row = generateDemoClaimCsv([patient]).split('\n').find((line) => line.startsWith('RE,'));
  assert.ok(row?.includes('"架空, ""テスト"""'));
  assert.ok(row?.endsWith(",'=1+1"));
});
