import { useEffect, useState } from 'react';
import type { ClaimRecordPage } from '../types/claimRecord';
import { requestJson } from '../utils/workspaceApi';

export function ClaimRecordsView({ onOpen, busy }: { onOpen: (id: string) => void; busy: boolean }) {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [before, setBefore] = useState<number | null>(null);
  const [page, setPage] = useState<ClaimRecordPage>();
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    const params = new URLSearchParams({ q: query });
    if (before !== null) params.set('before', String(before));
    requestJson<ClaimRecordPage>(`/api/claim-records?${params}`).then(
      (result) => { if (current) { setPage(result); setError(''); } },
      (failure: Error) => { if (current) { setPage(undefined); setError(failure.message); } },
    );
    return () => { current = false; };
  }, [query, before]);

  return (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-5 text-sm">
      <h2 className="text-base font-semibold">請求確定記録</h2>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
        event.preventDefault();
        setBefore(null);
        setQuery(input.trim());
      }}>
        <label className="text-xs">患者氏名・カルテ番号
          <input type="search" maxLength={100} value={input} onChange={(event) => setInput(event.target.value)}
            className="mt-1 block rounded-md border border-slate-300 px-2 py-1.5" />
        </label>
        <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-white">検索</button>
      </form>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      {!page && !error && <p role="status">確定記録を読み込み中…</p>}
      {page && page.records.length === 0 && <p>該当する確定記録はありません。</p>}
      {page && page.records.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead><tr className="border-b border-slate-200">
              <th scope="col" className="p-2">患者</th><th scope="col" className="p-2">診療月</th>
              <th scope="col" className="p-2">版</th><th scope="col" className="p-2">確定時刻（JST）</th>
              <th scope="col" className="p-2"><span className="sr-only">操作</span></th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">{page.records.map((record) => (
              <tr key={record.id}>
                <td className="p-2">{record.patientName}（{record.chartNumber}）</td><td className="p-2">{record.month}</td>
                <td className="p-2">{record.version}</td>
                <td className="p-2">{new Date(record.confirmedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</td>
                <td className="p-2"><button type="button" disabled={busy} onClick={() => onOpen(record.id)}
                  className="underline" aria-label={`${record.chartNumber} 第${record.version}版の詳細`}>詳細</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div className="flex gap-3 text-xs">
        {before !== null && <button type="button" onClick={() => setBefore(null)} className="underline">最初のページ</button>}
        {page?.nextBefore != null && <button type="button" onClick={() => setBefore(page.nextBefore)} className="underline">古い記録を表示</button>}
      </div>
    </section>
  );
}
