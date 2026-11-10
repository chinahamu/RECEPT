import React, { useState, useMemo } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Sparkles,
  Wrench,
  CheckCheck,
} from 'lucide-react';
import type { AuditFinding } from '../types/receipt';
import type { PatientView } from '../types/workspace';
import { CLINIC_FACILITY_INFO, DEMO_MONTH } from '../data/mhlwMaster';

interface BatchAuditConsoleProps {
  patients: PatientView[];
  onApplyAutoFix: (patientId: string, findingId: string) => void;
  onBatchAutoFixAll: () => void;
  onOpenClaimCsv: () => void;
  onNavigateToWorkstation: (patientId: string) => void;
}

export const BatchAuditConsole: React.FC<BatchAuditConsoleProps> = ({
  patients,
  onApplyAutoFix,
  onBatchAutoFixAll,
  onOpenClaimCsv,
  onNavigateToWorkstation,
}) => {
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ERROR' | 'WARNING' | 'OPPORTUNITY' | 'CLEAN'>('ALL');
  const [selectedPatientId, setSelectedPatientId] = useState<string>(patients[0]?.id || '');

  const patientAudits = useMemo(() => {
    return patients.map((pt) => {
      const calc = pt.calculation;
      const findings = pt.findings;
      const errors = findings.filter((f) => f.severity === 'error');
      const warnings = findings.filter((f) => f.severity === 'warning');
      const opportunities = findings.filter((f) => f.severity === 'opportunity');
      const riskPoints = [...errors, ...warnings].reduce((acc, f) => acc + f.impactPoints, 0);
      return {
        patient: pt,
        calc,
        findings,
        errors,
        warnings,
        opportunities,
        riskPoints,
      };
    });
  }, [patients]);

  const summaryStats = useMemo(() => {
    let totalPoints = 0;
    let totalErrors = 0;
    let totalWarnings = 0;
    let totalRiskPoints = 0;
    let totalOpportunityPoints = 0;

    for (const pa of patientAudits) {
      totalPoints += pa.calc.totalPoints;
      totalErrors += pa.errors.length;
      totalWarnings += pa.warnings.length;
      totalRiskPoints += pa.riskPoints;
      totalOpportunityPoints += pa.opportunities.reduce((s, o) => s + o.impactPoints, 0);
    }

    return {
      totalReceipts: patients.length,
      totalPoints,
      totalErrors,
      totalWarnings,
      totalRiskPoints,
      totalOpportunityPoints,
    };
  }, [patientAudits, patients.length]);

  const filteredAudits = useMemo(() => {
    return patientAudits.filter((pa) => {
      if (statusFilter === 'ERROR') return pa.errors.length > 0;
      if (statusFilter === 'WARNING') return pa.warnings.length > 0;
      if (statusFilter === 'OPPORTUNITY') return pa.opportunities.length > 0;
      if (statusFilter === 'CLEAN') return pa.errors.length === 0 && pa.warnings.length === 0;
      return true;
    });
  }, [patientAudits, statusFilter]);

  const activeAudit = useMemo(() => {
    return (
      patientAudits.find((pa) => pa.patient.id === selectedPatientId) ||
      filteredAudits[0] ||
      patientAudits[0]
    );
  }, [patientAudits, filteredAudits, selectedPatientId]);

  return (
    <div className="flex flex-col gap-5">
      {/* Top KPI Strip (Full-Width 5-column Grid) */}
      <section
        aria-label="当月レセプト総括集計"
        className="grid grid-cols-2 md:grid-cols-5 gap-3"
      >
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">当月請求レセプト総件数</div>
          <div className="text-xl font-bold font-mono tabular-nums text-slate-900 mt-1">
            {summaryStats.totalReceipts} <span className="text-xs font-normal">件</span>
          </div>
          <div className="text-xs text-slate-500 mt-1">
            社保 {patients.filter((p) => p.insuranceCategory === '社保').length} · 国保{' '}
            {patients.filter((p) => p.insuranceCategory === '国保').length} · 後期{' '}
            {patients.filter((p) => p.insuranceCategory === '後期高齢者').length}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">当月総請求点数 / 医療費総額</div>
          <div className="text-xl font-bold font-mono tabular-nums text-slate-900 mt-1">
            {summaryStats.totalPoints.toLocaleString()} <span className="text-xs font-normal">点</span>
          </div>
          <div className="text-xs text-slate-500 font-mono tabular-nums mt-1">
            総額 ¥{(summaryStats.totalPoints * 10).toLocaleString()}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">要修正エラー（返戻・査定対象）</div>
          <div
            data-testid="batch-error-count"
            className={`text-xl font-bold font-mono tabular-nums mt-1 ${
              summaryStats.totalErrors > 0 ? 'text-rose-600' : 'text-emerald-700'
            }`}
          >
            {summaryStats.totalErrors} <span className="text-xs font-normal">件</span>
          </div>
          <div className="text-xs text-slate-500 mt-1">
            令和6年改定・適応病名・禁忌チェック
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">算定警告（縦覧・別表Iコメント）</div>
          <div
            className={`text-xl font-bold font-mono tabular-nums mt-1 ${
              summaryStats.totalWarnings > 0 ? 'text-amber-600' : 'text-emerald-700'
            }`}
          >
            {summaryStats.totalWarnings} <span className="text-xs font-normal">件</span>
          </div>
          <div className="text-xs text-slate-500 mt-1">
            長期疑い傷病名・選択式コメント漏れ
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">査定リスク推計額 / 算定漏れ候補</div>
          <div className="text-xl font-bold font-mono tabular-nums text-slate-900 mt-1">
            ¥{(summaryStats.totalRiskPoints * 10).toLocaleString()}
          </div>
          <div className="text-xs text-sky-700 font-mono tabular-nums mt-1">
            増点候補 +{summaryStats.totalOpportunityPoints}点 (¥{(summaryStats.totalOpportunityPoints * 10).toLocaleString()})
          </div>
        </div>
      </section>

      {/* Toolbar: Segmented Filter & Batch Actions */}
      <div className="bg-white border border-slate-200 rounded-lg p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 bg-slate-100 p-1 rounded-md">
          {[
            { id: 'ALL', label: `全レセプト (${patientAudits.length})` },
            {
              id: 'ERROR',
              label: `要修正エラー (${patientAudits.filter((p) => p.errors.length > 0).length})`,
            },
            {
              id: 'WARNING',
              label: `算定警告・縦覧 (${patientAudits.filter((p) => p.warnings.length > 0).length})`,
            },
            {
              id: 'OPPORTUNITY',
              label: `算定漏れ候補 (${patientAudits.filter((p) => p.opportunities.length > 0).length})`,
            },
            {
              id: 'CLEAN',
              label: `点検済・適正 (${
                patientAudits.filter((p) => p.errors.length === 0 && p.warnings.length === 0).length
              })`,
            },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setStatusFilter(tab.id as typeof statusFilter)}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                statusFilter === tab.id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {(summaryStats.totalErrors > 0 || summaryStats.totalWarnings > 0) && (
            <button
              type="button"
              onClick={onBatchAutoFixAll}
              className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-md transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <CheckCheck className="w-4 h-4" />
              <span>全件のエラー・警告を一括自動補正</span>
            </button>
          )}
          <button
            type="button"
            onClick={onOpenClaimCsv}
            className="px-3.5 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-900 text-xs font-semibold rounded-md transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <FileSpreadsheet className="w-4 h-4" />
            <span>デモ請求CSVプレビュー</span>
          </button>
        </div>
      </div>

      {/* Master-Detail Split: Left Audit Table (5 cols) + Right Paper Receipt Preview & Findings (7 cols) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="p-3.5 border-b border-slate-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">
              月次レセプト自動点検一覧
            </h2>
            <span className="text-xs text-slate-500 font-mono tabular-nums">
              表示 {filteredAudits.length}件
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <th className="py-2.5 px-3 font-medium">患者氏名 / 保険</th>
                  <th className="py-2.5 px-2 text-right font-medium">総点数</th>
                  <th className="py-2.5 px-2.5 font-medium">点検ステータス</th>
                  <th className="py-2.5 px-2.5 text-right font-medium">リスク点数</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredAudits.map((pa) => {
                  const isSelected = activeAudit?.patient.id === pa.patient.id;
                  return (
                    <tr
                      key={pa.patient.id}
                      onClick={() => setSelectedPatientId(pa.patient.id)}
                      className={`cursor-pointer transition-colors ${
                        isSelected ? 'bg-slate-900 text-white' : 'hover:bg-slate-50 text-slate-900'
                      }`}
                    >
                      <td className="py-2.5 px-3">
                        <div className="font-semibold">{pa.patient.name}</div>
                        <div
                          className={`text-[11px] font-mono tabular-nums ${
                            isSelected ? 'text-slate-300' : 'text-slate-500'
                          }`}
                        >
                          {pa.patient.chartNumber} · {pa.patient.insuranceCategory} ({Math.round(pa.patient.copayRatio * 10)}割)
                        </div>
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono tabular-nums font-medium">
                        {pa.calc.totalPoints.toLocaleString()}点
                      </td>
                      <td className="py-2.5 px-2.5">
                        {pa.errors.length > 0 ? (
                          <span
                            className={`inline-flex items-center gap-1 font-medium ${
                              isSelected ? 'text-rose-300' : 'text-rose-600'
                            }`}
                          >
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            <span>エラー {pa.errors.length}件</span>
                          </span>
                        ) : pa.warnings.length > 0 ? (
                          <span
                            className={`inline-flex items-center gap-1 font-medium ${
                              isSelected ? 'text-amber-300' : 'text-amber-600'
                            }`}
                          >
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            <span>警告 {pa.warnings.length}件</span>
                          </span>
                        ) : (
                          <span
                            className={`inline-flex items-center gap-1 font-medium ${
                              isSelected ? 'text-emerald-300' : 'text-emerald-700'
                            }`}
                          >
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                            <span>適正</span>
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-2.5 text-right font-mono tabular-nums">
                        {pa.riskPoints > 0 ? `${pa.riskPoints}点` : '0点'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Detail: Official MHLW Receipt Paper Preview & Audit Findings */}
        {activeAudit && (
          <div className="lg:col-span-7 flex flex-col gap-4">
            {/* Audit Findings Action Box */}
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="flex items-center justify-between border-b border-slate-200 pb-3 mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    {activeAudit.patient.name} 様のレセプト自動点検結果（{activeAudit.findings.length}件）
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    前月請求点数: <span className="font-mono tabular-nums">{activeAudit.patient.previousMonthTotalPoints}点</span> · 当月請求点数: <span className="font-mono tabular-nums">{activeAudit.calc.totalPoints}点</span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigateToWorkstation(activeAudit.patient.id)}
                  className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-md hover:bg-slate-50 text-slate-800 whitespace-nowrap shrink-0"
                >
                  診療入力画面で開く
                </button>
              </div>

              {activeAudit.findings.length === 0 ? (
                <div className="p-3 bg-emerald-50/70 border border-emerald-200 rounded-md flex items-center gap-2 text-xs text-emerald-900">
                  <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                  <span>
                    収録済みのデモ点検ルールで指摘事項はありません。
                  </span>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {activeAudit.findings.map((finding: AuditFinding) => (
                    <div
                      key={finding.id}
                      className={`p-3 rounded-md border text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                        finding.severity === 'error'
                          ? 'bg-rose-50/60 border-rose-200'
                          : finding.severity === 'warning'
                          ? 'bg-amber-50/60 border-amber-200'
                          : 'bg-sky-50/60 border-sky-200'
                      }`}
                    >
                      <div className="space-y-1">
                        <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                          {finding.severity === 'opportunity' ? (
                            <Sparkles className="w-3.5 h-3.5 text-sky-700 shrink-0" />
                          ) : (
                            <AlertTriangle
                              className={`w-3.5 h-3.5 shrink-0 ${
                                finding.severity === 'error' ? 'text-rose-600' : 'text-amber-600'
                              }`}
                            />
                          )}
                          <span>
                            [{finding.ruleCode}] {finding.title}
                          </span>
                        </div>
                        <p className="text-slate-700 leading-relaxed">{finding.description}</p>
                        <div className="text-[11px] text-slate-500">
                          根拠: {finding.mhlwReference} · 影響点数: <span className="font-mono tabular-nums font-medium">{finding.impactPoints}点</span>
                        </div>
                      </div>

                      {finding.fixAction && (
                        <button
                          type="button"
                          onClick={() =>
                            onApplyAutoFix(activeAudit.patient.id, finding.id)
                          }
                          className="px-3 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium rounded-md transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                        >
                          <Wrench className="w-3.5 h-3.5" />
                          <span>{finding.fixAction.label}</span>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Official Japanese Medical Receipt Form Preview (医科診療報酬明細書 様式第二) */}
            <div className="bg-white border border-slate-300 rounded-lg p-5">
              <div className="flex items-center justify-between border-b-2 border-slate-900 pb-2 mb-3">
                <div>
                  <div className="text-[11px] text-slate-500">
                    診療報酬明細書のデモプレビュー
                  </div>
                  <h3 className="text-base font-bold text-slate-900 tracking-wide">
                    診療報酬明細書（医科・入院外）
                  </h3>
                </div>
                <div className="text-right text-xs font-mono tabular-nums text-slate-700">
                  <div>{DEMO_MONTH} · 都道府県番号 {CLINIC_FACILITY_INFO.prefectureCode}</div>
                  <div>医療機関コード: {CLINIC_FACILITY_INFO.facilityCode}</div>
                </div>
              </div>

              {/* Insurance & Patient Header Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs border border-slate-300 p-2.5 bg-slate-50/50 mb-3">
                <div>
                  <span className="text-[11px] text-slate-500 block">保険種別・負担区分</span>
                  <span className="font-semibold text-slate-900">
                    {activeAudit.patient.insuranceCategory}（外来・{Math.round(activeAudit.patient.copayRatio * 10)}割）
                  </span>
                </div>
                <div>
                  <span className="text-[11px] text-slate-500 block">保険者番号 (8桁)</span>
                  <span className="font-mono tabular-nums font-semibold text-slate-900">
                    {activeAudit.patient.insurerNumber}
                  </span>
                </div>
                <div>
                  <span className="text-[11px] text-slate-500 block">被保険者証・記号番号</span>
                  <span className="font-mono tabular-nums font-semibold text-slate-900">
                    {activeAudit.patient.symbolNumber}
                  </span>
                </div>
                <div>
                  <span className="text-[11px] text-slate-500 block">氏名・生年月日・実日数</span>
                  <span className="font-semibold text-slate-900">
                    {activeAudit.patient.name} ({activeAudit.patient.sex}) · 実日数 {activeAudit.patient.visitCountThisMonth}日
                  </span>
                </div>
              </div>

              {/* Diagnosis Box (傷病名欄) */}
              <div className="mb-3">
                <div className="text-xs font-semibold text-slate-800 mb-1">
                  【傷病名部位欄】
                </div>
                <table className="w-full text-xs border border-slate-300 border-collapse">
                  <thead>
                    <tr className="bg-slate-100 border-b border-slate-300 text-slate-700">
                      <th className="py-1.5 px-2 text-left">傷病名</th>
                      <th className="py-1.5 px-2 text-left font-mono">電算傷病名コード</th>
                      <th className="py-1.5 px-2 text-left">診療開始日</th>
                      <th className="py-1.5 px-2 text-left">転帰</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {activeAudit.patient.diagnoses.map((d, i) => (
                      <tr key={d.id}>
                        <td className="py-1.5 px-2 font-medium text-slate-900">
                          ({i + 1}) {d.diseaseName}
                          {d.isSuspected ? 'の疑い' : ''}
                          {d.isMain ? ' [主]' : ''}
                        </td>
                        <td className="py-1.5 px-2 font-mono tabular-nums text-slate-700">
                          {d.diseaseCode} ({d.icd10})
                        </td>
                        <td className="py-1.5 px-2 font-mono tabular-nums text-slate-700">
                          {d.startDate}
                        </td>
                        <td className="py-1.5 px-2 text-slate-700">{d.outcome}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Detail & Summary Box (診療行為摘要欄) */}
              <div>
                <div className="text-xs font-semibold text-slate-800 mb-1">
                  【摘要欄（診療行為・医薬品・特定器材・別表Iコメント）】
                </div>
                <table className="w-full text-xs border border-slate-300 border-collapse">
                  <thead>
                    <tr className="bg-slate-100 border-b border-slate-300 text-slate-700">
                      <th className="py-1.5 px-2 text-left">区分</th>
                      <th className="py-1.5 px-2 text-left font-mono">電算コード</th>
                      <th className="py-1.5 px-2 text-left">名称および選択式コメント</th>
                      <th className="py-1.5 px-2 text-right">点数×回数</th>
                      <th className="py-1.5 px-2 text-right">小計点</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {activeAudit.patient.billingItems.map((item) => (
                      <tr key={item.id}>
                        <td className="py-1.5 px-2 font-mono tabular-nums text-slate-700">
                          *{item.category}
                        </td>
                        <td className="py-1.5 px-2 font-mono tabular-nums text-slate-600">
                          {item.code}
                        </td>
                        <td className="py-1.5 px-2 text-slate-900">
                          <div>{item.name}</div>
                          {item.commentText && (
                            <div className="text-[11px] text-slate-600 font-mono">
                              [CO:{item.commentCode}] {item.commentText}
                            </div>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono tabular-nums text-slate-700">
                          {item.points} × {item.quantity * item.days}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono tabular-nums font-semibold text-slate-900">
                          {activeAudit.patient.linePoints[item.id]}点
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-100 border-t-2 border-slate-400 font-semibold text-slate-900">
                      <td colSpan={3} className="py-2 px-2">
                        合計点数 / 窓口一部負担金額（端数処理後）
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums">
                        総計 {activeAudit.calc.totalPoints.toLocaleString()}点
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums">
                        負担金 ¥{activeAudit.calc.copayRoundedYen.toLocaleString()}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
