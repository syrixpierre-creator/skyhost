import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import {
  apiKeys, auditLogs, getDb, notifications, oauthAccounts, projects, recoveryCodes, sessions, teamMembers, teams, users,
} from "@skyhost/db";
import { createApiKeySchema, nameSchema, passwordSchema, EVENT_TYPES } from "@skyhost/shared";
import { decrypt, encrypt, randomId, sha256 } from "@skyhost/shared/node";
import { audit, badRequest, conflict, EMAIL_BY_DEFAULT, forbidden, notFound, unauthorized } from "@skyhost/core";
import { actorOf, generateApiKey, sessionCookie } from "../lib/auth";
import { teamAccess } from "../lib/authz";
import { idParam, route } from "../lib/http";
import { hashPassword, verifyPassword } from "../lib/password";
import { publicUser } from "./auth";

function apiKeyView(k: typeof apiKeys.$inferSelect) {
  return {
    id: k.id,
    name: k.name,
    prefix: `sky_${k.prefix}_…`,
    teamId: k.teamId,
    scopes: k.scopes,
    projectId: k.projectId,
    serviceId: k.serviceId,
    expiresAt: k.expiresAt,
    lastUsedAt: k.lastUsedAt,
    lastUsedIp: k.lastUsedIp,
    revokedAt: k.revokedAt,
    createdAt: k.createdAt,
  };
}

async function generateRecoveryCodes(userId: string) {
  const db = getDb();
  await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  const codes = Array.from({ length: 10 }, () => `${randomId(5)}-${randomId(5)}`);
  await db.insert(recoveryCodes).values(codes.map((c) => ({ userId, codeHash: sha256(c) })));
  return codes;
}

