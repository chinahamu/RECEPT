import React, { useState, useMemo } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  Plus,
  Search,
  Sparkles,
  Trash2,
  UserCheck,
  Wrench,
  MessageSquarePlus,
} from 'lucide-react';
import {
  AuditFinding,
  AuditFixAction,
  BillingLineItem,
  PatientDiagnosis,
  PatientRecord,
} from '../types/receipt';
import {
  DEMO_DATE,
  MHLW_DISEASE_MASTER,
  MHLW_PROCEDURE_MASTER,
} from '../data/mhlwMaster';
import {
  calculateLineItemPoints,
  calculateReceiptPointsAndCopay,
  runMhlwReceiptCheck,
} from '../utils/receiptEngine';

interface EncounterWorkstationProps {
  patients: PatientRecord[];
  selectedPatientId: string;
  onSelectPatient: (id: string) => void;
  onUpdatePatient: (updated: PatientRecord, logSummary: string) => boolean;
  onApplyAutoFix: (patientId: string, fixAction: AuditFixAction, findingTitle: string) => void;
  isOfflineMode: boolean;
}

export const EncounterWorkstation: React.FC<EncounterWorkstationProps> = ({
  patients,
  selectedPatientId,
  onSelectPatient,
  onUpdatePatient,
  onApplyAutoFix,
  isOfflineMode,
}) => {
  const [patientQuery, setPatientQuery] = useState('');
  const [procedureQuery, setProcedureQuery] = useState('');
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string>('ALL');
  const [selectedDiseaseCodeToAdd, setSelectedDiseaseCodeToAdd] = useState<string>(
    MHLW_DISEASE_MASTER[0].code
  );
  const [newDiagSuspected, setNewDiagSuspected] = useState(false);
  const [editingCommentItemId, setEditingCommentItemId] = useState<string | null>(null);
  const [commentInputText, setCommentInputText] = useState<string>('');
  const [finalizeBanner, setFinalizeBanner] = useState<string | null>(null);

  const selectedPatient = useMemo(
    () => patients.find((p) => p.id === selectedPatientId) || patients[0],
    [patients, selectedPatientId]
  );

  const filteredPatients = useMemo(() => {
    const q = patientQuery.trim().toLowerCase();
    if (!q) return patients;
    return patients.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.kana.toLowerCase().includes(q) ||
        p.chartNumber.toLowerCase().includes(q)
    );
  }, [patients, patientQuery]);

  const filteredProcedures = useMemo(() => {
    const q = procedureQuery.trim().toLowerCase();
    return MHLW_PROCEDURE_MASTER.filter((m) => {
      const matchesCat =
        selectedCategoryFilter === 'ALL' || m.category === selectedCategoryFilter;
      const matchesQuery =
        !q ||
        m.name.toLowerCase().includes(q) ||
        m.code.includes(q) ||
        m.categoryName.toLowerCase().includes(q);
      return matchesCat && matchesQuery;
    });
  }, [procedureQuery, selectedCategoryFilter]);

  const calculation = useMemo(
    () => calculateReceiptPointsAndCopay(selectedPatient),
    [selectedPatient]
  );

  const auditFindings: AuditFinding[] = useMemo(
    () => runMhlwReceiptCheck(selectedPatient),
    [selectedPatient]
  );

  const errorCount = auditFindings.filter((f) => f.severity === 'error').length;
  const warningCount = auditFindings.filter((f) => f.severity === 'warning').length;

  const handleAddDiagnosis = (e: React.FormEvent) => {
    e.preventDefault();
    const master = MHLW_DISEASE_MASTER.find((d) => d.code === selectedDiseaseCodeToAdd);
    if (!master) return;

    if (selectedPatient.diagnoses.some((d) => d.diseaseCode === master.code && d.outcome === '継続')) {
      return;
    }

    const newDiag: PatientDiagnosis = {
      id: `diag-${Date.now()}`,
      diseaseCode: master.code,
      diseaseName: master.name,
      icd10: master.icd10,
      startDate: DEMO_DATE,
      outcome: '継続',
      isMain: selectedPatient.diagnoses.length === 0,
      isSuspected: newDiagSuspected,
    };

    const nextDiagnoses = [...selectedPatient.diagnoses, newDiag];
    const nextPatient: PatientRecord = {
      ...selectedPatient,
      diagnoses: nextDiagnoses,
    };
    const nextFindings = runMhlwReceiptCheck(nextPatient);
    nextPatient.auditStatus = nextFindings.some((f) => f.severity === 'error' || f.severity === 'warning')
      ? '要確認'
      : '点検済・適正';

    onUpdatePatient(
      nextPatient,
      `傷病名追加: ${master.name}${newDiagSuspected ? '（疑い）' : ''} [${master.code}]`
    );
    setNewDiagSuspected(false);
  };

  const handleToggleDiagnosisOutcome = (diagId: string, nextOutcome: '継続' | '治癒' | '中止') => {
    const nextDiagnoses = selectedPatient.diagnoses.map((d) =>
      d.id === diagId ? { ...d, outcome: nextOutcome } : d
    );
    const nextPatient: PatientRecord = { ...selectedPatient, diagnoses: nextDiagnoses };
    const nextFindings = runMhlwReceiptCheck(nextPatient);
    nextPatient.auditStatus = nextFindings.some((f) => f.severity === 'error' || f.severity === 'warning')
      ? '要確認'
      : '点検済・適正';
    onUpdatePatient(nextPatient, `傷病名転帰変更: ${diagId} -> ${nextOutcome}`);
  };

  const handleRemoveDiagnosis = (diagId: string, diagName: string) => {
    const nextDiagnoses = selectedPatient.diagnoses.filter((d) => d.id !== diagId);
    const nextPatient: PatientRecord = { ...selectedPatient, diagnoses: nextDiagnoses };
    const nextFindings = runMhlwReceiptCheck(nextPatient);
    nextPatient.auditStatus = nextFindings.some((f) => f.severity === 'error' || f.severity === 'warning')
      ? '要確認'
      : '点検済・適正';
    onUpdatePatient(nextPatient, `傷病名削除: ${diagName}`);
  };

  const handleAddBillingItem = (masterCode: string) => {
    const master = MHLW_PROCEDURE_MASTER.find((m) => m.code === masterCode);
    if (!master) return;

    const newItem: BillingLineItem = {
      id: `bi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      code: master.code,
      name: master.name,
      category: master.category,
      categoryName: master.categoryName,
      itemType: master.itemType,
      points: master.points,
      quantity: 1,
      days: master.itemType === 'drug' ? 14 : 1,
      unit: master.unit,
      date: DEMO_DATE,
    };

    const nextItems = [...selectedPatient.billingItems, newItem];
    const nextPatient: PatientRecord = { ...selectedPatient, billingItems: nextItems };
    const nextFindings = runMhlwReceiptCheck(nextPatient);
    nextPatient.auditStatus = nextFindings.some((f) => f.severity === 'error' || f.severity === 'warning')
      ? '要確認'
      : '点検済・適正';

    onUpdatePatient(nextPatient, `算定項目追加: ${master.name} (${master.points}点)`);
  };

  const handleUpdateItemQuantityOrDays = (
    itemId: string,
    field: 'quantity' | 'days',
    value: number
  ) => {
    const safeVal = Math.max(1, Math.min(90, Math.round(value)));
    const nextItems = selectedPatient.billingItems.map((item) =>
      item.id === itemId ? { ...item, [field]: safeVal } : item
    );
    const nextPatient: PatientRecord = { ...selectedPatient, billingItems: nextItems };
    const nextFindings = runMhlwReceiptCheck(nextPatient);
    nextPatient.auditStatus = nextFindings.some((f) => f.severity === 'error' || f.severity === 'warning')
      ? '要確認'
      : '点検済・適正';
    onUpdatePatient(nextPatient, `算定数量・日数変更: ${itemId} (${field}=${safeVal})`);
  };

  const handleRemoveBillingItem = (itemId: string, itemName: string) => {
    const nextItems = selectedPatient.billingItems.filter((item) => item.id !== itemId);
    const nextPatient: PatientRecord = { ...selectedPatient, billingItems: nextItems };
    const nextFindings = runMhlwReceiptCheck(nextPatient);
    nextPatient.auditStatus = nextFindings.some((f) => f.severity === 'error' || f.severity === 'warning')
      ? '要確認'
      : '点検済・適正';
    onUpdatePatient(nextPatient, `算定項目削除: ${itemName}`);
  };

  const handleSaveComment = (itemId: string) => {
    if (!commentInputText.trim()) {
      setEditingCommentItemId(null);
      return;
    }
    const nextItems = selectedPatient.billingItems.map((item) =>
      item.id === itemId
        ? {
            ...item,
            commentCode: item.commentCode || '830100001',
            commentText: commentInputText.trim(),
          }
        : item
    );
    const nextPatient: PatientRecord = { ...selectedPatient, billingItems: nextItems };
    const nextFindings = runMhlwReceiptCheck(nextPatient);
    nextPatient.auditStatus = nextFindings.some((f) => f.severity === 'error' || f.severity === 'warning')
      ? '要確認'
      : '点検済・適正';
    if (!onUpdatePatient(nextPatient, `摘要コメント記載: ${commentInputText.trim()}`)) return;
    setEditingCommentItemId(null);
    setCommentInputText('');
  };

  const handleFinalizeAccounting = () => {
    const nextStatus =
      errorCount === 0 && warningCount === 0 ? '点検済・適正' : '要確認';
    const nextPatient: PatientRecord = {
      ...selectedPatient,
      auditStatus: nextStatus,
    };
    if (!onUpdatePatient(
      nextPatient,
      `デモ会計確定: 総点数 ${calculation.totalPoints}点 / 窓口負担 ${calculation.copayRoundedYen.toLocaleString()}円`
    )) return;
    setFinalizeBanner(
      `${selectedPatient.name} 様の診療会計（総点数 ${calculation.totalPoints.toLocaleString()}点・窓口負担金 ${calculation.copayRoundedYen.toLocaleString()}円）をブラウザに保存しました。`
    );
    setTimeout(() => setFinalizeBanner(null), 5000);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
      {/* Left Column: Patient Queue (3 cols on lg) */}
      <aside
        aria-label="本日来院患者一覧"
        className="lg:col-span-3 bg-white border border-slate-200 rounded-lg p-4 flex flex-col gap-3"
      >
        <div className="flex items-center justify-between border-b border-slate-200 pb-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">本日来院・会計対象患者</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              2026年11月10日 · 全 <span className="font-mono tabular-nums">{patients.length}</span> 名
            </p>
          </div>
          <span className="text-xs text-slate-500 font-mono tabular-nums">
            要確認 {patients.filter((p) => runMhlwReceiptCheck(p).some((f) => f.severity === 'error' || f.severity === 'warning')).length}件
          </span>
        </div>

        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            aria-label="患者氏名・カルテ番号検索"
            value={patientQuery}
            onChange={(e) => setPatientQuery(e.target.value)}
            placeholder="氏名・カナ・PT番号で検索..."
            className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-slate-900"
          />
        </div>

        <div className="divide-y divide-slate-100 max-h-[640px] overflow-y-auto">
          {filteredPatients.map((pt) => {
            const ptFindings = runMhlwReceiptCheck(pt);
            const ptErrors = ptFindings.filter((f) => f.severity === 'error').length;
            const ptWarnings = ptFindings.filter((f) => f.severity === 'warning').length;
            const ptCalc = calculateReceiptPointsAndCopay(pt);
            const isSelected = pt.id === selectedPatient.id;

            return (
              <button
                key={pt.id}
                type="button"
                onClick={() => onSelectPatient(pt.id)}
                className={`w-full text-left p-3 transition-colors flex flex-col gap-1.5 rounded-md ${
                  isSelected
                    ? 'bg-slate-900 text-white'
                    : 'hover:bg-slate-50 text-slate-900'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-sm truncate">{pt.name}</span>
                  <span
                    className={`text-xs font-mono tabular-nums whitespace-nowrap shrink-0 ${
                      isSelected ? 'text-slate-300' : 'text-slate-500'
                    }`}
                  >
                    {pt.chartNumber}
                  </span>
                </div>

                <div
                  className={`flex items-center gap-1.5 text-xs ${
                    isSelected ? 'text-slate-300' : 'text-slate-500'
                  }`}
                >
                  <span>{pt.insuranceCategory}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{Math.round(pt.copayRatio * 10)}割負担</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{ptCalc.totalPoints.toLocaleString()}点</span>
                </div>

                <div className="flex items-center justify-between text-xs pt-0.5">
                  {ptErrors > 0 ? (
                    <span
                      className={`inline-flex items-center gap-1 font-medium ${
                        isSelected ? 'text-rose-300' : 'text-rose-600'
                      }`}
                    >
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      <span>要修正エラー {ptErrors}件</span>
                    </span>
                  ) : ptWarnings > 0 ? (
                    <span
                      className={`inline-flex items-center gap-1 font-medium ${
                        isSelected ? 'text-amber-300' : 'text-amber-600'
                      }`}
                    >
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      <span>算定警告 {ptWarnings}件</span>
                    </span>
                  ) : (
                    <span
                      className={`inline-flex items-center gap-1 font-medium ${
                        isSelected ? 'text-emerald-300' : 'text-emerald-700'
                      }`}
                    >
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      <span>点検済・適正</span>
                    </span>
                  )}
                  <span
                    className={`font-mono tabular-nums ${
                      isSelected ? 'text-slate-200' : 'text-slate-700'
                    }`}
                  >
                    ¥{ptCalc.copayRoundedYen.toLocaleString()}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Center Column: Patient Header, Diagnoses, and Billing Item Input (5 cols on lg) */}
      <section
        aria-label="カルテ傷病名および診療行為算定入力"
        className="lg:col-span-5 flex flex-col gap-4"
      >
        {/* Patient Demographic & Insurance Metadata Bar (Zero-Pill clean unboxed metadata) */}
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 pb-3">
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-lg font-bold text-slate-900">{selectedPatient.name}</h1>
                <span className="text-xs text-slate-500">{selectedPatient.kana}</span>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span className="text-xs font-mono tabular-nums text-slate-600">
                  {selectedPatient.chartNumber}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 mt-1">
                <span>生年月日: <strong className="font-mono tabular-nums font-medium">{selectedPatient.birthDate}</strong></span>
                <span aria-hidden="true">·</span>
                <span>性別: {selectedPatient.sex}</span>
                <span aria-hidden="true">·</span>
                <span>当月来院: <strong className="font-mono tabular-nums font-medium">{selectedPatient.visitCountThisMonth}</strong>回目</span>
              </div>
            </div>

            <div className="text-right">
              <div className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700">
                <UserCheck className="w-3.5 h-3.5 text-emerald-700" />
                <span>
                  {isOfflineMode
                    ? 'デモ資格情報（オフライン想定）'
                    : selectedPatient.mynaVerified
                    ? 'デモ資格確認フラグあり'
                    : '資格確認フラグなし'}
                </span>
              </div>
              <div className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
                {selectedPatient.insuranceCategory} · 保険者 {selectedPatient.insurerNumber} · 記号番号 {selectedPatient.symbolNumber} · {Math.round(selectedPatient.copayRatio * 10)}割負担
              </div>
            </div>
          </div>

          {finalizeBanner && (
            <div
              role="status"
              className="mt-3 p-2.5 bg-emerald-50 border border-emerald-200 rounded-md text-xs text-emerald-900 flex items-center gap-2"
            >
              <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
              <span>{finalizeBanner}</span>
            </div>
          )}

          {/* Registered Diagnoses Section */}
          <div className="mt-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xs font-semibold text-slate-900">
                登録傷病名（デモ傷病名マスタ 7桁コード）
              </h2>
              <span className="text-xs text-slate-500 font-mono tabular-nums">
                継続傷病 {selectedPatient.diagnoses.filter((d) => d.outcome === '継続').length}件
              </span>
            </div>

            <div className="border border-slate-200 rounded-md overflow-hidden">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <th className="py-2 px-3 font-medium">傷病名 / ICD-10</th>
                    <th className="py-2 px-2 font-medium font-mono">コード</th>
                    <th className="py-2 px-2 font-medium">開始日</th>
                    <th className="py-2 px-2 font-medium">転帰</th>
                    <th className="py-2 px-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {selectedPatient.diagnoses.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-4 px-3 text-center text-slate-500">
                        登録されている傷病名はありません。下のフォームから傷病名を追加してください。
                      </td>
                    </tr>
                  ) : (
                    selectedPatient.diagnoses.map((diag) => (
                      <tr key={diag.id} className="hover:bg-slate-50/80">
                        <td className="py-2 px-3">
                          <div className="font-medium text-slate-900 flex items-center gap-1.5">
                            <span>{diag.diseaseName}</span>
                            {diag.isSuspected && (
                              <span className="text-amber-700 font-normal">（疑い）</span>
                            )}
                            {diag.isMain && (
                              <span className="text-slate-500 font-normal">· 主病</span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                            ICD-10: {diag.icd10}
                          </div>
                        </td>
                        <td className="py-2 px-2 font-mono tabular-nums text-slate-600">
                          {diag.diseaseCode}
                        </td>
                        <td className="py-2 px-2 font-mono tabular-nums text-slate-600">
                          {diag.startDate}
                        </td>
                        <td className="py-2 px-2">
                          <select
                            aria-label={`${diag.diseaseName}の転帰`}
                            value={diag.outcome}
                            onChange={(e) =>
                              handleToggleDiagnosisOutcome(
                                diag.id,
                                e.target.value as '継続' | '治癒' | '中止'
                              )
                            }
                            className="bg-white border border-slate-200 rounded px-1.5 py-1 text-xs text-slate-800 focus:outline-none focus:border-slate-900"
                          >
                            <option value="継続">継続</option>
                            <option value="治癒">治癒</option>
                            <option value="中止">中止</option>
                          </select>
                        </td>
                        <td className="py-2 px-2 text-right">
                          <button
                            type="button"
                            onClick={() => handleRemoveDiagnosis(diag.id, diag.diseaseName)}
                            aria-label={`傷病名「${diag.diseaseName}」を削除`}
                            className="p-1 text-slate-400 hover:text-rose-600 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Quick Add Diagnosis Form */}
            <form onSubmit={handleAddDiagnosis} className="mt-2.5 flex flex-wrap items-center gap-2">
              <select
                aria-label="追加する傷病名を選択"
                value={selectedDiseaseCodeToAdd}
                onChange={(e) => setSelectedDiseaseCodeToAdd(e.target.value)}
                className="flex-1 min-w-[200px] bg-slate-50 border border-slate-200 rounded-md px-2.5 py-1.5 text-xs text-slate-900 focus:outline-none focus:border-slate-900"
              >
                {MHLW_DISEASE_MASTER.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.name} ({d.code} · {d.category})
                  </option>
                ))}
              </select>
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={newDiagSuspected}
                  onChange={(e) => setNewDiagSuspected(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span>疑い病名</span>
              </label>
              <button
                type="submit"
                className="px-3 py-1.5 bg-slate-900 text-white text-xs font-medium rounded-md hover:bg-slate-800 transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>傷病名追加</span>
              </button>
            </form>
          </div>
        </div>

        {/* Medical Billing Line Items Editor */}
        <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                本日の診療行為・処方算定明細
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                数量・処方日数の変更および別表I選択式コメントの付与がリアルタイムに総点数と点検結果へ反映されます
              </p>
            </div>
            <span className="text-xs font-mono tabular-nums text-slate-600 whitespace-nowrap shrink-0">
              計 {selectedPatient.billingItems.length} 項目
            </span>
          </div>

          <div className="border border-slate-200 rounded-md overflow-hidden">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <th className="py-2 px-2.5 font-medium whitespace-nowrap">区分</th>
                  <th className="py-2 px-2.5 font-medium">診療行為・医薬品名称 / 摘要コメント</th>
                  <th className="py-2 px-2 text-right font-medium whitespace-nowrap">単価点</th>
                  <th className="py-2 px-2 text-center font-medium whitespace-nowrap">数量×日数/回</th>
                  <th className="py-2 px-2.5 text-right font-medium whitespace-nowrap">算定点数</th>
                  <th className="py-2 px-2 text-right font-medium whitespace-nowrap">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {selectedPatient.billingItems.map((item) => {
                  const lineTotal = calculateLineItemPoints(item);
                  const hasFinding = auditFindings.some((f) => f.relatedItemId === item.id);

                  return (
                    <tr
                      key={item.id}
                      className={hasFinding ? 'bg-rose-50/40 hover:bg-rose-50/70' : 'hover:bg-slate-50/80'}
                    >
                      <td className="py-2.5 px-2.5 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                        {item.category}:{item.categoryName}
                      </td>
                      <td className="py-2.5 px-2.5">
                        <div className="font-medium text-slate-900">{item.name}</div>
                        <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                          コード: {item.code}
                        </div>
                        {item.commentText && (
                          <div className="mt-1 text-[11px] text-emerald-800 bg-emerald-50/80 px-2 py-0.5 rounded border border-emerald-200">
                            摘要コメント [{item.commentCode}]: {item.commentText}
                          </div>
                        )}
                        {editingCommentItemId === item.id ? (
                          <div className="mt-1.5 flex items-center gap-1.5">
                            <input
                              type="text"
                              aria-label={`${item.name}の摘要コメント入力`}
                              value={commentInputText}
                              onChange={(e) => setCommentInputText(e.target.value)}
                              placeholder="例: 療養計画書交付・患者同意済"
                              className="flex-1 bg-white border border-slate-300 rounded px-2 py-1 text-xs"
                            />
                            <button
                              type="button"
                              onClick={() => handleSaveComment(item.id)}
                              className="px-2 py-1 bg-slate-900 text-white rounded text-xs whitespace-nowrap"
                            >
                              保存
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingCommentItemId(item.id);
                              setCommentInputText(item.commentText || '');
                            }}
                            className="mt-1 inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-900"
                          >
                            <MessageSquarePlus className="w-3 h-3" />
                            <span>{item.commentText ? 'コメント編集' : '摘要コメント追加'}</span>
                          </button>
                        )}
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                        {item.points}点
                      </td>
                      <td className="py-2.5 px-2 text-center whitespace-nowrap">
                        <div className="inline-flex items-center gap-1 font-mono tabular-nums">
                          <input
                            type="number"
                            min={1}
                            max={30}
                            aria-label={`${item.name}の数量`}
                            value={item.quantity}
                            onChange={(e) =>
                              handleUpdateItemQuantityOrDays(
                                item.id,
                                'quantity',
                                Number(e.target.value)
                              )
                            }
                            className="w-11 text-center bg-white border border-slate-200 rounded py-0.5 text-xs"
                          />
                          <span className="text-slate-400">×</span>
                          <input
                            type="number"
                            min={1}
                            max={90}
                            aria-label={`${item.name}の日数または回数`}
                            value={item.days}
                            onChange={(e) =>
                              handleUpdateItemQuantityOrDays(
                                item.id,
                                'days',
                                Number(e.target.value)
                              )
                            }
                            className="w-12 text-center bg-white border border-slate-200 rounded py-0.5 text-xs"
                          />
                          <span className="text-[11px] text-slate-500">
                            {item.itemType === 'drug' ? '日' : item.unit}
                          </span>
                        </div>
                      </td>
                      <td className="py-2.5 px-2.5 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                        {lineTotal.toLocaleString()}点
                      </td>
                      <td className="py-2.5 px-2 text-right">
                        <button
                          type="button"
                          onClick={() => handleRemoveBillingItem(item.id, item.name)}
                          aria-label={`算定項目「${item.name}」を削除`}
                          className="p-1 text-slate-400 hover:text-rose-600 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* MHLW Master Quick Picker */}
          <div className="pt-2 border-t border-slate-100">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <span className="text-xs font-semibold text-slate-800">
                デモマスタから診療行為・処方薬を追加
              </span>
              <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-md">
                {[
                  { code: 'ALL', label: 'すべて' },
                  { code: '11', label: '11:初再診' },
                  { code: '13', label: '13:医学管理' },
                  { code: '21', label: '21:投薬' },
                  { code: '40', label: '40:処置' },
                  { code: '60', label: '60:検査' },
                ].map((tab) => (
                  <button
                    key={tab.code}
                    type="button"
                    onClick={() => setSelectedCategoryFilter(tab.code)}
                    className={`px-2 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                      selectedCategoryFilter === tab.code
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="relative mb-2">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                aria-label="診療行為・医薬品マスタ検索"
                value={procedureQuery}
                onChange={(e) => setProcedureQuery(e.target.value)}
                placeholder="診療行為名・薬品名・9桁コードで検索（例: 生活習慣病管理料, ロキソプロフェン, HbA1c）..."
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-slate-900"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-44 overflow-y-auto pr-1">
              {filteredProcedures.map((proc) => (
                <button
                  key={proc.code}
                  type="button"
                  onClick={() => handleAddBillingItem(proc.code)}
                  className="text-left p-2 border border-slate-200 rounded-md hover:border-slate-900 hover:bg-slate-50 transition-colors flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-slate-900 truncate">
                      {proc.name}
                    </div>
                    <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                      {proc.category}:{proc.categoryName} · {proc.code}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-xs font-mono tabular-nums font-semibold text-slate-900">
                      +{proc.points}点
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Right Column: Real-time MHLW Audit Inspector & Accounting Ledger (4 cols on lg) */}
      <aside
        aria-label="リアルタイムレセプト点検および会計集計"
        className="lg:col-span-4 flex flex-col gap-4"
      >
        {/* Accounting Point & Copay Summary */}
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="flex items-center justify-between border-b border-slate-200 pb-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                医事会計・窓口一部負担金計算
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                デモ計算（10円単位に四捨五入）
              </p>
            </div>
            <span className="text-xs font-mono tabular-nums text-slate-600">
              1点 = 10円
            </span>
          </div>

          <div className="grid grid-cols-3 divide-x divide-slate-200 border-y border-slate-200 py-3 my-3">
            <div className="pr-3">
              <div className="text-[11px] text-slate-500 whitespace-nowrap">算定総点数</div>
              <div
                data-testid="total-points-display"
                className="text-base font-bold font-mono tabular-nums text-slate-900 mt-0.5 whitespace-nowrap"
              >
                {calculation.totalPoints.toLocaleString()} <span className="text-xs font-normal">点</span>
              </div>
            </div>
            <div className="px-3">
              <div className="text-[11px] text-slate-500 whitespace-nowrap">医療費総額 (10割)</div>
              <div className="text-base font-bold font-mono tabular-nums text-slate-900 mt-0.5 whitespace-nowrap">
                ¥{calculation.grossAmountYen.toLocaleString()}
              </div>
            </div>
            <div className="pl-3">
              <div className="text-[11px] text-slate-600 font-medium whitespace-nowrap">
                窓口負担金 ({Math.round(selectedPatient.copayRatio * 10)}割)
              </div>
              <div
                data-testid="copay-yen-display"
                className="text-base font-bold font-mono tabular-nums text-slate-900 mt-0.5 whitespace-nowrap"
              >
                ¥{calculation.copayRoundedYen.toLocaleString()}
              </div>
            </div>
          </div>

          {/* Category Breakdown Table */}
          <div className="text-xs pt-1 space-y-1">
            {Object.entries(calculation.categoryBreakdown)
              .filter(([, val]) => val.points > 0)
              .map(([code, val]) => (
                <div key={code} className="flex items-center justify-between text-slate-600">
                  <span>
                    区分{code}（{val.label} · {val.count}件）
                  </span>
                  <span className="font-mono tabular-nums font-medium text-slate-900">
                    {val.points.toLocaleString()} 点
                  </span>
                </div>
              ))}
            <div className="flex items-center justify-between text-slate-600 pt-1.5 border-t border-slate-100">
              <span>審査支払機関請求額（保険者負担分）</span>
              <span className="font-mono tabular-nums font-semibold text-slate-900">
                ¥{calculation.insuranceClaimYen.toLocaleString()}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={handleFinalizeAccounting}
            className="mt-3 w-full py-2.5 px-4 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-md transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
          >
            <FileCheck2 className="w-4 h-4 shrink-0" />
            <span>デモ会計を確定して保存</span>
          </button>
        </div>

        {/* Real-time MHLW Receipt Auto-Check Panel */}
        <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                リアルタイム自動レセプト点検
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                令和6年度改定・適応傷病名・併算定・縦覧・別表Iコメント検証
              </p>
            </div>
            <span
              data-testid="active-findings-count"
              className="text-xs font-mono tabular-nums font-semibold text-slate-700 whitespace-nowrap shrink-0"
            >
              指摘 {auditFindings.length}件
            </span>
          </div>

          {auditFindings.length === 0 ? (
            <div className="p-4 bg-emerald-50/70 border border-emerald-200 rounded-md flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
              <div className="text-xs text-emerald-950">
                <div className="font-semibold">
                  デモ点検での指摘はありません
                </div>
                <p className="text-emerald-800 mt-1 leading-relaxed">
                  収録済みのサンプルルールで点検しました。
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {auditFindings.map((finding) => {
                const isError = finding.severity === 'error';
                const isWarn = finding.severity === 'warning';

                return (
                  <div
                    key={finding.id}
                    className={`p-3 rounded-md border text-xs flex flex-col gap-2 ${
                      isError
                        ? 'bg-rose-50/60 border-rose-200 text-slate-900'
                        : isWarn
                        ? 'bg-amber-50/60 border-amber-200 text-slate-900'
                        : 'bg-sky-50/60 border-sky-200 text-slate-900'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1.5 font-semibold">
                        {isError ? (
                          <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                        ) : isWarn ? (
                          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                        ) : (
                          <Sparkles className="w-4 h-4 text-sky-700 shrink-0" />
                        )}
                        <span>{finding.title}</span>
                      </div>
                      <span className="font-mono tabular-nums text-[11px] text-slate-600 whitespace-nowrap shrink-0">
                        {finding.ruleCode} · {finding.impactPoints}点
                      </span>
                    </div>

                    <p className="text-slate-700 leading-relaxed">{finding.description}</p>

                    <div className="text-[11px] text-slate-500">
                      根拠通知: {finding.mhlwReference}
                    </div>

                    {finding.fixAction && (
                      <div className="pt-1">
                        <button
                          type="button"
                          onClick={() =>
                            onApplyAutoFix(selectedPatient.id, finding.fixAction!, finding.title)
                          }
                          className="w-full py-2 px-3 bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium rounded transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap overflow-hidden"
                        >
                          <Wrench className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">自動補正: {finding.fixAction.label}</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
};
