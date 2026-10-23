import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, count, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { authenticator } from "otplib";
import { apiKeys, cliAuthRequests, emailTokens, getDb, oauthAccounts, plans, recoveryCodes, sessions, teamMembers, teams, users } from "@skyhost/db";
import { emailSchema, loginSchema, passwordSchema, signupSchema, slugify } from "@skyhost/shared";
import { decrypt, encrypt, randomId, randomToken, sha256 } from "@skyhost/shared/node";
import { attachReferral, audit, badRequest, conflict, dashboardClosed, forbidden, getSetting, redis, renderEmail, sendMail, serverConfig, tooMany, unauthorized, unavailable, capabilities } from "@skyhost/core";
import { actorOf, clearSessionCookies, clientIp, createSession, generateApiKey, secureCookies, type User } from "../lib/auth";
import { route } from "../lib/http";
import { hashPassword, verifyPassword } from "../lib/password";

authenticator.options = { window: 1 };

const AUTH_RL = { max: 20, timeWindow: "1 minute" };

export async function uniqueTeamSlug(base: string): Promise<string> {
  const db = getDb();
  const root = slugify(base, 32);
  for (let i = 0; i < 20; i++) {
    const slug = i === 0 ? root : `${root}-${randomId(4)}`;
    const [t] = await db.select({ id: teams.id }).from(teams).where(eq(teams.slug, slug));
    if (!t) return slug;
  }
  return `${root}-${randomId(8)}`;
}

/** Creates the user's personal team on the default (trial) plan. */
export async function createPersonalTeam(user: { id: string; name: string; email: string }) {
  const db = getDb();
  const trial = (await getSetting("billing")).trialPlan;
  const [plan] = await db.select().from(plans).where(eq(plans.slug, trial));
  const [team] = await db
    .insert(teams)
    .values({ name: `${user.name.split(" ")[0]}'s team`, slug: await uniqueTeamSlug(user.name || user.email.split("@")[0]!), ownerId: user.id, personal: true, planId: plan?.id ?? null, billingEmail: user.email, billingStatus: plan?.isFree ? "trialing" : "none" })
    .returning();
  await db.insert(teamMembers).values({ teamId: team!.id, userId: user.id, role: "owner" });
  return team!;
}

async function sendVerification(user: { id: string; email: string; name: string }) {
  const token = randomToken(32);
  await getDb().insert(emailTokens).values({ userId: user.id, type: "verify", tokenHash: sha256(token), expiresAt: new Date(Date.now() + 24 * 3600 * 1000) });
  const url = `${serverConfig().SKYHOST_DASHBOARD_URL}/verify-email?token=${token}`;
  const { text, html } = renderEmail("Verify your email address", [`Hi ${user.name}, confirm your email to start deploying on SKYHOST. The link expires in 24 hours.`], { label: "Verify email", url });
  await sendMail({ to: user.email, subject: "Verify your SKYHOST email", text, html });
}

async function uniqueReferralCode() {
  for (;;) {
    const code = randomId(8);
    const [u] = await getDb().select({ id: users.id }).from(users).where(eq(users.referralCode, code));
    if (!u) return code;
  }
}

export async function createUser(o: { email: string; name: string; passwordHash: string | null; verified: boolean; ip: string | null; deviceId?: string | null }) {
  const db = getDb();
  const [{ c } = { c: 0 }] = await db.select({ c: count() }).from(users);
  const [user] = await db
    .insert(users)
    .values({
      email: o.email,
      name: o.name,
      passwordHash: o.passwordHash,
      emailVerifiedAt: o.verified ? new Date() : null,
      referralCode: await uniqueReferralCode(),
      // The first account of a self-hosted install becomes the platform administrator.
      isAdmin: Number(c) === 0,
      tosAcceptedAt: new Date(),
      signupIp: o.ip,
      signupDeviceId: o.deviceId ?? null,
    })
    .returning();
  await createPersonalTeam(user!);
  return user!;
}

function lockoutMinutes(failures: number) {
  // 5 failures -> 1 min, then doubling up to one hour.
  if (failures < 5) return 0;
  return Math.min(60, 2 ** (failures - 5));
}

function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    avatarUrl: u.avatarUrl,
    locale: u.locale,
    emailVerified: !!u.emailVerifiedAt,
    twoFactorEnabled: !!u.totpEnabledAt,
    isAdmin: u.isAdmin,
    referralCode: u.referralCode,
    createdAt: u.createdAt,
  };
}
export { publicUser };

