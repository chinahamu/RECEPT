/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import type { ClaimConfirmation, ClaimRecord } from './types/claimRecord';
import type { PatientRecord } from './types/receipt';
import type { ClaimPreview, Workspace, WorkspaceAction, WorkspaceResult } from './types/workspace';
import { CLINIC_FACILITY_INFO, DEMO_MONTH } from './data/demoWorkspace';
import { OFFICIAL_MASTERS, type MasterKind } from './data/officialMasters';
import { ApiError, requestJson } from './utils/workspaceApi';
import { EncounterWorkstation } from './components/EncounterWorkstation';
import { BatchAuditConsole } from './components/BatchAuditConsole';
import { PatientRegistryView } from './components/PatientRegistryView';
import { LocalServerMasterView } from './components/LocalServerMasterView';
import { ClaimRecordDialog } from './components/ClaimRecordDialog';
import { ClaimRecordsView } from './components/ClaimRecordsView';
import { ClaimCsvModal } from './components/ClaimCsvModal';
import { HardDrive, Wifi, WifiOff } from 'lucide-react';

type ActiveTab = 'workstation' | 'audit' | 'patients' | 'claims' | 'server';

const API = '/api/workspace';

function confirmDemoExport(destination: string) {
  return window.confirm(`患者情報を含むデモデータを${destination}します。管理された端末・保存先であることを確認してください。`);
}
export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('workstation');
  const [workspace, setWorkspace] = useState<Workspace>();
  const [storageError, setStorageError] = useState('');
  const [selectedPatientId, setSelectedPatientId] = useState('');
  const [claim, setClaim] = useState<ClaimPreview>();
  const [confirmation, setConfirmation] = useState<ClaimConfirmation>();
  const [claimRecord, setClaimRecord] = useState<ClaimRecord>();
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
          setConfirmation(undefined);
        } catch {
          // Keep the conflict message and allow a manual reload.
        }
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function mutate(action: WorkspaceAction, expectedRevision?: number) {
    if (!workspace) return;
    return run(async () => {
      const result = await requestJson<WorkspaceResult>(API, { revision: expectedRevision ?? workspace.revision, action });
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
    if (window.confirm('編集中のデモデータを消去して初期状態に戻しますか？確定済みの請求記録は保存されます。') &&
        await mutate({ type: 'reset' })) {
      setSelectedPatientId('');
    }
  }

  async function openClaim() {
    const preview = await run(() => requestJson<ClaimPreview>('/api/claim-preview'));
    if (preview) setClaim(preview);
  }

  async function reviewClaim(patientId: string) {
    const query = new URLSearchParams({ patientId });
    const preview = await run(() => requestJson<ClaimConfirmation>(`/api/claim-records?${query}`));
    if (preview) setConfirmation(preview);
  }

  function exportClaimRecord(id: string) {
    if (!confirmDemoExport('JSONファイルに保存')) return Promise.resolve(undefined);
    const query = new URLSearchParams({ id, export: '1' });
    return run(() => requestJson<ClaimRecord>(`/api/claim-records?${query}`));
  }

  async function openClaimRecord(id: string) {
    const query = new URLSearchParams({ id });
    const record = await run(() => requestJson<ClaimRecord>(`/api/claim-records?${query}`));
    if (record) setClaimRecord(record);
  }

  async function confirmClaim(preview: ClaimConfirmation, correctionReason?: string) {
    const result = await mutate({
      type: 'finalize', patientId: preview.snapshot.patient.id, reviewHash: preview.reviewHash, correctionReason,
    }, preview.revision);
    if (result?.claimRecord) {
      setConfirmation(undefined);
      setClaimRecord(result.claimRecord);
    }
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

  const { patients, activity, isOfflineMode, dataExportsEnabled } = workspace;
  const missingMasters = (Object.keys(OFFICIAL_MASTERS) as MasterKind[])
    .filter((kind) => !workspace.masterKinds.includes(kind));
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
            href="#claims"
            onClick={(e) => { e.preventDefault(); setActiveTab('claims'); }}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeTab === 'claims' ? 'border-slate-900 text-slate-900 font-semibold' : 'border-transparent hover:text-slate-900'
            }`}
          >
            請求確定記録
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
            disabled={busy || !dataExportsEnabled}
            className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            {dataExportsEnabled ? 'デモ請求CSV出力' : 'デモデータ出力は無効'}
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
          <span>公式マスター {workspace.masterKinds.length}/{Object.keys(OFFICIAL_MASTERS).length}種取込済み</span>
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
      {missingMasters.length > 0 && (
        <div className="bg-sky-50 border-b border-sky-200 px-6 py-2 text-xs text-sky-900">
          初期セットアップ · 未取り込み {missingMasters.map((kind) => OFFICIAL_MASTERS[kind]).join('、')}
          <button type="button" className="ml-2 underline" onClick={() => setActiveTab('server')}>
            公式マスターを取り込む
          </button>
        </div>
      )}
      {storageError && (
        <div role="alert" className="bg-red-50 px-6 py-2 text-sm text-red-800">{storageError}</div>
      )}

      {/* Main Content Viewport */}
      <main aria-busy={busy} className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-5">
        {activeTab === 'workstation' && (
          <EncounterWorkstation
            patients={patients}
            selectedPatientId={selectedPatientId}
            onSelectPatient={setSelectedPatientId}
            onUpdatePatient={handleUpdatePatient}
            onReviewClaim={reviewClaim}
            onApplyAutoFix={(patientId, findingId) => mutate({ type: 'fix', patientId, findingId })}
            isOfflineMode={isOfflineMode}
          />
        )}

        {activeTab === 'audit' && (
          <BatchAuditConsole
            patients={patients}
            onApplyAutoFix={(patientId, findingId) => mutate({ type: 'fix', patientId, findingId })}
            onBatchAutoFixAll={() => mutate({ type: 'batchFix' })}
            onOpenClaimCsv={dataExportsEnabled ? openClaim : undefined}
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

        {activeTab === 'claims' && <ClaimRecordsView onOpen={openClaimRecord} busy={busy} />}
        {activeTab === 'server' && (
          <LocalServerMasterView
            activity={activity}
            isOfflineMode={isOfflineMode}
            onImported={(kind) => setWorkspace((current) => current && ({
              ...current, masterKinds: [...new Set([...current.masterKinds, kind])],
            }))}
            onToggleOfflineMode={() => mutate({ type: 'toggleOffline' })}
            onResetDemoData={handleResetDemoData}
            onCreateSnapshot={dataExportsEnabled ? async () => {
              if (!confirmDemoExport('JSONファイルに保存')) return;
              return (await mutate({ type: 'snapshot' }))?.workspace;
            } : undefined}
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

      {confirmation && <ClaimRecordDialog confirmation={confirmation}
        onConfirm={(reason) => confirmClaim(confirmation, reason)} busy={busy} error={storageError}
        onClose={() => setConfirmation(undefined)} />}
      {claimRecord && <ClaimRecordDialog record={claimRecord} busy={busy} error={storageError}
        onExport={dataExportsEnabled ? () => exportClaimRecord(claimRecord.id) : undefined}
        onClose={() => setClaimRecord(undefined)} />}
      {claim && (
        <ClaimCsvModal
          claim={claim}
          onClose={() => setClaim(undefined)}
          onExport={async (destination) => {
            if (!confirmDemoExport(destination === 'clipboard' ? 'クリップボードにコピー' : 'CSVファイルに保存')) return;
            const output = (await mutate({ type: 'exportCsv' }, claim.revision))?.claim;
            if (output) setClaim(output);
            return output;
          }}
          busy={busy}
          error={storageError}
        />
      )}
    </div>
  );
}
