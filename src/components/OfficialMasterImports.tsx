import { useEffect, useState, type FormEvent } from 'react';
import {
  MASTER_DISEASE_DOWNLOAD, MASTER_DOWNLOAD, MASTER_GUIDE, MASTER_MAX_BYTES, OFFICIAL_MASTERS,
  officialFilename, type MasterImport, type MasterKind, type MasterRow,
} from '../data/officialMasters';
import { requestApi } from '../utils/workspaceApi';

const endpoint = '/api/official-masters';
const fieldClass = 'rounded-md border border-slate-300 px-2 py-1.5 text-sm';
const buttonClass = 'rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50';
const linkClass = 'text-sky-800 underline underline-offset-2';

export function OfficialMasterImports({ onImported }: { onImported: (kind: MasterKind) => void }) {
  const [imports, setImports] = useState<MasterImport[]>([]);
  const [selectedId, setSelectedId] = useState<number>();
  const [filename, setFilename] = useState('');
  const [publishedOn, setPublishedOn] = useState('');
  const [rows, setRows] = useState<MasterRow[]>([]);
  const [searchText, setSearchText] = useState('');
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [searchError, setSearchError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingImports, setLoadingImports] = useState(true);
  const [searching, setSearching] = useState(false);
  const selected = imports.find((entry) => entry.id === selectedId);
  const match = officialFilename.exec(filename);

  useEffect(() => {
    const controller = new AbortController();
    requestApi<MasterImport[]>(endpoint, { signal: controller.signal }).then((entries) => {
      if (controller.signal.aborted) return;
      setImports(entries);
      setSelectedId(entries[0]?.id);
    }).catch((err: Error) => {
      if (!controller.signal.aborted) setError(err.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingImports(false);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    setRows([]);
    setSearchError('');
    setSearching(true);
    const params = new URLSearchParams({ id: String(selectedId), q: query });
    requestApi<MasterRow[]>(`${endpoint}?${params}`, { signal: controller.signal }).then((entries) => {
      if (!controller.signal.aborted) setRows(entries);
    }).catch((err: Error) => {
      if (!controller.signal.aborted) setSearchError(err.message);
    }).finally(() => {
      if (!controller.signal.aborted) setSearching(false);
    });
    return () => controller.abort();
  }, [query, selectedId]);

  async function importFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = new FormData(form).get('master');
    if (!(file instanceof File) || !file.size || file.size > MASTER_MAX_BYTES) {
      setMessage('');
      setError('20 MiB以下のCSVまたはTXTファイルを選んでください。');
      return;
    }
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const params = new URLSearchParams({ filename: file.name, publishedOn });
      const { entry, duplicate } = await requestApi<{ entry: MasterImport; duplicate: boolean }>(
        `${endpoint}?${params}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
        },
      );
      setImports((current) => [entry, ...current.filter((item) => item.id !== entry.id)]
        .sort((a, b) => b.publishedOn.localeCompare(a.publishedOn) || b.id - a.id));
      onImported(entry.kind);
      setSelectedId(entry.id);
      setSearchText('');
      setQuery('');
      setMessage(duplicate ? '同じ更新日の同一ファイルは取り込み済みです。' : `${entry.rowCount.toLocaleString()}件を取り込みました。`);
      form.reset();
      setFilename('');
      setPublishedOn('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'マスターの取り込みに失敗しました。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="official-master-heading" className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 id="official-master-heading" className="text-sm font-semibold">公式マスターの取り込み・参照</h2>
      <p className="mt-2 text-xs text-slate-600">
        厚生労働省の配布ページから全件版をダウンロードし、ZIPを解凍して、元の名前のCSVまたはTXTを1ファイルずつ選んでください。
        傷病名と対応する固定点数の医科診療行為は、会計・診療入力画面の新規入力にも使えます。
      </p>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <li><a className={linkClass} href={MASTER_DOWNLOAD} target="_blank" rel="noreferrer">厚労省 基本マスター</a></li>
        <li><a className={linkClass} href={MASTER_DISEASE_DOWNLOAD} target="_blank" rel="noreferrer">厚労省 傷病名・修飾語</a></li>
        <li><a className={linkClass} href={MASTER_GUIDE} target="_blank" rel="noreferrer">出典と操作手順</a></li>
      </ul>
      <form onSubmit={importFile} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs">
          マスターファイル
          <input name="master" type="file" accept=".csv,.txt" required disabled={busy} className={fieldClass}
            onChange={(event) => {
              const name = event.target.files?.[0]?.name ?? '';
              const parts = officialFilename.exec(name);
              setFilename(name);
              setPublishedOn(parts?.[2] ? `${parts[2]}-${parts[3]}-${parts[4]}` : '');
              setMessage('');
              setError('');
            }} />
        </label>
        <label className="grid gap-1 text-xs">
          配布ページの更新日
          <input type="date" required disabled={busy} className={fieldClass} value={publishedOn}
            onChange={(event) => setPublishedOn(event.target.value)} />
        </label>
        <button className={buttonClass} disabled={loadingImports || busy || !match || !publishedOn}>
          {busy ? '取り込み中…' : '取り込む'}
        </button>
      </form>
      {filename && !match && <p className="mt-2 text-xs text-red-700">対象の全件マスターを解凍し、元の名前で選んでください。</p>}
      {message && <p role="status" className="mt-2 text-xs text-emerald-700">{message}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}

      <div className="mt-4 border-t border-slate-200 pt-4">
        <h3 className="text-xs font-semibold">取り込み済みマスター</h3>
        {selected ? (
          <>
            <label className="mt-2 grid max-w-full gap-1 text-xs">
              参照する版
              <select className={fieldClass} value={selected.id}
                onChange={(event) => setSelectedId(Number(event.target.value))}>
                {imports.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {OFFICIAL_MASTERS[entry.kind]} · {entry.publishedOn} · 取込 #{entry.id}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-2 text-xs text-slate-600">
              {selected.filename} · {selected.rowCount.toLocaleString()}件 · 取込 {new Date(selected.importedAt).toLocaleString('ja-JP')}
            </p>
            <details className="mt-1 text-xs text-slate-600">
              <summary>ファイルのSHA-256</summary>
              <code className="break-all">{selected.sha256}</code>
            </details>
            <form className="mt-3 flex flex-wrap gap-2" onSubmit={(event) => {
              event.preventDefault();
              setQuery(searchText.trim());
            }}>
              <input type="search" className={fieldClass} aria-label="公式マスターのコードまたは名称"
                placeholder="コード・名称で検索" maxLength={200} value={searchText}
                onChange={(event) => setSearchText(event.target.value)} />
              <button className={buttonClass}>検索</button>
            </form>
            {searchError ? <p role="alert" className="mt-2 text-xs text-red-700">{searchError}</p> :
              <div className="mt-2 max-h-64 overflow-auto rounded-md border border-slate-200">
                <table className="w-full text-left text-xs">
                  <caption className="p-2 text-left text-slate-600">コード順に最大100件を表示</caption>
                  <thead className="bg-slate-50"><tr><th className="p-2">コード</th><th className="p-2">名称</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((row) => <tr key={row.code}><td className="p-2 font-mono">{row.code}</td><td className="p-2">{row.name}</td></tr>)}
                    {!rows.length && <tr><td className="p-2" colSpan={2}>{searching ? '読み込み中…' : '該当するコード・名称がありません。'}</td></tr>}
                  </tbody>
                </table>
              </div>}
          </>
        ) : <p className="mt-2 text-xs text-slate-600">{loadingImports ? '読み込み中…' : '取り込み済みのマスターはありません。'}</p>}
      </div>
    </section>
  );
}
