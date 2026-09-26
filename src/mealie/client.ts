import { MealieError } from './errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryValue = string | number | boolean | Array<string | number> | null | undefined;

export interface MealieRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export interface MealieClientInit {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  onUnauthorized?: () => void;
}

export class MealieClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly onUnauthorized?: () => void;

  constructor(init: MealieClientInit) {
    this.baseUrl = init.baseUrl.replace(/\/+$/, '');
    this.token = init.token;
    this.timeoutMs = init.timeoutMs ?? 10_000;
    this.retryDelayMs = init.retryDelayMs ?? 250;
    this.onUnauthorized = init.onUnauthorized;
  }

  get<T = unknown>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>({ method: 'GET', path, query });
  }
  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>({ method: 'POST', path, body });
  }
  put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>({ method: 'PUT', path, body });
  }
  patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>({ method: 'PATCH', path, body });
  }
  delete<T = unknown>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>({ method: 'DELETE', path, query });
  }

  async request<T = unknown>(req: MealieRequest): Promise<T> {
    const attempts = req.method === 'GET' ? 2 : 1;
    let lastError: MealieError | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0 && this.retryDelayMs > 0) await new Promise((r) => setTimeout(r, this.retryDelayMs));
      try {
        return await this.once<T>(req);
      } catch (err) {
        if (!(err instanceof MealieError)) throw err;
        lastError = err;
        const retryable = err.kind !== 'http' || err.status >= 500;
        if (!retryable) break;
      }
    }
    throw lastError!;
  }

  private async once<T>(req: MealieRequest): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: 'application/json' };
    let body: string | undefined;
    if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.body);
    }
    let res: Response;
    try {
      // Resolve global fetch at call time so msw can intercept it in tests.
      res = await fetch(this.buildUrl(req.path, req.query), {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new MealieError({ kind: timedOut ? 'timeout' : 'network', status: 0, method: req.method, path: req.path });
    }
    const text = await res.text();
    const parsed = parseBody(text);
    if (!res.ok) {
      if (res.status === 401) this.onUnauthorized?.();
      throw new MealieError({ kind: 'http', status: res.status, method: req.method, path: req.path, detail: parsed });
    }
    return parsed as T;
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) for (const v of value) url.searchParams.append(key, String(v));
      else url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
}

function parseBody(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
