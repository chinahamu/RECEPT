/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import type { PatientRecord } from './types/receipt';
import type { ClaimPreview, Workspace, WorkspaceAction, WorkspaceResult } from './types/workspace';
import { CLINIC_FACILITY_INFO, DEMO_MONTH } from './data/mhlwMaster';
import { ApiError, requestJson } from './utils/workspaceApi';
import { EncounterWorkstation } from './components/EncounterWorkstation';
import { BatchAuditConsole } from './components/BatchAuditConsole';
import { PatientRegistryView } from './components/PatientRegistryView';
import { LocalServerMasterView } from './components/LocalServerMasterView';
import { ClaimCsvModal } from './components/ClaimCsvModal';
import { HardDrive, Wifi, WifiOff } from 'lucide-react';

type ActiveTab = 'workstation' | 'audit' | 'patients' | 'server';

const API = '/api/workspace';
const LEGACY_STORAGE_KEY = 'recept-demo-v1';

function readLegacyData() {
  try {
    return localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return null;
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('workstation');
  const [workspace, setWorkspace] = useState<Workspace>();
  const [storageError, setStorageError] = useState('');
  const [selectedPatientId, setSelectedPatientId] = useState('');
  const [claim, setClaim] = useState<ClaimPreview>();
  const [legacy, setLegacy] = useState(readLegacyData);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    requestJson<Workspace>(API).then(
      (data) => { if (mounted) setWorkspace(data); },
      (error: Error) => { if (mounted) setStorageError(error.message); },
    );
    return () => { mounted = false; };
  }, []);

  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setStorageError('');
    try {
      return await work();
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : '操作に失敗しました。');
      if (error instanceof ApiError && error.status === 409) {
        try {
          setWorkspace(await requestJson<Workspace>(API));
          setClaim(undefined);
        } catch {
          // Keep the conflict message and allow a manual reload.
        }
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function mutate(action: WorkspaceAction) {
    if (!workspace) return;
    return run(async () => {
      const result = await requestJson<WorkspaceResult>(API, { revision: workspace.revision, action });
      setWorkspace(result.workspace);
      return result;
    });
  }

  async function handleRegisterPatient(patient: PatientRecord) {
    const result = await mutate({ type: 'register', patient });
    if (result) setSelectedPatientId(result.workspace.patients[0].id);
    return Boolean(result);
  }

  async function handleUpdatePatient(patient: PatientRecord, summary: string) {
    return Boolean(await mutate({
      type: 'update', patientId: patient.id, diagnoses: patient.diagnoses, billingItems: patient.billingItems, summary,
    }));
  }

  async function handleResetDemoData() {
    if (window.confirm('登録・編集したデモデータを消去して初期状態に戻しますか？') &&
        await mutate({ type: 'reset' })) {
      setSelectedPatientId('');
    }
  }

  async function handleImportLegacy() {
    if (!legacy || !window.confirm('このブラウザに保存された旧版のデモデータをSQLiteに取り込みますか？')) return;
    let data;
    try {
      data = JSON.parse(legacy);
      if (!data || typeof data !== 'object') throw new Error();
    } catch {
      setStorageError('旧版のブラウザ保存データを読み込めません。');
      return;
    }
    const result = await mutate({
      type: 'importLegacy', patients: data.patients, activity: data.activity, isOfflineMode: data.isOfflineMode,
    });
    if (result) setLegacy(null);
  }

  async function openClaim() {
    const preview = await run(() => requestJson<ClaimPreview>('/api/claim-preview'));
    if (preview) setClaim(preview);
  }

  if (!workspace) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <h1 className="text-xl font-bold">レセプト</h1>
        {storageError ? (
          <>
            <p role="alert" className="mt-4 text-red-800">{storageError}</p>
            <button type="button" className="mt-3 underline" onClick={() => window.location.reload()}>再読み込み</button>
          </>
        ) : <p role="status" className="mt-4">SQLiteからデモデータを読み込み中…</p>}
      </main>
    );
  }

  const { patients, activity, isOfflineMode } = workspace;
  const totalErrorCount = patients.reduce((sum, patient) => sum + patient.findings.filter((f) => f.severity === 'error').length, 0);

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
            onClick={openClaim}
            disabled={busy}
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
            <span>SQLite保存 · 操作履歴 {activity.length}件</span>
          </span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => mutate({ type: 'toggleOffline' })}
            disabled={busy}
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

      {legacy && workspace.revision === 0 && (
        <div className="bg-sky-50 px-6 py-2 text-sm text-sky-900">
          旧版のデモデータがこのブラウザにあります。
          <button type="button" onClick={handleImportLegacy} disabled={busy} className="ml-2 underline">
            SQLiteに取り込む
          </button>
        </div>
      )}

      {/* Main Content Viewport */}
      <main aria-busy={busy} className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-5">
        {activeTab === 'workstation' && (
          <EncounterWorkstation
            patients={patients}
            selectedPatientId={selectedPatientId}
            onSelectPatient={setSelectedPatientId}
            onUpdatePatient={handleUpdatePatient}
            onFinalize={async (patientId) => Boolean(await mutate({ type: 'finalize', patientId }))}
            onApplyAutoFix={(patientId, findingId) => mutate({ type: 'fix', patientId, findingId })}
            isOfflineMode={isOfflineMode}
          />
        )}

        {activeTab === 'audit' && (
          <BatchAuditConsole
            patients={patients}
            onApplyAutoFix={(patientId, findingId) => mutate({ type: 'fix', patientId, findingId })}
            onBatchAutoFixAll={() => mutate({ type: 'batchFix' })}
            onOpenClaimCsv={openClaim}
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
            activity={activity}
            isOfflineMode={isOfflineMode}
            onToggleOfflineMode={() => mutate({ type: 'toggleOffline' })}
            onResetDemoData={handleResetDemoData}
            onCreateSnapshot={async () => (await mutate({ type: 'snapshot' }))?.workspace}
          />
        )}
      </main>

      {/* Quiet Footer */}
      <footer className="bg-white border-t border-slate-200 px-6 py-3 text-xs text-slate-500 flex flex-wrap items-center justify-between gap-2">
        <div>
          レセプト — 架空データでの操作検証版
        </div>
        <div className="font-mono tabular-nums">
          デモ診療月 {DEMO_MONTH} · SQLite保存
        </div>
      </footer>

      {claim && (
        <ClaimCsvModal
          claim={claim}
          onClose={() => setClaim(undefined)}
          onExport={async () => (await mutate({ type: 'exportCsv' }))?.claim}
          busy={busy}
          error={storageError}
        />
      )}
    </div>
  );
}