/** While the dashboard is closed for maintenance, only administrators may sign in or sign up. */
export const maintenanceMessage = (m: { message: string }) => `SKYHOST is under maintenance.${m.message ? ` ${m.message}` : ""} Please come back later.`;
async function assertOpenFor(user: Pick<User, "isAdmin">) {
  const closed = await dashboardClosed();
  if (closed && !user.isAdmin) throw unavailable(maintenanceMessage(closed));
}

async function finishLogin(req: FastifyRequest, reply: FastifyReply, user: User, method: string, deviceId?: string | null) {
  await assertOpenFor(user);
  await getDb().update(users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await createSession(req, reply, user, { deviceId });
  await audit({ userId: user.id, ip: clientIp(req), userAgent: req.headers["user-agent"] }, null, "auth.login", { type: "user", id: user.id }, { method });
  return { user: publicUser(user) };
}

async function twoFactorChallenge(user: User) {
  const challenge = randomToken(24);
  await redis().set(`sh:2fa:${sha256(challenge)}`, user.id, "EX", 300);
  return { twoFactorRequired: true, challenge };
}

export default async function authRoutes(app: FastifyInstance) {
  route(app, { method: "POST", url: "/auth/signup", public: true, tags: ["auth"], body: signupSchema, rateLimit: { max: 10, timeWindow: "1 hour" } }, async (req, reply, { body }) => {
    const db = getDb();
    const signup = await getSetting("signup");
    if (!signup.enabled) throw forbidden("Sign ups are currently closed");
    // The very first account (the platform administrator) can always be created.
    const closed = await dashboardClosed();
    if (closed && (await db.select({ id: users.id }).from(users).limit(1)).length) throw unavailable(maintenanceMessage(closed));
    const ip = clientIp(req);
    const ipKey = `sh:signup:ip:${sha256(ip)}`;
    const n = await redis().incr(ipKey);
    if (n === 1) await redis().expire(ipKey, 24 * 3600);
    if (n > signup.maxAccountsPerIpPerDay) throw tooMany("Too many accounts created from this network today");
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email));
    if (existing) throw conflict("An account with this email already exists");
    const user = await createUser({ email: body.email, name: body.name, passwordHash: await hashPassword(body.password), verified: false, ip, deviceId: body.deviceId });
    const code = body.referralCode ?? req.cookies.sh_ref;
    if (code) await attachReferral(user, code, ip, body.deviceId ?? null).catch(() => null);
    await sendVerification(user);
    await createSession(req, reply, user, { deviceId: body.deviceId });
    await audit({ userId: user.id, ip, userAgent: req.headers["user-agent"] }, null, "auth.signup", { type: "user", id: user.id });
    reply.code(201);
    return { user: publicUser(user) };
  });

  route(app, { method: "POST", url: "/auth/login", public: true, tags: ["auth"], body: loginSchema, rateLimit: AUTH_RL }, async (req, reply, { body }) => {
    const db = getDb();
    const [user] = await db.select().from(users).where(and(eq(users.email, body.email), isNull(users.deletedAt)));
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      throw tooMany(`Too many failed attempts. Try again in ${Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000)} minute(s).`);
    }
    const ok = await verifyPassword(user?.passwordHash, body.password);
    if (!user || !ok) {
      if (user) {
        const failures = user.failedLoginCount + 1;
        const lock = lockoutMinutes(failures);
        await db.update(users).set({ failedLoginCount: failures, lockedUntil: lock ? new Date(Date.now() + lock * 60000) : null }).where(eq(users.id, user.id));
        await audit({ userId: user.id, ip: clientIp(req) }, null, "auth.login_failed", { type: "user", id: user.id }, { failures });
      }
      throw unauthorized("Invalid email or password");
    }
    if (user.suspendedAt) throw forbidden("This account is suspended. Contact support.");
    if (user.totpEnabledAt) return twoFactorChallenge(user);
    return finishLogin(req, reply, user, "password", body.deviceId);
  });

  route(
    app,
    { method: "POST", url: "/auth/2fa/login", public: true, tags: ["auth"], body: z.object({ challenge: z.string().min(10), code: z.string().max(32), deviceId: z.string().max(128).optional() }), rateLimit: AUTH_RL },
    async (req, reply, { body }) => {
      const db = getDb();
      const key = `sh:2fa:${sha256(body.challenge)}`;
      const userId = await redis().get(key);
      if (!userId) throw unauthorized("The login challenge expired. Sign in again.");
      const attempts = await redis().incr(`${key}:n`);
      await redis().expire(`${key}:n`, 300);
      if (attempts > 5) {
        await redis().del(key);
        throw tooMany("Too many invalid codes. Sign in again.");
      }
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      if (!user?.totpSecretEnc) throw unauthorized();
      const code = body.code.replace(/\s/g, "");
      let ok = /^\d{6}$/.test(code) && authenticator.check(code, decrypt(user.totpSecretEnc));
      let method = "totp";
      if (!ok) {
        // Recovery codes are single use.
        const [rc] = await db.select().from(recoveryCodes).where(and(eq(recoveryCodes.userId, user.id), eq(recoveryCodes.codeHash, sha256(code.toLowerCase())), isNull(recoveryCodes.usedAt)));
        if (rc) {
          await db.update(recoveryCodes).set({ usedAt: new Date() }).where(eq(recoveryCodes.id, rc.id));
          ok = true;
          method = "recovery_code";
        }
      }
      if (!ok) throw unauthorized("Invalid code");
      await redis().del(key);
      return finishLogin(req, reply, user, method, body.deviceId);
    },
  );

  route(app, { method: "POST", url: "/auth/logout", tags: ["auth"] }, async (req, reply) => {
    if (req.auth.session) await getDb().update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, req.auth.session.id));
    clearSessionCookies(reply);
    await audit(actorOf(req), null, "auth.logout", { type: "user", id: req.auth.user!.id });
    return { ok: true };
  });

  route(app, { method: "GET", url: "/auth/me", tags: ["auth"] }, async (req) => {
    const u = req.auth.user!;
    const s = req.auth.session;
    return { user: publicUser(u), impersonating: s?.impersonatorId ? { by: s.impersonatorId, reason: s.impersonationReason } : null, apiKey: req.auth.apiKey ? { id: req.auth.apiKey.id, teamId: req.auth.apiKey.teamId, scopes: req.auth.apiKey.scopes } : null };
  });

  route(app, { method: "POST", url: "/auth/verify-email", public: true, tags: ["auth"], body: z.object({ token: z.string().min(10).max(200) }), rateLimit: AUTH_RL }, async (_req, _reply, { body }) => {
    const db = getDb();
    const [t] = await db.select().from(emailTokens).where(and(eq(emailTokens.tokenHash, sha256(body.token)), eq(emailTokens.type, "verify"), isNull(emailTokens.usedAt), gt(emailTokens.expiresAt, new Date())));
    if (!t) throw badRequest("This verification link is invalid or expired");
    await db.update(emailTokens).set({ usedAt: new Date() }).where(eq(emailTokens.id, t.id));
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, t.userId));
    await audit({ userId: t.userId }, null, "auth.email_verified", { type: "user", id: t.userId });
    return { ok: true };
  });

  route(app, { method: "POST", url: "/auth/resend-verification", tags: ["auth"], rateLimit: { max: 3, timeWindow: "10 minutes" } }, async (req) => {
    const u = req.auth.user!;
    if (u.emailVerifiedAt) return { ok: true, alreadyVerified: true };
    await sendVerification(u);
    return { ok: true };
  });

  route(app, { method: "POST", url: "/auth/forgot-password", public: true, tags: ["auth"], body: z.object({ email: emailSchema }), rateLimit: { max: 5, timeWindow: "15 minutes" } }, async (_req, _reply, { body }) => {
    const db = getDb();
    const [u] = await db.select().from(users).where(and(eq(users.email, body.email), isNull(users.deletedAt)));
    // Same response whether the account exists or not.
    if (u) {
      const token = randomToken(32);
      await db.insert(emailTokens).values({ userId: u.id, type: "reset", tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600 * 1000) });
      const url = `${serverConfig().SKYHOST_DASHBOARD_URL}/reset-password?token=${token}`;
      const { text, html } = renderEmail("Reset your password", ["Someone asked to reset the password of your SKYHOST account. If it was not you, ignore this email. The link expires in one hour."], { label: "Choose a new password", url });
      await sendMail({ to: u.email, subject: "Reset your SKYHOST password", text, html });
    }
    return { ok: true };
  });

  route(app, { method: "POST", url: "/auth/reset-password", public: true, tags: ["auth"], body: z.object({ token: z.string().min(10).max(200), password: passwordSchema }), rateLimit: AUTH_RL }, async (req, _reply, { body }) => {
    const db = getDb();
    const [t] = await db.select().from(emailTokens).where(and(eq(emailTokens.tokenHash, sha256(body.token)), eq(emailTokens.type, "reset"), isNull(emailTokens.usedAt), gt(emailTokens.expiresAt, new Date())));
    if (!t) throw badRequest("This reset link is invalid or expired");
    await db.update(emailTokens).set({ usedAt: new Date() }).where(eq(emailTokens.id, t.id));
    await db.update(users).set({ passwordHash: await hashPassword(body.password), failedLoginCount: 0, lockedUntil: null, emailVerifiedAt: new Date() }).where(eq(users.id, t.userId));
    // A password reset signs out every device.
    await db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, t.userId), isNull(sessions.revokedAt)));
    await audit({ userId: t.userId, ip: clientIp(req) }, null, "auth.password_reset", { type: "user", id: t.userId });
    return { ok: true };
  });

  // ------------------------------------------------------------------------------------------- OAuth login

  const OAUTH = {
    google: {
      enabled: () => !!(serverConfig().GOOGLE_CLIENT_ID && serverConfig().GOOGLE_CLIENT_SECRET),
      authorize: (state: string, redirect: string) =>
        `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: serverConfig().GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: "code", scope: "openid email profile", state, prompt: "select_account" })}`,
      async exchange(code: string, redirect: string) {
        const c = serverConfig();
        const res = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ code, client_id: c.GOOGLE_CLIENT_ID, client_secret: c.GOOGLE_CLIENT_SECRET, redirect_uri: redirect, grant_type: "authorization_code" }),
        });
        const tok = (await res.json()) as { access_token?: string; error_description?: string };
        if (!tok.access_token) throw badRequest(tok.error_description ?? "Google authorization failed");
        const me = (await (await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } })).json()) as { sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string };
        if (!me.sub) throw badRequest("Google did not return a profile");
        return { id: me.sub, username: me.email ?? me.sub, name: me.name || me.email || "Google user", avatarUrl: me.picture ?? null, email: me.email?.toLowerCase() ?? null, emailVerified: me.email_verified === true, token: tok.access_token };
      },
    },
    github: {
      enabled: () => !!(serverConfig().GITHUB_CLIENT_ID && serverConfig().GITHUB_CLIENT_SECRET),
      authorize: (state: string, redirect: string) =>
        `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: serverConfig().GITHUB_CLIENT_ID, redirect_uri: redirect, scope: "read:user user:email", state, allow_signup: "true" })}`,
      async exchange(code: string, redirect: string) {
        const c = serverConfig();
        const res = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: c.GITHUB_CLIENT_ID, client_secret: c.GITHUB_CLIENT_SECRET, code, redirect_uri: redirect }),
        });
        const tok = (await res.json()) as { access_token?: string; error_description?: string };
        if (!tok.access_token) throw badRequest(tok.error_description ?? "GitHub authorization failed");
        const h = { Authorization: `Bearer ${tok.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "SKYHOST" };
        const me = (await (await fetch("https://api.github.com/user", { headers: h })).json()) as { id: number; login: string; name?: string; avatar_url?: string };
        const emails = (await (await fetch("https://api.github.com/user/emails", { headers: h })).json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
        const primary = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) : undefined;
        return { id: String(me.id), username: me.login, name: me.name || me.login, avatarUrl: me.avatar_url ?? null, email: primary?.email?.toLowerCase() ?? null, emailVerified: !!primary, token: tok.access_token };
      },
    },
    gitlab: {
      enabled: () => !!(serverConfig().GITLAB_CLIENT_ID && serverConfig().GITLAB_CLIENT_SECRET),
      authorize: (state: string, redirect: string) =>
        `${serverConfig().GITLAB_URL}/oauth/authorize?${new URLSearchParams({ client_id: serverConfig().GITLAB_CLIENT_ID, redirect_uri: redirect, response_type: "code", scope: "read_user", state })}`,
      async exchange(code: string, redirect: string) {
        const c = serverConfig();
        const res = await fetch(`${c.GITLAB_URL}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: c.GITLAB_CLIENT_ID, client_secret: c.GITLAB_CLIENT_SECRET, code, grant_type: "authorization_code", redirect_uri: redirect }),
        });
        const tok = (await res.json()) as { access_token?: string; error_description?: string };
        if (!tok.access_token) throw badRequest(tok.error_description ?? "GitLab authorization failed");
        const me = (await (await fetch(`${c.GITLAB_URL}/api/v4/user`, { headers: { Authorization: `Bearer ${tok.access_token}` } })).json()) as { id: number; username: string; name: string; email?: string; avatar_url?: string; confirmed_at?: string };
        return { id: String(me.id), username: me.username, name: me.name, avatarUrl: me.avatar_url ?? null, email: me.email?.toLowerCase() ?? null, emailVerified: !!me.confirmed_at, token: tok.access_token };
      },
    },
  } as const;

  const callbackUrl = (p: string) => `${serverConfig().SKYHOST_API_URL}/api/v1/auth/oauth/${p}/callback`;

  app.get("/auth/oauth/:provider/start", { config: { public: true, rateLimit: AUTH_RL } }, async (req, reply) => {
    const provider = (req.params as { provider: string }).provider as keyof typeof OAUTH;
    const p = OAUTH[provider];
    // Not configured: back to the sign-in page with a clear message instead of an API error.
    if (!p?.enabled()) return reply.redirect(`${serverConfig().SKYHOST_DASHBOARD_URL}/login?error=${encodeURIComponent("This sign-in method is not available yet on this SKYHOST installation.")}`);
    const state = randomToken(24);
    const ref = (req.query as { ref?: string }).ref;
    await redis().set(`sh:oauth:${state}`, JSON.stringify({ provider, ref: ref?.slice(0, 32) }), "EX", 600);
    reply.setCookie("sh_oauth_state", state, { path: "/", httpOnly: true, sameSite: "lax", secure: secureCookies(), maxAge: 600 });
    return reply.redirect(p.authorize(state, callbackUrl(provider)));
  });

  app.get("/auth/oauth/:provider/callback", { config: { public: true, rateLimit: AUTH_RL } }, async (req, reply) => {
    const dash = serverConfig().SKYHOST_DASHBOARD_URL;
    const provider = (req.params as { provider: string }).provider as keyof typeof OAUTH;
    const { code, state } = req.query as { code?: string; state?: string };
    const fail = (msg: string) => reply.redirect(`${dash}/login?error=${encodeURIComponent(msg)}`);
    const p = OAUTH[provider];
    if (!p?.enabled() || !code || !state || state !== req.cookies.sh_oauth_state) return fail("OAuth state mismatch, please retry");
    const saved = await redis().getdel(`sh:oauth:${state}`);
    if (!saved) return fail("OAuth session expired, please retry");
    const { ref } = JSON.parse(saved) as { ref?: string };
    let profile;
    try {
      profile = await p.exchange(code, callbackUrl(provider));
    } catch (e) {
      return fail((e as Error).message);
    }
    const db = getDb();
    const [link] = await db.select().from(oauthAccounts).where(and(eq(oauthAccounts.provider, provider), eq(oauthAccounts.providerUserId, profile.id)));
    let user: User | undefined;
    if (link) [user] = await db.select().from(users).where(eq(users.id, link.userId));
    if (!user && profile.email) {
      [user] = await db.select().from(users).where(eq(users.email, profile.email));
      // Only link by email when the provider confirms the address belongs to this person.
      if (user && !profile.emailVerified) return fail("Your email on this provider is not verified. Sign in with your password instead.");
    }
    const closed = await dashboardClosed();
    if (closed && !user?.isAdmin) return fail(maintenanceMessage(closed));
    if (!user) {
      if (!profile.email) return fail("Your account has no public verified email address");
      if (!(await getSetting("signup")).enabled) return fail("Sign ups are currently closed");
      user = await createUser({ email: profile.email, name: profile.name, passwordHash: null, verified: profile.emailVerified, ip: clientIp(req) });
      if (ref) await attachReferral(user, ref, clientIp(req), null).catch(() => null);
      await audit({ userId: user.id, ip: clientIp(req) }, null, "auth.signup", { type: "user", id: user.id }, { method: provider });
    }
    if (user.suspendedAt) return fail("This account is suspended");
    await db
      .insert(oauthAccounts)
      .values({ userId: user.id, provider, providerUserId: profile.id, username: profile.username, accessTokenEnc: encrypt(profile.token) })
      .onConflictDoUpdate({ target: [oauthAccounts.provider, oauthAccounts.providerUserId], set: { accessTokenEnc: encrypt(profile.token), username: profile.username, updatedAt: new Date() } });
    if (!user.avatarUrl && profile.avatarUrl) await db.update(users).set({ avatarUrl: profile.avatarUrl }).where(eq(users.id, user.id));
    reply.clearCookie("sh_oauth_state", { path: "/" });
    if (user.totpEnabledAt) {
      const { challenge } = await twoFactorChallenge(user);
      return reply.redirect(`${dash}/login?challenge=${encodeURIComponent(challenge)}`);
    }
    await finishLogin(req, reply, user, provider);
    return reply.redirect(`${dash}/`);
  });

  route(app, { method: "GET", url: "/auth/providers", public: true, tags: ["auth"] }, async () => ({
    google: OAUTH.google.enabled(),
    github: OAUTH.github.enabled(),
    gitlab: OAUTH.gitlab.enabled(),
    saml: serverConfig().SAML_ENABLED,
  }));

  /** What this installation can do; the dashboard shows "not available yet" for anything not configured. */
  route(app, { method: "GET", url: "/capabilities", public: true, tags: ["public"] }, async () => capabilities());

  // ------------------------------------------------------------------------------------------- CLI device flow

  route(app, { method: "POST", url: "/auth/cli/start", public: true, tags: ["cli"], rateLimit: { max: 10, timeWindow: "1 minute" } }, async () => {
    const deviceCode = randomToken(32);
    const userCode = `${randomId(4, "BCDFGHJKLMNPQRSTVWXZ")}-${randomId(4, "BCDFGHJKLMNPQRSTVWXZ")}`;
    await getDb().insert(cliAuthRequests).values({ codeHash: sha256(deviceCode), userCode, expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
    return { deviceCode, userCode, verificationUrl: `${serverConfig().SKYHOST_DASHBOARD_URL}/cli?code=${userCode}`, expiresIn: 600, interval: 3 };
  });

  route(app, { method: "POST", url: "/auth/cli/approve", tags: ["cli"], body: z.object({ userCode: z.string().max(16), teamId: z.string().uuid() }) }, async (req, _reply, { body }) => {
    const db = getDb();
    const user = req.auth.user!;
    if (req.auth.apiKey) throw forbidden("Approve CLI logins from the dashboard");
    const [m] = await db.select().from(teamMembers).where(and(eq(teamMembers.teamId, body.teamId), eq(teamMembers.userId, user.id)));
    if (!m) throw badRequest("Unknown team");
    const [r] = await db.select().from(cliAuthRequests).where(and(eq(cliAuthRequests.userCode, body.userCode.toUpperCase()), isNull(cliAuthRequests.approvedByUserId), gt(cliAuthRequests.expiresAt, new Date())));
    if (!r) throw badRequest("This code is invalid or expired");
    const key = generateApiKey();
    const [k] = await db
      .insert(apiKeys)
      .values({ userId: user.id, teamId: body.teamId, name: `CLI (${new Date().toISOString().slice(0, 10)})`, prefix: key.prefix, keyHash: sha256(key.full), scopes: m.role === "viewer" ? ["read"] : ["write"], expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000) })
      .returning();
    await db.update(cliAuthRequests).set({ approvedByUserId: user.id, teamId: body.teamId, apiKeyEnc: encrypt(key.full) }).where(eq(cliAuthRequests.id, r.id));
    await audit(actorOf(req), body.teamId, "apikey.create", { type: "api_key", id: k!.id }, { via: "cli" });
    return { ok: true };
  });

  route(app, { method: "POST", url: "/auth/cli/poll", public: true, tags: ["cli"], body: z.object({ deviceCode: z.string().min(10).max(200) }), rateLimit: { max: 60, timeWindow: "1 minute" } }, async (_req, _reply, { body }) => {
    const db = getDb();
    const [r] = await db.select().from(cliAuthRequests).where(eq(cliAuthRequests.codeHash, sha256(body.deviceCode)));
    if (!r || r.expiresAt < new Date() || r.consumedAt) return { status: "expired" };
    if (!r.apiKeyEnc) return { status: "pending" };
    // The key is handed out exactly once, then erased.
    await db.update(cliAuthRequests).set({ consumedAt: new Date(), apiKeyEnc: null }).where(eq(cliAuthRequests.id, r.id));
    return { status: "approved", apiKey: decrypt(r.apiKeyEnc), teamId: r.teamId };
  });

}
