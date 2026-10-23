/** API client. The dashboard and the API share the same origin (/api), so cookies and CSRF just work. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

function csrf(): string | undefined {
  return document.cookie
    .split("; ")
    .find((c) => c.startsWith("__Host-sh_csrf=") || c.startsWith("sh_csrf="))
    ?.split("=")[1];
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData; raw?: boolean } = {}): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const method = opts.method ?? (opts.body !== undefined || opts.form ? "POST" : "GET");
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const token = csrf();
  if (token && method !== "GET") headers["X-CSRF-Token"] = token;
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: "include",
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  if (opts.raw) {
    if (!res.ok) throw new ApiError(res.status, "error", res.statusText);
    return res as unknown as T;
  }
  const text = await res.text();
  const data = text ? (() => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  })() : null;
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string; details?: unknown } })?.error;
    throw new ApiError(res.status, err?.code ?? "error", err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>(p); // eslint-disable-line @typescript-eslint/no-explicit-any
export const post = <T = any>(p: string, body: unknown = {}) => api<T>(p, { method: "POST", body }); // eslint-disable-line @typescript-eslint/no-explicit-any
export const put = <T = any>(p: string, body: unknown = {}) => api<T>(p, { method: "PUT", body }); // eslint-disable-line @typescript-eslint/no-explicit-any
export const patch = <T = any>(p: string, body: unknown = {}) => api<T>(p, { method: "PATCH", body }); // eslint-disable-line @typescript-eslint/no-explicit-any
export const del = <T = any>(p: string, body?: unknown) => api<T>(p, { method: "DELETE", body }); // eslint-disable-line @typescript-eslint/no-explicit-any

export function download(path: string) {
  const a = document.createElement("a");
  a.href = `/api/v1${path}`;
  a.rel = "noopener";
  a.click();
}

/** Realtime: one WebSocket per tab, multiplexed channels with automatic reconnect. */
type Listener = (msg: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
class Realtime {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private retry = 0;

  private url() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/api/v1/ws`;
  }

  private connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      for (const ch of this.listeners.keys()) ws.send(JSON.stringify({ op: "subscribe", channel: ch }));
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.channel) this.listeners.get(msg.channel)?.forEach((l) => l(msg));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.listeners.size) setTimeout(() => this.connect(), Math.min(15000, 500 * 2 ** this.retry++));
    };
  }

  subscribe(channel: string, fn: Listener) {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ op: "subscribe", channel }));
    }
    set.add(fn);
    this.connect();
    return () => {
      set!.delete(fn);
      if (!set!.size) {
        this.listeners.delete(channel);
        if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ op: "unsubscribe", channel }));
      }
    };
  }
}

export const realtime = new Realtime();

export function wsUrl(path: string) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/v1${path}`;
}
