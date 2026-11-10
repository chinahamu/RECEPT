import React, { useState } from 'react';
import { CheckCircle2, Copy, Download, X, AlertTriangle } from 'lucide-react';
import type { ClaimPreview } from '../types/workspace';

interface ClaimCsvModalProps {
  claim: ClaimPreview;
  onClose: () => void;
  onExport: () => Promise<ClaimPreview | undefined>;
  busy: boolean;
  error: string;
}

export const ClaimCsvModal: React.FC<ClaimCsvModalProps> = ({ claim, onClose, onExport, busy, error }) => {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const handleCopy = async () => {
    const output = await onExport();
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output.csv);
      setCopyStatus('copied');
      setTimeout(() => setCopyStatus('idle'), 3000);
    } catch {
      setCopyStatus('failed');
    }
  };

  const handleDownloadCsv = async () => {
    const output = await onExport();
    if (!output) return;
    const blob = new Blob([output.csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recept-demo-claims.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="claim-csv-title"
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
    >
      <div className="bg-white border border-slate-200 rounded-lg max-w-4xl w-full p-5 flex flex-col gap-4 max-h-[88vh]">
        <div className="flex items-center justify-between border-b border-slate-200 pb-3">
          <div>
            <h2 id="claim-csv-title" className="text-base font-bold text-slate-900">
              デモ請求CSV 出力プレビュー
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              架空データで請求内容を確認するためのCSVです。保険請求への使用はできません。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="モーダルを閉じる"
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-md"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {claim.errorCount > 0 ? (
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-900 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>
              現在、未解決の要修正エラーが <strong className="font-mono tabular-nums">{claim.errorCount}</strong> 件残っています。「レセプト自動点検」画面で内容を確認できます。
            </span>
          </div>
        ) : (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-md text-xs text-emerald-900 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
            <span>
              全 <strong className="font-mono tabular-nums">{claim.patientCount}</strong> 件のレセプトについて、デモ点検で要修正エラーはありません。
            </span>
          </div>
        )}

        {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
        {copyStatus === 'failed' && (
          <p role="status" className="text-xs text-red-700">コピーできませんでした。CSVを保存して確認してください。</p>
        )}

        <div className="flex-1 overflow-y-auto bg-slate-950 text-slate-100 p-4 rounded-md font-mono text-xs leading-relaxed overflow-x-auto">
          <pre data-testid="claim-csv-preview">{claim.csv}</pre>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200">
          <div className="text-xs text-slate-500 font-mono tabular-nums">
            文字コード UTF-8
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              disabled={busy}
              className="px-3.5 py-2 border border-slate-300 hover:bg-slate-50 text-slate-800 text-xs font-medium rounded-md inline-flex items-center gap-1.5"
            >
              <Copy className="w-4 h-4" />
              <span>{copyStatus === 'copied' ? 'クリップボードにコピー済' : 'CSVをコピー'}</span>
            </button>
            <button
              type="button"
              onClick={handleDownloadCsv}
              disabled={busy}
              className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-md inline-flex items-center gap-1.5"
            >
              <Download className="w-4 h-4" />
              <span>デモCSVを保存</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
