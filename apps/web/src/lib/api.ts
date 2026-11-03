export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
  /** Sem conexão com o servidor (não é erro de regra de negócio). */
  get offline() {
    return this.status === 0;
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      credentials: 'include',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal ?? AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ApiError(0, 'Sem conexão com o servidor', 'OFFLINE');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login' && path !== '/auth/me') window.dispatchEvent(new Event('cpdv:unauthorized'));
    throw new ApiError(res.status, data?.error ?? `Erro ${res.status}`, data?.code);
  }
  return data as T;
}
