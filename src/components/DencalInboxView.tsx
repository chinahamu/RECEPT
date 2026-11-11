import { useEffect, useRef, useState } from 'react';
import type { DencalDraftReview, DraftChange, InboxDetail, InboxPage, IntegrationReceipt } from '../types/dencalInbox';
import type { BillingLineItem, PatientDiagnosis, PatientRecord } from '../types/receipt';
import { requestApi, requestJson } from '../utils/workspaceApi';

const endpoint = '/api/integration/inbox';
const button = 'rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-800 disabled:opacity-45';
const field = 'w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm';
const statuses: Record<IntegrationReceipt['status'], string> = {
  received: '受信済み', confirmation_required: '確認待ち', applied: '反映済み', rejected: '保留後の照合で拒否',
};
const events = { initial: '初回', correction: '訂正', cancel: '受診取消' };
const issueLabels: Record<string, string> = {
  patient_unmatched: '患者の紐付けが必要です。',
  unknown_master_code: '診療日に参照できるマスターにコードがありません。',
  unsupported_billing_rule: 'マスターの算定条件・適用日・単位を確認してください。',
  predecessor_missing: '直前の版を受信していません。',
  predecessor_pending: '先行版の順序を確認してください。',
  review_rejected: '先行版との整合性を確認できませんでした。',
};
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s/g, '');

function lineLabel(item: BillingLineItem | PatientDiagnosis) {
  if ('date' in item) return `${item.date} · ${item.code} ${item.name} · ${item.points}点 × ${item.quantity} ${item.unit} · マスター版 ${item.masterImportId}`;
  return `${item.startDate} · ${item.diseaseCode} ${item.diseaseName} · ${item.outcome}${item.isMain ? ' · 主病' : ''}${item.isSuspected ? ' · 疑い' : ''} · 対象月 ${item.dencalMonths?.join('、') || 'なし'} · マスター版 ${item.masterImportId}`;
}

