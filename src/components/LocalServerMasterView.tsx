import React, { useState, useMemo } from 'react';
import {
  Database,
  Download,
  HardDrive,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { LocalActivityEntry, PatientRecord } from '../types/receipt';
import {
  CLINIC_FACILITY_INFO,
  MHLW_DISEASE_MASTER,
  MHLW_PROCEDURE_MASTER,
} from '../data/mhlwMaster';

interface LocalServerMasterViewProps {
  patients: PatientRecord[];
  activity: LocalActivityEntry[];
  isOfflineMode: boolean;
  onToggleOfflineMode: () => void;
  onResetDemoData: () => void;
  onCreateSnapshotLog: () => boolean;
}

export const LocalServerMasterView: React.FC<LocalServerMasterViewProps> = ({
  patients,
  activity,
  isOfflineMode,
  onToggleOfflineMode,
  onResetDemoData,
  onCreateSnapshotLog,
}) => {
  const [masterTab, setMasterTab] = useState<'PROCEDURE' | 'DISEASE'>('PROCEDURE');
  const [masterSearch, setMasterSearch] = useState('');
  const [snapshotMessage, setSnapshotMessage] = useState<string | null>(null);

  const filteredProcedureMaster = useMemo(() => {
    const q = masterSearch.trim().toLowerCase();
    if (!q) return MHLW_PROCEDURE_MASTER;
    return MHLW_PROCEDURE_MASTER.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.code.includes(q) ||
        m.categoryName.toLowerCase().includes(q)
    );
  }, [masterSearch]);

  const filteredDiseaseMaster = useMemo(() => {
    const q = masterSearch.trim().toLowerCase();
    if (!q) return MHLW_DISEASE_MASTER;
    return MHLW_DISEASE_MASTER.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        d.code.includes(q) ||
        d.icd10.toLowerCase().includes(q)
    );
  }, [masterSearch]);

  const handleDownloadSnapshot = () => {
    if (!onCreateSnapshotLog()) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      facility: CLINIC_FACILITY_INFO,
      offlineModeActive: isOfflineMode,
      patientCount: patients.length,
      patients,
      activity,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `recept-demo-snapshot-${payload.exportedAt.slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setSnapshotMessage(
      'デモスナップショット（JSON）のダウンロードを開始しました。'
    );
    setTimeout(() => setSnapshotMessage(null), 5000);
  };

  return (
    <div className="flex flex-col gap-5">
      {/* On-Premises Architecture & Offline Mode Resilience Control */}
      <section
        aria-label="ブラウザ保存・動作モード"
        className="bg-white border border-slate-200 rounded-lg p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <h1 className="text-base font-bold text-slate-900">
              院内サーバー・マスタ（デモ）
            </h1>
            <p className="text-xs text-slate-600 mt-1">
              デモの患者情報と操作履歴は、このブラウザに保存されます。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={onToggleOfflineMode}
              className={`px-3.5 py-2 text-xs font-semibold rounded-md transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                isOfflineMode
                  ? 'bg-amber-600 hover:bg-amber-700 text-white'
                  : 'bg-slate-900 hover:bg-slate-800 text-white'
              }`}
            >
              {isOfflineMode ? (
                <>
                  <Wifi className="w-4 h-4" />
                  <span>通常表示に戻す</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-4 h-4" />
                  <span>オフライン想定に切替</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleDownloadSnapshot}
              className="px-3.5 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-900 text-xs font-semibold rounded-md transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <Download className="w-4 h-4" />
              <span>デモスナップショット出力 (JSON)</span>
            </button>

            <button
              type="button"
              onClick={onResetDemoData}
              className="px-3 py-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 text-xs font-medium rounded-md transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>初期サンプルデータに戻す</span>
            </button>
          </div>
        </div>

        {snapshotMessage && (
          <div
            role="status"
            className="mt-3 p-3 bg-emerald-50 border border-emerald-200 rounded-md text-xs text-emerald-900"
          >
            {snapshotMessage}
          </div>
        )}

        {/* 4-Column Server & Master Specification Grid with Hairline Dividers */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-slate-200 pt-4 mt-2 text-xs">
          <div className="py-2 sm:py-0 sm:pr-4">
            <div className="flex items-center gap-1.5 text-slate-600 font-medium">
              <Server className="w-4 h-4 text-slate-800 shrink-0" />
              <span>保存先</span>
            </div>
            <div className="font-mono tabular-nums font-semibold text-slate-900 mt-1">
              このブラウザ
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              ブラウザのローカルストレージ
            </div>
          </div>

          <div className="py-2 sm:py-0 sm:px-4">
            <div className="flex items-center gap-1.5 text-slate-600 font-medium">
              <HardDrive className="w-4 h-4 text-slate-800 shrink-0" />
              <span>操作履歴</span>
            </div>
            <div className="font-mono tabular-nums font-semibold text-slate-900 mt-1">
              直近50件
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              履歴 <span className="font-mono tabular-nums">{activity.length}</span> 件
            </div>
          </div>

          <div className="py-2 sm:py-0 sm:px-4">
            <div className="flex items-center gap-1.5 text-slate-600 font-medium">
              <ShieldCheck className="w-4 h-4 text-slate-800 shrink-0" />
              <span>資格情報の表示モード</span>
            </div>
            <div
              data-testid="network-mode-status"
              className={`font-semibold mt-1 ${
                isOfflineMode ? 'text-amber-700' : 'text-emerald-700'
              }`}
            >
              {isOfflineMode
                ? 'オフライン想定'
                : '通常表示'}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              切替でデモ資格情報の表示を確認できます
            </div>
          </div>

          <div className="py-2 sm:py-0 sm:pl-4">
            <div className="flex items-center gap-1.5 text-slate-600 font-medium">
              <Database className="w-4 h-4 text-slate-800 shrink-0" />
              <span>収録マスタ</span>
            </div>
            <div className="font-semibold text-slate-900 mt-1">
              {CLINIC_FACILITY_INFO.mhlwMasterVersion}
            </div>
            <div className="text-[11px] text-slate-500 mt-1 font-mono tabular-nums">
              診療行為・薬価 {MHLW_PROCEDURE_MASTER.length}件 · 傷病名 {MHLW_DISEASE_MASTER.length}件
            </div>
          </div>
        </div>
      </section>

      {/* Split Grid: Activity log and demo master browser */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Activity log (5 cols) */}
        <section
          aria-label="デモ操作履歴"
          className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-4 flex flex-col gap-3"
        >
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-2.5">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                デモ操作履歴
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                算定変更・自動補正・患者登録などの操作を記録します
              </p>
            </div>
            <span className="text-xs font-mono tabular-nums text-slate-600 whitespace-nowrap shrink-0">
              {activity.length} 件記録
            </span>
          </div>

          <div className="border border-slate-200 rounded-md overflow-hidden max-h-[460px] overflow-y-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <th className="py-2 px-2.5 font-medium whitespace-nowrap">時刻 / 種別</th>
                  <th className="py-2 px-2.5 font-medium">対象 / 操作内容</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {activity.length === 0 && (
                  <tr><td colSpan={2} className="p-3 text-slate-500">操作履歴はまだありません。</td></tr>
                )}
                {activity.map((entry) => (
                  <tr key={entry.id} className="hover:bg-slate-50">
                    <td className="py-2 px-2.5 font-mono tabular-nums whitespace-nowrap">
                      <div className="text-slate-900">{entry.timestamp}</div>
                      <div className="text-[11px] text-slate-500">{entry.actionType}</div>
                    </td>
                    <td className="py-2 px-2.5">
                      <div className="font-mono tabular-nums text-[11px] text-slate-500">
                        {entry.patientChartNumber}
                      </div>
                      <div className="text-slate-800">{entry.summary}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Demo master table (7 cols) */}
        <section
          aria-label="デモマスタ一覧"
          className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-4 flex flex-col gap-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2.5">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                レセプト点検用デモマスタ
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                操作確認に使う診療行為・傷病名・算定ルールのサンプル
              </p>
            </div>

            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-md">
              <button
                type="button"
                onClick={() => setMasterTab('PROCEDURE')}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  masterTab === 'PROCEDURE'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                診療行為・医薬品マスタ ({MHLW_PROCEDURE_MASTER.length})
              </button>
              <button
                type="button"
                onClick={() => setMasterTab('DISEASE')}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  masterTab === 'DISEASE'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                傷病名マスタ ({MHLW_DISEASE_MASTER.length})
              </button>
            </div>
          </div>

          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              aria-label="デモマスタ検索"
              value={masterSearch}
              onChange={(e) => setMasterSearch(e.target.value)}
              placeholder="コード・名称・ICD10・区分で検索..."
              className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-slate-900"
            />
          </div>

          <div className="border border-slate-200 rounded-md overflow-x-auto max-h-[420px] overflow-y-auto">
            {masterTab === 'PROCEDURE' ? (
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <th className="py-2 px-2.5 font-medium font-mono whitespace-nowrap">9桁電算コード</th>
                    <th className="py-2 px-2 font-medium whitespace-nowrap">区分</th>
                    <th className="py-2 px-2.5 font-medium">名称 / 改定・算定ルール備考</th>
                    <th className="py-2 px-2.5 text-right font-medium whitespace-nowrap">点数</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredProcedureMaster.map((m) => (
                    <tr key={m.code} className="hover:bg-slate-50">
                      <td className="py-2 px-2.5 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                        {m.code}
                      </td>
                      <td className="py-2 px-2 text-slate-600 whitespace-nowrap">
                        {m.category}:{m.categoryName}
                      </td>
                      <td className="py-2 px-2.5">
                        <div className="font-medium text-slate-900">{m.name}</div>
                        {m.revisionNote && (
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            {m.revisionNote}
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-2.5 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                        {m.points}点 / {m.unit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <th className="py-2 px-2.5 font-medium font-mono">7桁傷病名コード</th>
                    <th className="py-2 px-2.5 font-medium">傷病名</th>
                    <th className="py-2 px-2 font-medium font-mono">ICD-10</th>
                    <th className="py-2 px-2.5 font-medium">管理料対象区分（デモ）</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredDiseaseMaster.map((d) => (
                    <tr key={d.code} className="hover:bg-slate-50">
                      <td className="py-2 px-2.5 font-mono tabular-nums text-slate-700">
                        {d.code}
                      </td>
                      <td className="py-2 px-2.5 font-medium text-slate-900">{d.name}</td>
                      <td className="py-2 px-2 font-mono tabular-nums text-slate-600">
                        {d.icd10}
                      </td>
                      <td className="py-2 px-2.5 text-slate-700">
                        {d.isTargetOfSeikatsuShukan
                          ? '生活習慣病管理料(I)/(II) 対象（特定疾患療養管理料は対象外）'
                          : d.isTargetOfTokuteiShikkan
                          ? '特定疾患療養管理料（225点）対象疾患'
                          : '一般傷病（管理料対象外）'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
