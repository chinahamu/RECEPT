/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  AuditFixAction,
  LocalActivityEntry,
  PatientRecord,
} from './types/receipt';
import {
  CLINIC_FACILITY_INFO,
  INITIAL_PATIENTS,
  DEMO_MONTH,
} from './data/mhlwMaster';
import {
  applyAutoFixToPatient,
  runMhlwReceiptCheck,
} from './utils/receiptEngine';
import { EncounterWorkstation } from './components/EncounterWorkstation';
import { BatchAuditConsole } from './components/BatchAuditConsole';
import { PatientRegistryView } from './components/PatientRegistryView';
import { LocalServerMasterView } from './components/LocalServerMasterView';
import { ClaimCsvModal } from './components/ClaimCsvModal';
import { HardDrive, Wifi, WifiOff } from 'lucide-react';

type ActiveTab = 'workstation' | 'audit' | 'patients' | 'server';

const STORAGE_KEY = 'recept-demo-v1';

interface DemoState {
  patients: PatientRecord[];
  activity: LocalActivityEntry[];
  isOfflineMode: boolean;
}

const INITIAL_STATE: DemoState = {
  patients: INITIAL_PATIENTS,
  activity: [],
  isOfflineMode: false,
};

function loadDemoState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { raw, data: INITIAL_STATE };
    const data: DemoState = JSON.parse(raw);
    if (Array.isArray(data.patients) && data.patients.length &&
        Array.isArray(data.activity) && typeof data.isOfflineMode === 'boolean') {
      return { raw, data };
    }
    return { raw, data: INITIAL_STATE, error: '保存データを読み込めません。初期サンプルを表示しています。' };
  } catch {
    return { raw: null, data: INITIAL_STATE, error: '保存データを読み込めません。初期サンプルを表示しています。' };
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('workstation');
  const [saved, setSaved] = useState(loadDemoState);
  const { patients, activity, isOfflineMode } = saved.data;
  const [storageError, setStorageError] = useState(saved.error);
  const [selectedPatientId, setSelectedPatientId] = useState(() => patients[0].id);
  const [isClaimCsvOpen, setIsClaimCsvOpen] = useState(false);

  function save(data: DemoState, reset = false) {
    try {
      if (!reset && localStorage.getItem(STORAGE_KEY) !== saved.raw) {
        setStorageError('保存データが変更されています。画面を再読み込みしてから操作してください。');
        return false;
      }
      const raw = JSON.stringify(data);
      localStorage.setItem(STORAGE_KEY, raw);
      setSaved({ raw, data });
      setStorageError(undefined);
      return true;
    } catch {
      setStorageError('ブラウザに保存できませんでした。保存設定や空き容量を確認してください。');
      return false;
    }
  }

  function recordActivity(
    actionType: LocalActivityEntry['actionType'],
    patientChartNumber: string,
    summary: string,
    updatedPatients = patients,
  ) {
    const entry: LocalActivityEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toLocaleString('ja-JP'),
      actionType,
      patientChartNumber,
      summary,
    };
    return save({
      patients: updatedPatients,
      activity: [entry, ...activity.slice(0, 49)],
      isOfflineMode,
    });
  }

  function handleUpdatePatient(updated: PatientRecord, summary: string) {
    return recordActivity('BILLING_UPDATE', updated.chartNumber, summary,
      patients.map((patient) => patient.id === updated.id ? updated : patient));
  }

  function handleApplyAutoFix(patientId: string, fixAction: AuditFixAction, findingTitle: string) {
    const patient = patients.find((item) => item.id === patientId);
    if (!patient) return;
    const fixed = applyAutoFixToPatient(patient, fixAction);
    recordActivity('AUDIT_AUTO_FIX', patient.chartNumber,
      `デモ点検補正 [${findingTitle}] → ${fixAction.label}`,
      patients.map((item) => item.id === patientId ? fixed : item));
  }

  function handleBatchAutoFixAll() {
    const updated = patients.map((patient) => {
      let current = patient;
      for (let pass = 0; pass < 8; pass++) {
        const actionable = runMhlwReceiptCheck(current).find(
          (finding) => (finding.severity === 'error' || finding.severity === 'warning') && finding.fixAction,
        );
        if (!actionable?.fixAction) break;
        current = applyAutoFixToPatient(current, actionable.fixAction);
      }
      return current;
    });
    recordActivity('AUDIT_AUTO_FIX', 'ALL-RECEIPTS', 'デモ点検の一括補正を実行', updated);
  }

  function handleRegisterPatient(patient: PatientRecord) {
    const success = recordActivity('PATIENT_REGISTER', patient.chartNumber,
      `デモ患者登録: ${patient.name}`, [patient, ...patients]);
    if (success) setSelectedPatientId(patient.id);
    return success;
  }

  function handleToggleOfflineMode() {
    save({ ...saved.data, isOfflineMode: !isOfflineMode });
  }

  function handleResetDemoData() {
    if (window.confirm('登録・編集したデモデータを消去して初期状態に戻しますか？') &&
        save(INITIAL_STATE, true)) {
      setSelectedPatientId(INITIAL_PATIENTS[0].id);
    }
  }

  const totalErrorCount = patients.reduce((acc, pt) => {
    return (
      acc +
      runMhlwReceiptCheck(pt).filter((f) => f.severity === 'error').length
    );
  }, 0);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Top Bar Contract: Strictly 3 zones separated by gap-8 */}
      <header className="bg-white border-b border-slate-200 px-6 py-3.5 flex items-center justify-between gap-8 sticky top-0 z-30">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#workstation"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('workstation');
          }}
          className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          レセプト
        </a>

        {/* Zone 2: 4 concise single-line text navigation links */}
        <nav
          aria-label="メインナビゲーション"
          className="flex items-center gap-6 text-xs sm:text-sm font-medium text-slate-600 overflow-x-auto"
        >
          <a
            href="#workstation"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('workstation');
            }}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'workstation'
                ? 'border-slate-900 text-slate-900 font-semibold'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            会計・診療入力
          </a>
          <a
            href="#audit"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('audit');
            }}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'audit'
                ? 'border-slate-900 text-slate-900 font-semibold'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            レセプト自動点検 ({totalErrorCount})
          </a>
          <a
            href="#patients"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('patients');
            }}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'patients'
                ? 'border-slate-900 text-slate-900 font-semibold'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            患者台帳
          </a>
          <a
            href="#server"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('server');
            }}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'server'
                ? 'border-slate-900 text-slate-900 font-semibold'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            院内サーバー・マスタ
          </a>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={() => setIsClaimCsvOpen(true)}
            className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            デモ請求CSV出力
          </button>
        </div>
      </header>

      {/* Workspace Facility Context & On-Premises Offline Switch Bar */}
      <div className="bg-slate-100/80 border-b border-slate-200 px-6 py-2 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-800">
            {CLINIC_FACILITY_INFO.facilityName}
          </span>
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums">
            医療機関コード {CLINIC_FACILITY_INFO.facilityCode}
          </span>
          <span aria-hidden="true">·</span>
          <span>{CLINIC_FACILITY_INFO.mhlwMasterVersion}</span>
        </div>

        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-slate-700 font-mono tabular-nums">
            <HardDrive className="w-3.5 h-3.5 text-slate-700" />
            <span>ブラウザ保存 · 操作履歴 {activity.length}件</span>
          </span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={handleToggleOfflineMode}
            className={`px-2.5 py-1 rounded border text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
              isOfflineMode
                ? 'bg-amber-100 border-amber-300 text-amber-900'
                : 'bg-white border-slate-300 text-slate-800 hover:bg-slate-50'
            }`}
          >
            {isOfflineMode ? (
              <>
                <WifiOff className="w-3.5 h-3.5 text-amber-700" />
                <span>オフライン想定（通常表示に戻す）</span>
              </>
            ) : (
              <>
                <Wifi className="w-3.5 h-3.5 text-emerald-700" />
                <span>通常表示（オフライン想定に切替）</span>
              </>
            )}
          </button>
        </div>
      </div>

      <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 text-xs text-amber-900">
        開発版 · 架空データ専用。実患者情報の入力、実会計、保険請求への使用はできません。
      </div>
      {storageError && (
        <div role="alert" className="bg-red-50 px-6 py-2 text-sm text-red-800">{storageError}</div>
      )}

      {/* Main Content Viewport */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-5">
        {activeTab === 'workstation' && (
          <EncounterWorkstation
            patients={patients}
            selectedPatientId={selectedPatientId}
            onSelectPatient={setSelectedPatientId}
            onUpdatePatient={handleUpdatePatient}
            onApplyAutoFix={handleApplyAutoFix}
            isOfflineMode={isOfflineMode}
          />
        )}

        {activeTab === 'audit' && (
          <BatchAuditConsole
            patients={patients}
            onApplyAutoFix={handleApplyAutoFix}
            onBatchAutoFixAll={handleBatchAutoFixAll}
            onOpenClaimCsv={() => setIsClaimCsvOpen(true)}
            onNavigateToWorkstation={(patientId) => {
              setSelectedPatientId(patientId);
              setActiveTab('workstation');
            }}
          />
        )}

        {activeTab === 'patients' && (
          <PatientRegistryView
            patients={patients}
            onRegisterPatient={handleRegisterPatient}
            onSelectAndOpenWorkstation={(patientId) => {
              setSelectedPatientId(patientId);
              setActiveTab('workstation');
            }}
          />
        )}

        {activeTab === 'server' && (
          <LocalServerMasterView
            patients={patients}
            activity={activity}
            isOfflineMode={isOfflineMode}
            onToggleOfflineMode={handleToggleOfflineMode}
            onResetDemoData={handleResetDemoData}
            onCreateSnapshotLog={() =>
              recordActivity(
                'BACKUP_SNAPSHOT',
                'SYSTEM',
                'デモデータのスナップショットJSON出力'
              )
            }
          />
        )}
      </main>

      {/* Quiet Footer */}
      <footer className="bg-white border-t border-slate-200 px-6 py-3 text-xs text-slate-500 flex flex-wrap items-center justify-between gap-2">
        <div>
          レセプト — 架空データでの操作検証版
        </div>
        <div className="font-mono tabular-nums">
          デモ診療月 {DEMO_MONTH} · ブラウザ内保存
        </div>
      </footer>

      {/* Demo claim CSV export modal */}
      <ClaimCsvModal
        isOpen={isClaimCsvOpen}
        onClose={() => setIsClaimCsvOpen(false)}
        patients={patients}
        onRecordExport={() =>
          recordActivity(
            'CSV_EXPORT',
            'ALL-RECEIPTS',
            `デモ請求CSV (${patients.length}件) 出力実行`
          )
        }
      />
    </div>
  );
}
