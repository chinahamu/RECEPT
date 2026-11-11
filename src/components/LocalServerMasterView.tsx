import React, { useState } from 'react';
import {
  Download,
  HardDrive,
  RefreshCw,
  Server,
  ShieldCheck,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { LocalActivityEntry } from '../types/receipt';
import type { Workspace } from '../types/workspace';
import { OfficialMasterImports } from './OfficialMasterImports';
import { CLINIC_FACILITY_INFO } from '../data/demoWorkspace';
import type { MasterKind } from '../data/officialMasters';

interface LocalServerMasterViewProps {
  activity: LocalActivityEntry[];
  isOfflineMode: boolean;
  onImported: (kind: MasterKind) => void;
  onToggleOfflineMode: () => void;
  onResetDemoData: () => void;
  onCreateSnapshot?: () => Promise<Workspace | undefined>;
}

export const LocalServerMasterView: React.FC<LocalServerMasterViewProps> = ({
  activity,
  isOfflineMode,
  onToggleOfflineMode,
  onImported,
  onResetDemoData,
  onCreateSnapshot,
}) => {
  const [snapshotMessage, setSnapshotMessage] = useState<string | null>(null);

  const handleDownloadSnapshot = async () => {
    const snapshot = await onCreateSnapshot?.();
    if (!snapshot) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      facility: CLINIC_FACILITY_INFO,
      offlineModeActive: snapshot.isOfflineMode,
      patientCount: snapshot.patients.length,
      patients: snapshot.patients,
      activity: snapshot.activity,
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
        aria-label="SQLite保存・動作モード"
        className="bg-white border border-slate-200 rounded-lg p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <h1 className="text-base font-bold text-slate-900">
              院内サーバー・マスタ
            </h1>
            <p className="text-xs text-slate-600 mt-1">
              デモの患者情報と操作履歴は、SQLiteに保存されます。
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

            {onCreateSnapshot && (
              <button
                type="button"
                onClick={handleDownloadSnapshot}
                className="px-3.5 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-900 text-xs font-semibold rounded-md transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Download className="w-4 h-4" />
                <span>デモスナップショット出力 (JSON)</span>
              </button>
            )}

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

        {/* Server storage and connection status */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-slate-200 pt-4 mt-2 text-xs">
          <div className="py-2 sm:py-0 sm:pr-4">
            <div className="flex items-center gap-1.5 text-slate-600 font-medium">
              <Server className="w-4 h-4 text-slate-800 shrink-0" />
              <span>保存先</span>
            </div>
            <div className="font-mono tabular-nums font-semibold text-slate-900 mt-1">
              RECEPTサーバー
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              SQLiteデータベース
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

        </div>
      </section>

      <OfficialMasterImports onImported={onImported} />

      {/* Activity log */}
      <div className="grid grid-cols-1 gap-5">
        <section
          aria-label="デモ操作履歴"
          className="bg-white border border-slate-200 rounded-lg p-4 flex flex-col gap-3"
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

      </div>
    </div>
  );
};