function DraftDiff({ review }: { review: DencalDraftReview }) {
  const changes: DraftChange<BillingLineItem | PatientDiagnosis>[] = [...review.diagnoses, ...review.billingItems];
  if (!changes.length) return <p className="text-sm">下書きの変更はありません。反映すると、この連携版を確認済みとして記録します。</p>;
  return <div className="overflow-x-auto">
    <table className="w-full text-left text-sm">
      <thead className="bg-slate-100"><tr>
        <th scope="col" className="p-2">操作</th>
        <th scope="col" className="p-2">反映前</th>
        <th scope="col" className="p-2">反映後</th>
      </tr></thead>
      <tbody className="divide-y divide-slate-100">
        {changes.map(({ before, after }) => <tr key={(after ?? before)?.id}>
          <td className="whitespace-nowrap p-2">{before ? (after ? '変更' : '取消') : '追加'}</td>
          <td className="p-2">{before ? lineLabel(before) : '—'}</td>
          <td className="p-2">{after ? lineLabel(after) : '—'}</td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}

type Props = {
  canEdit: boolean;
  openDraft: (patientId: string, month: string) => void;
  patients: Pick<PatientRecord, 'id' | 'name' | 'kana' | 'chartNumber' | 'birthDate'>[];
  refreshPatients: () => Promise<unknown>;
};

export function DencalInboxView({ patients, refreshPatients, canEdit, openDraft }: Props) {
  const [before, setBefore] = useState<number | null>(null);
  const [page, setPage] = useState<InboxPage>();
  const [detail, setDetail] = useState<InboxDetail>();
  const [review, setReview] = useState<DencalDraftReview>();
  const [appliedMonths, setAppliedMonths] = useState<DencalDraftReview['months']>();
  const [qualificationConfirmed, setQualificationConfirmed] = useState(false);
  const [query, setQuery] = useState('');
  const [patientId, setPatientId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const running = useRef(false);
  const selected = patients.find(({ id }) => id === patientId);
  const needle = normalize(query);
  const matches = needle ? patients.filter((patient) =>
    [patient.chartNumber, patient.name, patient.kana].some((value) => normalize(value).includes(needle))).slice(0, 30) : [];

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    requestApi<InboxPage>(endpoint, { signal: controller.signal }).then(
      (result) => { if (!controller.signal.aborted) setPage(result); },
      (failure: Error) => { if (!controller.signal.aborted) setError(failure.message); },
    );
    return () => { mounted.current = false; controller.abort(); };
  }, []);

  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try { await action(); }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '処理に失敗しました。'); }
    finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function readPage(cursor: number | null) {
    const result = await requestJson<InboxPage>(cursor === null ? endpoint : `${endpoint}?before=${cursor}`);
    if (mounted.current) { setBefore(cursor); setPage(result); }
  }

  function open(seq: number) {
    void run(async () => {
      const result = await requestJson<InboxDetail>(`${endpoint}/${seq}`);
      if (!mounted.current) return;
      setDetail(result);
      setReview(undefined);
      setAppliedMonths(undefined);
      setQualificationConfirmed(false);
      setQuery('');
      setPatientId('');
      setConfirmed(false);
    });
  }

  function link() {
    if (!detail || !selected || !confirmed) return;
    void run(async () => {
      const result = await requestJson<InboxDetail>(`${endpoint}/${detail.seq}/match`, {
        patientId: selected.id, chartNumber: selected.chartNumber,
      });
      if (!mounted.current) return;
      setDetail(result);
      setConfirmed(false);
      await readPage(before);
    });
  }

  function previewDraft() {
    if (!detail) return;
    void run(async () => {
      setReview(undefined);
      setQualificationConfirmed(false);
      const result = await requestJson<DencalDraftReview>(`${endpoint}/${detail.seq}/draft`);
      if (mounted.current) setReview(result);
    });
  }

  function applyDraft() {
    if (!detail || !review || !qualificationConfirmed) return;
    void run(async () => {
      setReview(undefined);
      setQualificationConfirmed(false);
      const result = await requestJson<InboxDetail>(`${endpoint}/${detail.seq}/draft`, {
        reviewHash: review.reviewHash, qualificationConfirmed,
      });
      if (!mounted.current) return;
      setDetail(result);
      await refreshPatients();
      if (!mounted.current) return;
      setAppliedMonths(review.months);
      await readPage(before);
    });
  }

  return (
    <section className="space-y-4" aria-labelledby="dencal-inbox-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="dencal-inbox-title" className="text-lg font-bold">DENCAL受信一覧</h1>
        <button type="button" disabled={busy} className={button} onClick={() => void run(async () => {
          await readPage(null);
          if (detail && mounted.current) {
            const result = await requestJson<InboxDetail>(`${endpoint}/${detail.seq}`);
            if (mounted.current) {
              setDetail(result);
              setReview(undefined);
              setQualificationConfirmed(false);
            }
          }
        })}>再読込</button>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {!page && !error && <p role="status" className="text-sm">受信一覧を読み込んでいます…</p>}
      {page && (
        <div className="overflow-auto rounded-lg border border-slate-200 bg-white">
          {!page.records.length ? <p className="p-4 text-sm">受信データはありません。</p> : (
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-100 text-slate-700"><tr>
                <th scope="col" className="p-3">受診日・患者ID</th>
                <th scope="col" className="p-3">施設・送信元</th>
                <th scope="col" className="p-3">連携版</th>
                <th scope="col" className="p-3">状態</th>
                <th scope="col" className="p-3">操作</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {page.records.map((item) => (
                  <tr key={item.seq}>
                    <td className="p-3">{item.visitDate}<br />{item.patientSourceId}</td>
                    <td className="break-all p-3">{item.facilityId}<br />{item.senderId}</td>
                    <td className="p-3">第{item.transferRevision}版 · {events[item.event]}</td>
                    <td className="p-3">{statuses[item.receipt.status]}<br />{item.patient?.chartNumber ?? '患者未紐付け'}</td>
                    <td className="p-3"><button type="button" className={button} disabled={busy} onClick={() => open(item.seq)}
                      aria-label={`${item.patientSourceId} 第${item.transferRevision}版の詳細`}>詳細</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {(before !== null || page.nextBefore !== null) && (
            <div className="flex gap-2 p-3">
              {before !== null && <button type="button" className={button} disabled={busy} onClick={() => void run(() => readPage(null))}>最新</button>}
              {page.nextBefore !== null && <button type="button" className={button} disabled={busy}
                onClick={() => void run(() => readPage(page.nextBefore))}>古い受信を表示</button>}
            </div>
          )}
        </div>
      )}
      {detail && (
        <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4" aria-labelledby="dencal-inbox-detail">
          <h2 id="dencal-inbox-detail" className="font-semibold">{detail.patientSourceId} · 連携第{detail.transferRevision}版</h2>
          <p className="break-all text-sm">施設 {detail.facilityId} · 送信元 {detail.senderId} · 受診 {detail.encounterId}</p>
          <p className="break-all text-xs text-slate-600">連携ID {detail.integrationId} · カルテ第{detail.chartRevision}版 · {detail.receivedAt}</p>
          {detail.reason && <p className="text-sm">訂正・取消理由 {detail.reason}</p>}
          {detail.receipt.issues.length > 0 && (
            <ul className="space-y-1 text-sm text-amber-900">
              {detail.receipt.issues.map(({ code, path }) => (
                <li key={code + path}>{issueLabels[code] ?? code} <span className="text-xs">{path}</span></li>
              ))}
            </ul>
          )}
          <div className="grid gap-3 border-y border-slate-200 py-3 text-sm md:grid-cols-2">
            <div><h3 className="font-semibold">傷病名コード</h3>
              {detail.diagnoses.map((item) => <p key={item.id}>{item.code} · {item.startDate}{item.isSuspected && ' · 疑い'}</p>)}
              {!detail.diagnoses.length && <p>なし</p>}
            </div>
            <div><h3 className="font-semibold">診療行為</h3>
              {detail.performances.map((item) => <p key={item.id}>{item.code} · {item.performedOn} · {item.quantity} {item.unit}{item.status === 'cancelled' && ' · 取消'}</p>)}
              {!detail.performances.length && <p>なし</p>}
            </div>
          </div>
          {detail.patient ? (
            <p role="status" className="text-sm font-semibold">紐付け先 {detail.patient.chartNumber} {patients.find(({ id }) => id === detail.patient?.id)?.name}</p>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">患者台帳との紐付け</h3>
                <button type="button" className={button} disabled={busy}
                  onClick={() => void run(async () => { await refreshPatients(); })}>患者台帳を再読込</button>
              </div>
              <p className="text-sm">DENCALの患者IDを照合し、RECEPTのカルテ番号・氏名・生年月日を確認してください。</p>
              <label className="block max-w-xl text-sm">患者検索
                <input type="search" className={field} value={query} onChange={(event) => {
                  setQuery(event.target.value); setPatientId(''); setConfirmed(false);
                }} placeholder="カルテ番号・氏名・カナ" />
              </label>
              {needle && (
                <label className="block max-w-xl text-sm">候補患者
                  <select className={field} value={patientId} onChange={(event) => {
                    setPatientId(event.target.value); setConfirmed(false);
                  }}>
                    <option value="">{matches.length ? '選択してください（最大30件）' : '候補なし'}</option>
                    {matches.map((patient) => <option key={patient.id} value={patient.id}>{patient.chartNumber} · {patient.name} · {patient.birthDate}</option>)}
                  </select>
                </label>
              )}
              {selected && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                  {detail.patientSourceId} と {selected.chartNumber}（{selected.name}）が同じ患者であることを確認しました
                </label>
              )}
              <button type="button" className={button} disabled={busy || !confirmed || !selected} onClick={link}>患者を紐付ける</button>
            </div>
          )}
          {canEdit && detail.receipt.status === 'received' && !review && (
            <button type="button" className={button} disabled={busy} onClick={previewDraft}>下書きの差分を確認</button>
          )}
          {review && (
            <div className="space-y-3 border-t border-slate-200 pt-3">
              <h3 className="font-semibold">請求下書きへの反映内容</h3>
              {review.previousTransferRevision !== null &&
                <p className="text-sm">反映済みの連携第{review.previousTransferRevision}版との差分</p>}
              {!!review.months.length && <ul className="space-y-1 text-sm">
                {review.months.map(({ month, confirmedVersion }) => (
                  <li key={month}>
                    {month} {confirmedVersion === null ? '下書き' : `確定第${confirmedVersion}版あり · 反映後に理由を入力して訂正確定`}
                  </li>
                ))}
              </ul>}
              <DraftDiff review={review} />
              <p className="text-sm">
                台帳の保険資格 {review.qualification.insuranceCategory} · 保険者番号 {review.qualification.insurerNumber}
                 · 記号番号 {review.qualification.symbolNumber}{' · '}{review.qualification.verified ? 'デモ確認済み' : '台帳の確認フラグなし'}
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={qualificationConfirmed} disabled={busy}
                  onChange={(event) => setQualificationConfirmed(event.target.checked)} />
                対象患者・保険資格・反映内容を確認しました
              </label>
              <button type="button" className={button} disabled={busy || !qualificationConfirmed} onClick={applyDraft}>
                下書きに反映
              </button>
            </div>
          )}
          {appliedMonths && detail.patient && (
            <div className="flex flex-wrap items-center gap-2">
              <p role="status" className="text-sm font-medium">下書きに反映しました。</p>
              {appliedMonths.map(({ month }) => (
                <button key={month} type="button" className={button} disabled={busy}
                  onClick={() => openDraft(detail.patient!.id, month)}>{month}の下書きを開く</button>
              ))}
            </div>
          )}
        </section>
      )}
    </section>
  );
}
