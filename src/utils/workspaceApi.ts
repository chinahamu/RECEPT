export const sessionExpiredEvent = 'recept:session-expired';
let displayedSessionId: string | undefined;

export function setDisplayedSession(id?: string) {
  displayedSessionId = id;
}

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
  const sessionId = displayedSessionId;
  let response: Response;
  try {
    const headers = new Headers(options?.headers);
    if (sessionId && url !== '/api/login' && url !== '/api/session') {
      headers.set('X-RECEPT-Session', sessionId);
    }
    response = await fetch(url, { ...options, headers, cache: 'no-store', mode: 'same-origin', redirect: 'error' });
  } catch {
    throw new Error('RECEPTサーバーに接続できません。起動状態を確認してください。');
  }
  if (!response.headers.get('Content-Type')?.includes('application/json')) {
    throw new Error('RECEPTのAPIを利用できません。npm run dev または npm run preview で起動してください。');
  }
  const data = await response.json();
  if (response.status === 401 && displayedSessionId === sessionId && url !== '/api/login' && url !== '/api/session') {
    window.dispatchEvent(new Event(sessionExpiredEvent));
  }
  if (!response.ok) throw new ApiError(response.status, data.error ?? 'サーバーの処理に失敗しました。');
  return data as T;
}