export default async function accountRoutes(app: FastifyInstance) {
  route(
    app,
    { method: "PATCH", url: "/account", tags: ["account"], body: z.object({ name: nameSchema.optional(), locale: z.enum(["en", "fr"]).optional(), avatarUrl: z.string().url().max(500).nullable().optional() }) },
    async (req, _r, { body }) => {
      const [u] = await getDb().update(users).set({ ...body, updatedAt: new Date() }).where(eq(users.id, req.auth.user!.id)).returning();
      return { user: publicUser(u!) };
    },
  );

  route(app, { method: "POST", url: "/account/password", tags: ["account"], body: z.object({ currentPassword: z.string().max(200).optional(), newPassword: passwordSchema }) }, async (req, _r, { body }) => {
    const u = req.auth.user!;
    if (u.passwordHash && !(await verifyPassword(u.passwordHash, body.currentPassword ?? ""))) throw unauthorized("Current password is incorrect");
    await getDb().update(users).set({ passwordHash: await hashPassword(body.newPassword) }).where(eq(users.id, u.id));
    // Sign out other devices
    await getDb().update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, u.id), isNull(sessions.revokedAt), req.auth.session ? ne(sessions.id, req.auth.session.id) : undefined));
    await audit(actorOf(req), null, "account.password_changed", { type: "user", id: u.id });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------------- 2FA (TOTP)
  route(app, { method: "POST", url: "/account/2fa/setup", tags: ["account"] }, async (req) => {
    const u = req.auth.user!;
    if (u.totpEnabledAt) throw conflict("Two-factor authentication is already enabled");
    const secret = authenticator.generateSecret(20);
    await getDb().update(users).set({ totpSecretEnc: encrypt(secret) }).where(eq(users.id, u.id));
    const otpauth = authenticator.keyuri(u.email, "SKYHOST", secret);
    return { secret, otpauth, qrDataUrl: await QRCode.toDataURL(otpauth, { margin: 1, width: 220 }) };
  });

  route(app, { method: "POST", url: "/account/2fa/enable", tags: ["account"], body: z.object({ code: z.string().regex(/^\d{6}$/) }) }, async (req, _r, { body }) => {
    const db = getDb();
    const [u] = await db.select().from(users).where(eq(users.id, req.auth.user!.id));
    if (!u?.totpSecretEnc) throw badRequest("Start the 2FA setup first");
    if (u.totpEnabledAt) throw conflict("Two-factor authentication is already enabled");
    if (!authenticator.check(body.code, decrypt(u.totpSecretEnc))) throw badRequest("Invalid code, check your authenticator app clock");
    await db.update(users).set({ totpEnabledAt: new Date() }).where(eq(users.id, u.id));
    const codes = await generateRecoveryCodes(u.id);
    await audit(actorOf(req), null, "account.2fa_enabled", { type: "user", id: u.id });
    return { recoveryCodes: codes };
  });

  route(app, { method: "POST", url: "/account/2fa/disable", tags: ["account"], body: z.object({ password: z.string().max(200).optional(), code: z.string().max(32) }) }, async (req, _r, { body }) => {
    const db = getDb();
    const [u] = await db.select().from(users).where(eq(users.id, req.auth.user!.id));
    if (!u?.totpEnabledAt || !u.totpSecretEnc) throw badRequest("Two-factor authentication is not enabled");
    if (u.passwordHash && !(await verifyPassword(u.passwordHash, body.password ?? ""))) throw unauthorized("Password is incorrect");
    if (!authenticator.check(body.code, decrypt(u.totpSecretEnc))) throw badRequest("Invalid code");
    await db.update(users).set({ totpEnabledAt: null, totpSecretEnc: null }).where(eq(users.id, u.id));
    await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, u.id));
    await audit(actorOf(req), null, "account.2fa_disabled", { type: "user", id: u.id });
    return { ok: true };
  });

  route(app, { method: "POST", url: "/account/2fa/recovery-codes", tags: ["account"], body: z.object({ code: z.string().regex(/^\d{6}$/) }) }, async (req, _r, { body }) => {
    const [u] = await getDb().select().from(users).where(eq(users.id, req.auth.user!.id));
    if (!u?.totpEnabledAt || !u.totpSecretEnc) throw badRequest("Two-factor authentication is not enabled");
    if (!authenticator.check(body.code, decrypt(u.totpSecretEnc))) throw badRequest("Invalid code");
    const codes = await generateRecoveryCodes(u.id);
    await audit(actorOf(req), null, "account.recovery_codes_regenerated", { type: "user", id: u.id });
    return { recoveryCodes: codes };
  });

  // ---------------------------------------------------------------------------------- Sessions / devices
  route(app, { method: "GET", url: "/account/sessions", tags: ["account"] }, async (req) => {
    const rows = await getDb().select().from(sessions).where(and(eq(sessions.userId, req.auth.user!.id), isNull(sessions.revokedAt))).orderBy(desc(sessions.lastSeenAt));
    return {
      sessions: rows
        .filter((s) => s.expiresAt > new Date())
        .map((s) => ({ id: s.id, userAgent: s.userAgent, ip: s.ip, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.id === req.auth.session?.id, impersonation: !!s.impersonatorId })),
    };
  });

  route(app, { method: "DELETE", url: "/account/sessions/:id", tags: ["account"], params: idParam }, async (req, _r, { params }) => {
    const res = await getDb().update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.id, params.id), eq(sessions.userId, req.auth.user!.id))).returning();
    if (!res.length) throw notFound("Session");
    await audit(actorOf(req), null, "account.session_revoked", { type: "session", id: params.id });
    return { ok: true };
  });

  route(app, { method: "POST", url: "/account/sessions/revoke-others", tags: ["account"] }, async (req) => {
    await getDb()
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, req.auth.user!.id), isNull(sessions.revokedAt), req.auth.session ? ne(sessions.id, req.auth.session.id) : undefined));
    return { ok: true };
  });

  // ---------------------------------------------------------------------------------- API keys
  route(app, { method: "GET", url: "/api-keys", tags: ["api-keys"], query: z.object({ teamId: z.string().uuid().optional() }) }, async (req, _r, { query }) => {
    const rows = await getDb()
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, req.auth.user!.id), query.teamId ? eq(apiKeys.teamId, query.teamId) : undefined))
      .orderBy(desc(apiKeys.createdAt));
    return { apiKeys: rows.map(apiKeyView) };
  });

  route(app, { method: "POST", url: "/api-keys", tags: ["api-keys"], body: createApiKeySchema }, async (req, reply, { body }) => {
    if (req.auth.apiKey) throw forbidden("API keys cannot create other API keys");
    const access = await teamAccess(req, body.teamId, "apikey:manage");
    const db = getDb();
    if (body.projectId) {
      const [p] = await db.select().from(projects).where(and(eq(projects.id, body.projectId), eq(projects.teamId, body.teamId)));
      if (!p) throw badRequest("Unknown project");
    }
    // A key never exceeds its creator's role: viewers/members can only create read or deploy keys.
    if (body.scopes.includes("admin") && !["owner", "admin"].includes(access.role)) throw forbidden("Only owners and admins can create admin keys");
    if (body.scopes.includes("write") && !["owner", "admin", "developer"].includes(access.role)) throw forbidden("Your role cannot create write keys");
    const key = generateApiKey();
    const [k] = await db
      .insert(apiKeys)
      .values({
        userId: req.auth.user!.id,
        teamId: body.teamId,
        name: body.name,
        prefix: key.prefix,
        keyHash: sha256(key.full),
        scopes: body.scopes,
        projectId: body.projectId ?? null,
        serviceId: body.serviceId ?? null,
        expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400_000) : null,
      })
      .returning();
    await audit(actorOf(req), body.teamId, "apikey.create", { type: "api_key", id: k!.id }, { name: body.name, scopes: body.scopes });
    reply.code(201);
    // The secret is shown exactly once; only its hash is stored.
    return { apiKey: apiKeyView(k!), secret: key.full };
  });

  route(app, { method: "POST", url: "/api-keys/:id/revoke", tags: ["api-keys"], params: idParam }, async (req, _r, { params }) => {
    const res = await getDb().update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.id, params.id), eq(apiKeys.userId, req.auth.user!.id), isNull(apiKeys.revokedAt))).returning();
    if (!res.length) throw notFound("API key");
    await audit(actorOf(req), res[0]!.teamId, "apikey.revoke", { type: "api_key", id: params.id });
    return { ok: true };
  });

  route(app, { method: "POST", url: "/api-keys/:id/rotate", tags: ["api-keys"], params: idParam }, async (req, _r, { params }) => {
    if (req.auth.apiKey) throw forbidden("API keys cannot rotate API keys");
    const db = getDb();
    const [old] = await db.select().from(apiKeys).where(and(eq(apiKeys.id, params.id), eq(apiKeys.userId, req.auth.user!.id), isNull(apiKeys.revokedAt)));
    if (!old) throw notFound("API key");
    await teamAccess(req, old.teamId, "apikey:manage");
    const key = generateApiKey();
    const [k] = await db
      .insert(apiKeys)
      .values({ userId: old.userId, teamId: old.teamId, name: old.name, prefix: key.prefix, keyHash: sha256(key.full), scopes: old.scopes, projectId: old.projectId, serviceId: old.serviceId, expiresAt: old.expiresAt, rotatedFromId: old.id })
      .returning();
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, old.id));
    await audit(actorOf(req), old.teamId, "apikey.rotate", { type: "api_key", id: k!.id }, { from: old.id });
    return { apiKey: apiKeyView(k!), secret: key.full };
  });

  // ---------------------------------------------------------------------------------- Notification preferences
  route(app, { method: "GET", url: "/account/notification-preferences", tags: ["account"] }, async (req) => ({ events: EVENT_TYPES, emailDefaults: EMAIL_BY_DEFAULT, preferences: req.auth.user!.notificationPrefs }));

  route(
    app,
    {
      method: "PUT",
      url: "/account/notification-preferences",
      tags: ["account"],
      body: z.object({
        preferences: z.record(z.union([z.object({ email: z.boolean().optional(), web: z.boolean().optional() }), z.object({ start: z.string(), end: z.string(), timezone: z.string() }).nullable()])),
      }),
    },
    async (req, _r, { body }) => {
      await getDb().update(users).set({ notificationPrefs: body.preferences }).where(eq(users.id, req.auth.user!.id));
      return { ok: true };
    },
  );

  route(
    app,
    { method: "PUT", url: "/account/payout", tags: ["referrals"], body: z.object({ method: z.enum(["stripe_connect", "paypal"]), accountId: z.string().max(100).optional(), email: z.string().email().optional() }) },
    async (req, _r, { body }) => {
      if (body.method === "paypal" && !body.email) throw badRequest("PayPal payouts need an email");
      if (body.method === "stripe_connect" && !/^acct_[A-Za-z0-9]+$/.test(body.accountId ?? "")) throw badRequest("Enter your Stripe Connect account id (acct_...)");
      await getDb().update(users).set({ payoutDetails: body }).where(eq(users.id, req.auth.user!.id));
      await audit(actorOf(req), null, "referral.payout_details_updated", { type: "user", id: req.auth.user!.id }, { method: body.method });
      return { ok: true };
    },
  );

  // ---------------------------------------------------------------------------------- GDPR
  route(app, { method: "GET", url: "/account/export", tags: ["account"] }, async (req, reply) => {
    const db = getDb();
    const u = req.auth.user!;
    const memberships = await db.select({ team: teams, role: teamMembers.role }).from(teamMembers).innerJoin(teams, eq(teams.id, teamMembers.teamId)).where(eq(teamMembers.userId, u.id));
    const data = {
      exportedAt: new Date().toISOString(),
      user: publicUser(u),
      teams: memberships.map((m) => ({ id: m.team.id, name: m.team.name, role: m.role })),
      sessions: await db.select({ createdAt: sessions.createdAt, ip: sessions.ip, userAgent: sessions.userAgent }).from(sessions).where(eq(sessions.userId, u.id)),
      apiKeys: (await db.select().from(apiKeys).where(eq(apiKeys.userId, u.id))).map(apiKeyView),
      connectedAccounts: await db.select({ provider: oauthAccounts.provider, username: oauthAccounts.username }).from(oauthAccounts).where(eq(oauthAccounts.userId, u.id)),
      notifications: await db.select().from(notifications).where(eq(notifications.userId, u.id)).limit(1000),
      auditLog: await db.select().from(auditLogs).where(eq(auditLogs.actorUserId, u.id)).orderBy(desc(auditLogs.createdAt)).limit(5000),
    };
    await audit(actorOf(req), null, "account.data_exported", { type: "user", id: u.id });
    reply.header("Content-Disposition", `attachment; filename="skyhost-export-${u.id}.json"`);
    return data;
  });

  route(app, { method: "DELETE", url: "/account", tags: ["account"], body: z.object({ password: z.string().max(200).optional(), confirm: z.literal("DELETE") }) }, async (req, reply, { body }) => {
    const db = getDb();
    const u = req.auth.user!;
    if (u.passwordHash && !(await verifyPassword(u.passwordHash, body.password ?? ""))) throw unauthorized("Password is incorrect");
    const owned = await db.select().from(teams).where(and(eq(teams.ownerId, u.id), isNull(teams.deletedAt)));
    const blocking = [];
    for (const t of owned) {
      const others = await db.select().from(teamMembers).where(and(eq(teamMembers.teamId, t.id), ne(teamMembers.userId, u.id)));
      const live = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.teamId, t.id), isNull(projects.deletedAt)));
      if (others.length || (!t.personal && live.length) || (t.personal && live.length)) blocking.push(t.name);
    }
    if (blocking.length) throw conflict(`Transfer or delete these teams first: ${blocking.join(", ")}`);
    // Anonymize personal data; billing and audit records are retained as required by law.
    await db.update(users).set({ email: `deleted-${u.id}@deleted.invalid`, name: "Deleted user", passwordHash: null, totpSecretEnc: null, avatarUrl: null, payoutDetails: null, deletedAt: new Date() }).where(eq(users.id, u.id));
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.userId, u.id));
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.userId, u.id));
    await db.delete(oauthAccounts).where(eq(oauthAccounts.userId, u.id));
    if (owned.length) await db.update(teams).set({ deletedAt: new Date() }).where(inArray(teams.id, owned.map((t) => t.id)));
    await audit(actorOf(req), null, "account.deleted", { type: "user", id: u.id });
    reply.clearCookie(sessionCookie(), { path: "/" });
    return { ok: true };
  });
}
