import { useEffect, useState } from 'react';
import type { ClinicalMasterEntries } from '../data/officialMasters';
import { requestApi } from './workspaceApi';

export function useClinicalMasterSearch<K extends keyof ClinicalMasterEntries>(kind: K, query: string) {
  const [entries, setEntries] = useState<ClinicalMasterEntries[K][]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ clinical: kind, q: query });
      requestApi<ClinicalMasterEntries[K][]>(
        `/api/official-masters?${params}`, { signal: controller.signal },
      ).then((rows) => {
        if (controller.signal.aborted) return;
        setEntries(rows);
        setError('');
      }).catch((err: Error) => {
        if (controller.signal.aborted) return;
        setEntries([]);
        setError(err.message);
      });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [kind, query]);
  return { entries, error };
}
