/**
 * API 请求封装
 *
 * 所有请求都走本服务的 `/api/xb/*` 代理（见 next.config.mjs），
 * 因此浏览器只跟本服务通信 —— 无跨域、Xboard 无需改造。
 */

const PREFIX = '/api/xb';

export type ApiResult<T> = {
  ok: boolean;
  data?: T;
  message: string;
  status: number;
};

const TOKEN_KEY = 'kc_token';

export function readToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function writeToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 隐私模式下可能失败，忽略 */
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

type Opts = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** 是否附带登录令牌（默认 true） */
  auth?: boolean;
  /** 超时毫秒，默认 20s */
  timeout?: number;
};

async function request<T>(path: string, opts: Opts = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (opts.auth !== false) {
    const token = readToken();
    if (token) headers.Authorization = token;
  }

  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeout ?? 20000) : null;

  try {
    const res = await fetch(PREFIX + path, {
      method: opts.method || 'GET',
      headers,
      body,
      signal: ctrl ? ctrl.signal : undefined,
    });

    let json: unknown = null;
    const text = await res.text();
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    const j = (json || {}) as { status?: string; message?: string; data?: T; errors?: Record<string, string[]> };

    // 校验失败（422）时把首条错误提出来，供表单直接展示
    let message = j.message || '';
    if (!message && j.errors) {
      const first = Object.values(j.errors)[0];
      if (Array.isArray(first) && first.length) message = first[0];
    }

    return {
      ok: res.ok && j.status === 'success',
      data: j.data,
      message: message || (res.ok ? '' : '请求失败（' + res.status + '）'),
      status: res.status,
    };
  } catch (e) {
    const err = e as Error;
    const aborted = err && err.name === 'AbortError';
    return {
      ok: false,
      message: aborted ? '请求超时，请检查网络后重试' : '网络异常，请稍后重试',
      status: 0,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const api = {
  get: <T>(path: string, opts?: Omit<Opts, 'method' | 'body'>) => request<T>(path, { ...opts, method: 'GET' }),
  post: <T>(path: string, body?: unknown, opts?: Omit<Opts, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'POST', body }),
};

/* ── 插件路由（无 /api 前缀）── */

const PG_PREFIX = '/api/pg';

async function pgRequest<T>(path: string, opts: Opts = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.auth !== false) {
    const token = readToken();
    if (token) headers.Authorization = token;
  }
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  try {
    const res = await fetch(PG_PREFIX + path, { method: opts.method || 'GET', headers, body });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const j = (json || {}) as { status?: string; message?: string; data?: T };
    return { ok: res.ok && j.status === 'success', data: j.data, message: j.message || '', status: res.status };
  } catch {
    return { ok: false, message: '网络异常，请稍后重试', status: 0 };
  }
}

export const pg = {
  get: <T>(path: string, opts?: Omit<Opts, 'method' | 'body'>) => pgRequest<T>(path, { ...opts, method: 'GET' }),
  post: <T>(path: string, body?: unknown, opts?: Omit<Opts, 'method' | 'body'>) =>
    pgRequest<T>(path, { ...opts, method: 'POST', body }),
};
