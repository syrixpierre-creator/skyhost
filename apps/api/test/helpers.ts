import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { getDb, users } from "@skyhost/db";
import { outbox } from "@skyhost/core";
import { buildApp } from "../src/app";

let appPromise: Promise<FastifyInstance> | null = null;
export function getApp() {
  appPromise ??= buildApp().then(async (a) => {
    await a.ready();
    return a;
  });
  return appPromise;
}

export interface Res<T = any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  status: number;
  body: T;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
}

/** Minimal browser-like client: keeps cookies and sends the CSRF header like the dashboard does. */
export class Client {
  cookies = new Map<string, string>();
  bearer: string | null = null;
  ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

  async req<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const app = await getApp();
    const h: Record<string, string> = { "x-forwarded-for": this.ip, ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const csrf = this.cookies.get("sh_csrf");
    if (csrf && !("x-csrf-token" in headers)) h["x-csrf-token"] = csrf;
    if (this.bearer) h.authorization = `Bearer ${this.bearer}`;
    const res = await app.inject({ method: method as never, url, payload: body === undefined ? undefined : (body as object), headers: h });
    const set = res.headers["set-cookie"];
    for (const c of Array.isArray(set) ? set : set ? [set] : []) {
      const [pair] = c.split(";");
      const idx = pair!.indexOf("=");
      const k = pair!.slice(0, idx);
      const v = pair!.slice(idx + 1);
      if (!v || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    let parsed: unknown = res.body;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      /* not json */
    }
    return { status: res.statusCode, body: parsed as T, headers: res.headers as Res["headers"], raw: res.body };
  }
  get<T = any>(url: string, headers?: Record<string, string>) { // eslint-disable-line @typescript-eslint/no-explicit-any
    return this.req<T>("GET", url, undefined, headers);
  }
  post<T = any>(url: string, body: unknown = {}, headers?: Record<string, string>) { // eslint-disable-line @typescript-eslint/no-explicit-any
    return this.req<T>("POST", url, body, headers);
  }
  put<T = any>(url: string, body: unknown = {}) { // eslint-disable-line @typescript-eslint/no-explicit-any
    return this.req<T>("PUT", url, body);
  }
  patch<T = any>(url: string, body: unknown = {}) { // eslint-disable-line @typescript-eslint/no-explicit-any
    return this.req<T>("PATCH", url, body);
  }
  del<T = any>(url: string, body?: unknown) { // eslint-disable-line @typescript-eslint/no-explicit-any
    return this.req<T>("DELETE", url, body);
  }
}

let counter = 0;
export function uniqueEmail(prefix = "user") {
  return `${prefix}-${Date.now()}-${counter++}@example.com`;
}

export const PASSWORD = "correct-horse-42";

/** Signs up a user, verifies the email through the real verification link and returns a logged-in client. */
export async function newUser(opts: { name?: string; referralCode?: string; verify?: boolean; email?: string } = {}) {
  const c = new Client();
  const email = opts.email ?? uniqueEmail();
  const res = await c.post("/api/v1/auth/signup", { email, password: PASSWORD, name: opts.name ?? "Test User", acceptTerms: true, referralCode: opts.referralCode });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${res.raw}`);
  if (opts.verify !== false) {
    const mail = [...outbox].reverse().find((m) => m.to === email && /Verify/.test(m.subject));
    const token = /token=([\w-]+)/.exec(mail!.text)![1];
    const v = await c.post("/api/v1/auth/verify-email", { token });
    if (v.status !== 200) throw new Error("verification failed");
  }
  const teams = await c.get("/api/v1/teams");
  const [u] = await getDb().select().from(users).where(eq(users.email, email));
  return { client: c, email, user: u!, teamId: teams.body.teams[0].id as string };
}

/** Upgrades a team directly in the database (billing is tested separately). */
export async function setPlan(teamId: string, slug: string) {
  const { plans, teams } = await import("@skyhost/db");
  const [p] = await getDb().select().from(plans).where(eq(plans.slug, slug));
  await getDb().update(teams).set({ planId: p!.id }).where(eq(teams.id, teamId));
}
