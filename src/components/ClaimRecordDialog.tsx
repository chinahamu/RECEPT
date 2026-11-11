import { useEffect, useRef, useState } from 'react';
import type { ClaimActor, ClaimConfirmation, ClaimRecord } from '../types/claimRecord';

const actorLabel = (actor: ClaimActor) => actor.kind === 'authenticated' ? actor.userId : '匿名（デモ）';
const dateLabel = (value: string) => new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

type Props = {
  onClose: () => void;
  busy: boolean;
  error: string;
} & (
  | { record: ClaimRecord; confirmation?: never; onConfirm?: never }
  | { record?: never; confirmation: ClaimConfirmation; onConfirm: (reason?: string) => void }
);

export function ClaimRecordDialog({ record, confirmation, onConfirm, onClose, busy, error }: Props) {
  const [reason, setReason] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);

  const snapshot = record?.snapshot ?? confirmation!.snapshot;
  const { patient, calculation, findings, masters } = snapshot;
  const previous = confirmation?.previous;
  const correction = Boolean(previous);
  const title = record ? `確定記録 第${record.version}版` : correction ? '訂正内容の確認' : '請求記録の確定内容を確認';

  function download() {
    if (!record) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `recept-demo-claim-${record.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <dialog ref={dialog} aria-labelledby="claim-record-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      className="m-auto w-[calc(100%-2rem)] max-w-3xl max-h-[88vh] overflow-auto rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-900 backdrop:bg-slate-950/50">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <h2 id="claim-record-title" className="text-lg font-bold">{title}</h2>
        <button type="button" autoFocus onClick={onClose} className="rounded-md border border-slate-300 px-3 py-1.5">閉じる</button>
      </div>
      <p className="mt-3 font-semibold">{patient.name}（{patient.chartNumber}） · 診療月 {snapshot.month}</p>
      <p className="mt-1 text-xs text-slate-600">{patient.kana} · {patient.birthDate} · {patient.sex}</p>
      <p className="mt-1 text-xs text-slate-600">{patient.insuranceCategory} · 保険者 {patient.insurerNumber} · 記号番号 {patient.symbolNumber}
        {patient.publicExpenseNumber && ` · 公費 ${patient.publicExpenseNumber}`}</p>
      <p className="mt-1 text-xs text-slate-600">{snapshot.facility.facilityName}（{snapshot.facility.facilityCode}）</p>
      <p className="my-3 rounded-md bg-slate-100 p-3 font-medium">
        {calculation.totalPoints.toLocaleString()} 点 · 窓口負担 {calculation.copayRoundedYen.toLocaleString()} 円 · 保険者負担 {calculation.insuranceClaimYen.toLocaleString()} 円
      </p>
      <h3 className="mt-3 font-semibold">傷病名</h3>
      {patient.diagnoses.length ? (
        <ul className="mt-1 space-y-1 text-xs">{patient.diagnoses.map((item) => (
          <li key={item.id}>{item.diseaseCode} {item.diseaseName}{item.isSuspected ? '（疑い）' : ''} · {item.startDate} · {item.outcome}</li>
        ))}</ul>
      ) : <p className="text-xs text-slate-600">傷病名の記録はありません。</p>}
      <h3 className="mt-3 font-semibold">算定明細</h3>
      {patient.billingItems.length ? (
        <ul className="mt-1 divide-y divide-slate-100 text-xs">{patient.billingItems.map((item) => (
          <li key={item.id} className="py-1">
            {item.date} · {item.code} {item.name} · {item.quantity}{item.unit} × {item.days} · {snapshot.linePoints[item.id]} 点
            {item.commentText && <p className="mt-1 break-words text-slate-600">摘要 {item.commentText}</p>}
          </li>
        ))}</ul>
      ) : <p className="text-xs text-slate-600">算定明細の記録はありません。</p>}
      {findings.length > 0 && (
        <details className="mt-3 text-xs text-amber-900">
          <summary>デモ点検の指摘 {findings.length}件</summary>
          <ul className="mt-1 space-y-1">{findings.map((finding) => <li key={finding.id}>{finding.title}</li>)}</ul>
        </details>
      )}
      <details className="mt-3 text-xs text-slate-600">
        <summary>算定ルールとマスターの版</summary>
        <p className="mt-1">{snapshot.ruleVersion}</p>
        {masters.map((master) => <p key={master.id}>{master.filename} · 更新日 {master.publishedOn} · 取込ID {master.id}</p>)}
        {masters.length === 0 && <p>取込版を特定できる明細はありません。</p>}
      </details>
      {record && (
        <div className="mt-4 space-y-1 border-t border-slate-200 pt-3 text-xs">
          <p>確定者 {actorLabel(record.confirmedBy)} · {dateLabel(record.confirmedAt)} JST</p>
          <p>最終入力者 {record.enteredBy ? `${actorLabel(record.enteredBy.actor)} · ${dateLabel(record.enteredBy.at)} JST` : '記録なし'}</p>
          {record.previousId && <p className="break-all">訂正元ID {record.previousId}</p>}
          {record.correctionReason && <p className="whitespace-pre-wrap break-words">訂正理由 {record.correctionReason}</p>}
          <p className="break-all">記録ID {record.id}</p>
          <p className="break-all">SHA-256 {record.sha256}</p>
          <button type="button" onClick={download} className="mt-2 rounded-md border border-slate-300 px-3 py-2">確定記録のJSONを保存</button>
        </div>
      )}
      {confirmation && (
        <form className="mt-4 space-y-3 border-t border-slate-200 pt-3" onSubmit={(event) => {
          event.preventDefault();
          if (confirmation.hasChanges && !busy && (!correction || reason.trim())) onConfirm?.(correction ? reason.trim() : undefined);
        }}>
          {correction && <p>第{previous!.version}版（{dateLabel(previous!.confirmedAt)} JST）から訂正します。</p>}
          {confirmation.hasChanges ? (
            <>
              {correction && (
                <label className="block text-xs font-medium">訂正理由
                  <textarea required maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)}
                    className="mt-1 block w-full rounded-md border border-slate-300 p-2 text-sm" />
                </label>
              )}
              <button type="submit" disabled={busy || (correction && !reason.trim())}
                className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
                {correction ? '訂正を新しい版として確定' : 'この内容で確定'}
              </button>
            </>
          ) : <p role="status">確定済みの記録と同じ内容です。</p>}
        </form>
      )}
      {error && <p role="alert" className="mt-3 text-red-700">{error}</p>}
    </dialog>
  );
}
