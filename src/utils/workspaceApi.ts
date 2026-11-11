export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function requestJson<T>(url: string, body?: unknown): Promise<T> {
  return requestApi<T>(url, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function requestApi<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...options, cache: 'no-store', mode: 'same-origin', redirect: 'error' });
  } catch {
    throw new Error('RECEPTサーバーに接続できません。起動状態を確認してください。');
  }
  if (!response.headers.get('Content-Type')?.includes('application/json')) {
    throw new Error('RECEPTのAPIを利用できません。npm run dev または npm run preview で起動してください。');
  }
  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, data.error ?? 'サーバーの処理に失敗しました。');
  return data as T;
}
