import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { apiKeys, getDb, sessions, users } from "@skyhost/db";
import { randomToken, safeEqual, sha256 } from "@skyhost/shared/node";
import type { Actor } from "@skyhost/core";
import { serverConfig } from "@skyhost/core";

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;

export interface AuthContext {
  user: User | null;
  session: Session | null;
  apiKey: ApiKey | null;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
    rawBody?: Buffer;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}

export const SESSION_COOKIE = "sh_session";
export const CSRF_COOKIE = "sh_csrf";
export const SESSION_DAYS = 30;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function clientIp(req: FastifyRequest): string {
  return req.ip;
}

export function actorOf(req: FastifyRequest): Actor {
  return {
    userId: req.auth.user?.id ?? null,
    apiKeyId: req.auth.apiKey?.id ?? null,
    impersonatorId: req.auth.session?.impersonatorId ?? null,
    ip: clientIp(req),
    userAgent: req.headers["user-agent"] ?? null,
  };
}

/** Cookies are Secure whenever the dashboard is served over HTTPS (always, except explicit plain-HTTP private installs). */
export function secureCookies() {
  return serverConfig().SKYHOST_DASHBOARD_URL.startsWith("https://");
}

function cookieOpts(httpOnly: boolean, maxAgeSeconds: number) {
  const cfg = serverConfig();
  return {
    path: "/",
    httpOnly,
    secure: secureCookies(),
    sameSite: "lax" as const,
    maxAge: maxAgeSeconds,
    ...(cfg.SKYHOST_COOKIE_DOMAIN ? { domain: cfg.SKYHOST_COOKIE_DOMAIN } : {}),
  };
}

export async function createSession(req: FastifyRequest, reply: FastifyReply, user: User, extra: { impersonatorId?: string; impersonationReason?: string; deviceId?: string | null; ttlHours?: number } = {}) {
  const token = randomToken(32);
  const ttlMs = (extra.ttlHours ?? SESSION_DAYS * 24) * 3600 * 1000;
  const [s] = await getDb()
    .insert(sessions)
    .values({
      userId: user.id,
      tokenHash: sha256(token),
      userAgent: req.headers["user-agent"]?.slice(0, 300) ?? null,
      ip: clientIp(req),
      deviceId: extra.deviceId ?? null,
      impersonatorId: extra.impersonatorId ?? null,
      impersonationReason: extra.impersonationReason ?? null,
      expiresAt: new Date(Date.now() + ttlMs),
    })
    .returning();
  reply.setCookie(SESSION_COOKIE, token, cookieOpts(true, ttlMs / 1000));
  reply.setCookie(CSRF_COOKIE, randomToken(18), cookieOpts(false, ttlMs / 1000));
  return s!;
}

export function clearSessionCookies(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
  reply.clearCookie(CSRF_COOKIE, { path: "/" });
}

export function generateApiKey() {
  const prefix = randomToken(6).replace(/[-_]/g, "x").slice(0, 8);
  const secret = randomToken(24);
  return { prefix, full: `sky_${prefix}_${secret}` };
}

async function authenticate(req: FastifyRequest): Promise<AuthContext> {
  const db = getDb();
  const authz = req.headers.authorization;
  if (authz?.startsWith("Bearer ")) {
    const token = authz.slice(7).trim();
    const m = /^sky_([A-Za-z0-9]{8})_[A-Za-z0-9_-]{20,}$/.exec(token);
    if (!m) return { user: null, session: null, apiKey: null };
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.prefix, m[1]!));
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < new Date()) || !safeEqual(key.keyHash, sha256(token))) {
      return { user: null, session: null, apiKey: null };
    }
    const [user] = await db.select().from(users).where(and(eq(users.id, key.userId), isNull(users.deletedAt)));
    if (!user || user.suspendedAt) return { user: null, session: null, apiKey: null };
    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
      await db.update(apiKeys).set({ lastUsedAt: new Date(), lastUsedIp: clientIp(req) }).where(eq(apiKeys.id, key.id));
    }
    return { user, session: null, apiKey: key };
  }
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return { user: null, session: null, apiKey: null };
  const [s] = await db.select().from(sessions).where(eq(sessions.tokenHash, sha256(token)));
  if (!s || s.revokedAt || s.expiresAt < new Date()) return { user: null, session: null, apiKey: null };
  const [user] = await db.select().from(users).where(and(eq(users.id, s.userId), isNull(users.deletedAt)));
  if (!user || (user.suspendedAt && !s.impersonatorId)) return { user: null, session: null, apiKey: null };
  if (Date.now() - s.lastSeenAt.getTime() > 5 * 60_000) {
    await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, s.id));
  }
  return { user, session: s, apiKey: null };
}

export function registerAuth(app: FastifyInstance) {
  app.decorateRequest("auth", null as unknown as AuthContext);
  app.addHook("onRequest", async (req, reply) => {
    req.auth = await authenticate(req);
    // CSRF: cookie-authenticated state-changing requests must echo the CSRF cookie in a header.
    if (req.auth.session && !SAFE_METHODS.has(req.method) && !req.routeOptions.config?.public) {
      const header = req.headers["x-csrf-token"];
      const cookie = req.cookies[CSRF_COOKIE];
      if (!cookie || typeof header !== "string" || !safeEqual(header, cookie)) {
        return reply.code(403).send({ error: { code: "csrf", message: "Invalid or missing CSRF token" } });
      }
    }
  });
}
