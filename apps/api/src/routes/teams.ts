import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { apiKeys, auditLogs, databases, deployments, domains, getDb, gitInstallations, notifications, plans, projectMembers, projects, services, teamInvites, teamMembers, teams, users } from "@skyhost/db";
import { emailSchema, nameSchema, PERMISSIONS, roleSchema, ROLE_RANK, slugSchema } from "@skyhost/shared";
import { randomToken, sha256 } from "@skyhost/shared/node";
import { assertQuota, audit, badRequest, emailVerificationRequired, conflict, forbidden, getTeamPlan, notFound, notify, redis, renderEmail, sendMail, serverConfig, usageSummary } from "@skyhost/core";
import { actorOf } from "../lib/auth";
import { projectAccess, teamAccess } from "../lib/authz";
import { idParam, route } from "../lib/http";
import { uniqueTeamSlug } from "./auth";

const teamParam = z.object({ teamId: z.string().uuid() });

function teamView(t: typeof teams.$inferSelect, role?: string) {
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    logoUrl: t.logoUrl,
    personal: t.personal,
    ownerId: t.ownerId,
    planId: t.planId,
    billingStatus: t.billingStatus,
    creditBalanceCents: t.creditBalanceCents,
    defaultRegion: t.defaultRegion,
    require2fa: t.require2fa,
    sessionTtlHours: t.sessionTtlHours,
    dashboardIpAllowlist: t.dashboardIpAllowlist,
    deployFreeze: t.deployFreeze,
    retention: t.retention,
    spendCapCents: t.spendCapCents,
    spendCapAction: t.spendCapAction,
    roleOverrides: t.roleOverrides,
    suspended: !!t.suspendedAt,
    createdAt: t.createdAt,
    ...(role ? { role } : {}),
  };
}

export default async function teamRoutes(app: FastifyInstance) {
  route(app, { method: "GET", url: "/teams", tags: ["teams"] }, async (req) => {
    const rows = await getDb()
      .select({ team: teams, role: teamMembers.role, plan: plans })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .leftJoin(plans, eq(plans.id, teams.planId))
      .where(and(eq(teamMembers.userId, req.auth.user!.id), isNull(teams.deletedAt), req.auth.apiKey ? eq(teams.id, req.auth.apiKey.teamId) : undefined))
      .orderBy(teams.createdAt);
    return { teams: rows.map((r) => ({ ...teamView(r.team, r.role), plan: r.plan ? { slug: r.plan.slug, name: r.plan.name } : null })) };
  });

  route(app, { method: "POST", url: "/teams", tags: ["teams"], body: z.object({ name: nameSchema, slug: slugSchema.optional() }) }, async (req, reply, { body }) => {
    if (req.auth.apiKey) throw forbidden("Teams are created from the dashboard");
    const db = getDb();
    if (body.slug) {
      const [exists] = await db.select({ id: teams.id }).from(teams).where(eq(teams.slug, body.slug));
      if (exists) throw conflict("This team URL is already taken");
    }
    const [free] = await db.select().from(plans).where(eq(plans.slug, "free"));
    const [team] = await db
      .insert(teams)
      .values({ name: body.name, slug: body.slug ?? (await uniqueTeamSlug(body.name)), ownerId: req.auth.user!.id, planId: free?.id ?? null, billingEmail: req.auth.user!.email })
      .returning();
    await db.insert(teamMembers).values({ teamId: team!.id, userId: req.auth.user!.id, role: "owner" });
    await audit(actorOf(req), team!.id, "team.create", { type: "team", id: team!.id }, { name: body.name });
    reply.code(201);
    return { team: teamView(team!, "owner") };
  });

  route(app, { method: "GET", url: "/teams/:teamId", tags: ["teams"], params: teamParam }, async (req, _r, { params }) => {
    const a = await teamAccess(req, params.teamId, "team:read");
    return { team: teamView(a.team, a.role), permissions: [...a.permissions] };
  });

  route(
    app,
    { method: "PATCH", url: "/teams/:teamId", tags: ["teams"], params: teamParam, body: z.object({ name: nameSchema.optional(), slug: slugSchema.optional(), logoUrl: z.string().url().max(500).nullable().optional(), defaultRegion: z.string().max(32).optional(), billingEmail: emailSchema.optional(), billingCountry: z.string().length(2).optional(), taxId: z.string().max(64).optional() }) },
    async (req, _r, { params, body }) => {
      await teamAccess(req, params.teamId, "team:update");
      const db = getDb();
      if (body.slug) {
        const [exists] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.slug, body.slug), sql`${teams.id} <> ${params.teamId}`));
        if (exists) throw conflict("This team URL is already taken");
      }
      const [t] = await db.update(teams).set({ ...body, billingCountry: body.billingCountry?.toUpperCase(), updatedAt: new Date() }).where(eq(teams.id, params.teamId)).returning();
      await audit(actorOf(req), params.teamId, "team.update", { type: "team", id: params.teamId }, { fields: Object.keys(body) });
      return { team: teamView(t!) };
    },
  );

  route(app, { method: "DELETE", url: "/teams/:teamId", tags: ["teams"], params: teamParam, body: z.object({ confirmName: z.string() }) }, async (req, _r, { params, body }) => {
    const a = await teamAccess(req, params.teamId, "team:delete");
    if (body.confirmName !== a.team.name) throw badRequest("Type the team name to confirm");
    const db = getDb();
    const live = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.teamId, params.teamId), isNull(projects.deletedAt)));
    if (live.length) throw conflict("Delete or transfer every project of this team first");
    await db.update(teams).set({ deletedAt: new Date() }).where(eq(teams.id, params.teamId));
    await audit(actorOf(req), params.teamId, "team.delete", { type: "team", id: params.teamId });
    return { ok: true };
  });

  // ------------------------------------------------------------------------------------------- Security / settings
  route(
    app,
    {
      method: "PUT",
      url: "/teams/:teamId/security",
      tags: ["teams"],
      params: teamParam,
      body: z.object({ require2fa: z.boolean(), sessionTtlHours: z.number().int().min(1).max(24 * 90).nullable(), dashboardIpAllowlist: z.array(z.string().regex(/^[0-9a-fA-F.:]+(\/\d{1,3})?$/)).max(100) }),
    },
    async (req, _r, { params, body }) => {
      const a = await teamAccess(req, params.teamId, "team:security");
      if (body.dashboardIpAllowlist.length && !body.dashboardIpAllowlist.some((e) => e.split("/")[0] === req.ip.replace(/^::ffff:/, "") || e.includes("/"))) {
        throw badRequest(`Your current IP (${req.ip}) must be in the allowlist, or you would lock yourself out`);
      }
      if (body.require2fa && !req.auth.user!.totpEnabledAt) throw badRequest("Enable two-factor authentication on your own account first");
      await getDb().update(teams).set({ ...body, updatedAt: new Date() }).where(eq(teams.id, params.teamId));
      await audit(actorOf(req), params.teamId, "team.security_updated", { type: "team", id: a.team.id }, body);
      return { ok: true };
    },
  );

  route(
    app,
    { method: "PUT", url: "/teams/:teamId/permissions", tags: ["teams"], params: teamParam, body: z.object({ overrides: z.record(z.enum(["admin", "developer", "member", "viewer"]), z.object({ grant: z.array(z.enum(PERMISSIONS)).default([]), revoke: z.array(z.enum(PERMISSIONS)).default([]) })) }) },
    async (req, _r, { params, body }) => {
      await teamAccess(req, params.teamId, "members:role");
      await getDb().update(teams).set({ roleOverrides: body.overrides, updatedAt: new Date() }).where(eq(teams.id, params.teamId));
      await audit(actorOf(req), params.teamId, "team.permissions_updated", { type: "team", id: params.teamId }, body);
      return { ok: true };
    },
  );

  const window = z.object({ days: z.array(z.number().int().min(0).max(6)).min(1), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) });
  route(
    app,
    { method: "PUT", url: "/teams/:teamId/deploy-freeze", tags: ["teams"], params: teamParam, body: z.object({ enabled: z.boolean(), mode: z.enum(["deny", "allow"]).default("deny"), timezone: z.string().max(64).default("UTC"), windows: z.array(window).max(20) }) },
    async (req, _r, { params, body }) => {
      await teamAccess(req, params.teamId, "team:update");
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: body.timezone });
      } catch {
        throw badRequest("Unknown timezone");
      }
      await getDb().update(teams).set({ deployFreeze: body, updatedAt: new Date() }).where(eq(teams.id, params.teamId));
      await audit(actorOf(req), params.teamId, "team.deploy_freeze_updated", { type: "team", id: params.teamId }, body);
      return { ok: true };
    },
  );

  route(
    app,
    { method: "PUT", url: "/teams/:teamId/retention", tags: ["teams"], params: teamParam, body: z.object({ logsDays: z.number().int().min(1).max(365).optional(), screenshotsDays: z.number().int().min(1).max(3650).optional(), backupsDays: z.number().int().min(1).max(365).optional(), previewsDays: z.number().int().min(1).max(365).optional() }) },
    async (req, _r, { params, body }) => {
      const a = await teamAccess(req, params.teamId, "team:update");
      const plan = await getTeamPlan(a.team.id);
      if (body.logsDays && body.logsDays > plan.limits.logRetentionDays) throw badRequest(`Your plan keeps logs for at most ${plan.limits.logRetentionDays} days`);
      if (body.backupsDays && body.backupsDays > plan.limits.backupRetentionDays) throw badRequest(`Your plan keeps backups for at most ${plan.limits.backupRetentionDays} days`);
      await getDb().update(teams).set({ retention: body, updatedAt: new Date() }).where(eq(teams.id, params.teamId));
      return { ok: true };
    },
  );

  route(
    app,
    { method: "PUT", url: "/teams/:teamId/spend-cap", tags: ["billing"], params: teamParam, body: z.object({ spendCapCents: z.number().int().min(0).max(100_000_000).nullable(), action: z.enum(["alert", "block_deploys", "pause_services"]) }) },
    async (req, _r, { params, body }) => {
      await teamAccess(req, params.teamId, "billing:manage");
      await getDb().update(teams).set({ spendCapCents: body.spendCapCents, spendCapAction: body.action, spendAlertsSent: {}, updatedAt: new Date() }).where(eq(teams.id, params.teamId));
      await redis().del(`sh:spendcap:${params.teamId}`);
      await audit(actorOf(req), params.teamId, "billing.spend_cap_updated", { type: "team", id: params.teamId }, body);
      return { ok: true };
    },
  );

  route(app, { method: "GET", url: "/teams/:teamId/usage", tags: ["teams"], params: teamParam }, async (req, _r, { params }) => {
    await teamAccess(req, params.teamId, "team:read");
    return usageSummary(params.teamId);
  });

  // ------------------------------------------------------------------------------------------- Members
  // Getting-started checklist shown on the dashboard until every step is done.
  route(app, { method: "GET", url: "/teams/:teamId/onboarding", tags: ["teams"], params: teamParam }, async (req, _r, { params }) => {
    await teamAccess(req, params.teamId, "team:read");
    const db = getDb();
    const one = async (q: Promise<unknown[]>) => (await q).length > 0;
    const teamServices = db.select({ id: services.id }).from(services).innerJoin(projects, eq(projects.id, services.projectId)).where(and(eq(projects.teamId, params.teamId), isNull(services.deletedAt)));
    const ids = (await teamServices).map((s) => s.id);
    const steps = {
      verifyEmail: !!req.auth.user!.emailVerifiedAt || !emailVerificationRequired(),
      connectGit: await one(db.select({ id: gitInstallations.id }).from(gitInstallations).where(eq(gitInstallations.teamId, params.teamId)).limit(1)),
      firstDeploy: ids.length > 0 && (await one(db.select({ id: deployments.id }).from(deployments).where(and(inArray(deployments.serviceId, ids), inArray(deployments.status, ["live", "superseded"]))).limit(1))),
      addDatabase: await one(db.select({ id: databases.id }).from(databases).where(and(eq(databases.teamId, params.teamId), isNull(databases.deletedAt))).limit(1)),
      customDomain: ids.length > 0 && (await one(db.select({ id: domains.id }).from(domains).where(inArray(domains.serviceId, ids)).limit(1))),
      // Not a step when the plan has a single seat.
      inviteTeammate: (await getTeamPlan(params.teamId)).limits.members <= 1 || (await db.select({ id: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, params.teamId)).limit(2)).length > 1 || (await one(db.select({ id: teamInvites.id }).from(teamInvites).where(eq(teamInvites.teamId, params.teamId)).limit(1))),
    };
    return { steps, done: Object.values(steps).every(Boolean) };
  });

  route(app, { method: "GET", url: "/teams/:teamId/members", tags: ["members"], params: teamParam }, async (req, _r, { params }) => {
    await teamAccess(req, params.teamId, "members:read");
    const db = getDb();
    const members = await db
      .select({ userId: users.id, name: users.name, email: users.email, avatarUrl: users.avatarUrl, role: teamMembers.role, joinedAt: teamMembers.createdAt, twoFactor: users.totpEnabledAt })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, params.teamId))
      .orderBy(teamMembers.createdAt);
    const invites = await db
      .select({ id: teamInvites.id, email: teamInvites.email, role: teamInvites.role, expiresAt: teamInvites.expiresAt, createdAt: teamInvites.createdAt })
      .from(teamInvites)
      .where(and(eq(teamInvites.teamId, params.teamId), isNull(teamInvites.acceptedAt), isNull(teamInvites.declinedAt), isNull(teamInvites.revokedAt), gt(teamInvites.expiresAt, new Date())));
    return { members: members.map((m) => ({ ...m, twoFactor: !!m.twoFactor })), invites };
  });

  route(app, { method: "POST", url: "/teams/:teamId/invites", tags: ["members"], params: teamParam, body: z.object({ email: emailSchema, role: roleSchema }) }, async (req, reply, { params, body }) => {
    const a = await teamAccess(req, params.teamId, "members:invite");
    if (body.role === "owner") throw badRequest("Invite as admin, then transfer ownership");
    if (ROLE_RANK[body.role] > ROLE_RANK[a.role]) throw forbidden("You cannot invite someone with a higher role than yours");
    const db = getDb();
    const [already] = await db.select().from(teamMembers).innerJoin(users, eq(users.id, teamMembers.userId)).where(and(eq(teamMembers.teamId, params.teamId), eq(users.email, body.email)));
    if (already) throw conflict("This person is already a member");
    await assertQuota(params.teamId, "members");
    await db.update(teamInvites).set({ revokedAt: new Date() }).where(and(eq(teamInvites.teamId, params.teamId), eq(teamInvites.email, body.email), isNull(teamInvites.acceptedAt)));
    const token = randomToken(32);
    const [inv] = await db.insert(teamInvites).values({ teamId: params.teamId, email: body.email, role: body.role, tokenHash: sha256(token), invitedBy: req.auth.user!.id, expiresAt: new Date(Date.now() + 7 * 86400_000) }).returning();
    const url = `${serverConfig().SKYHOST_DASHBOARD_URL}/invite?token=${token}`;
    const { text, html } = renderEmail(`Join ${a.team.name} on SKYHOST`, [`${req.auth.user!.name} invited you to join the team "${a.team.name}" as ${body.role}. The invitation expires in 7 days.`], { label: "View invitation", url });
    await sendMail({ to: body.email, subject: `You're invited to ${a.team.name} on SKYHOST`, text, html });
    const [invitee] = await db.select().from(users).where(eq(users.email, body.email));
    if (invitee) {
      await db.insert(notifications).values({ userId: invitee.id, teamId: params.teamId, type: "invitation.received", title: `Invitation to ${a.team.name}`, body: `${req.auth.user!.name} invited you as ${body.role}.`, link: `/invite?token=${token}` });
    }
    await audit(actorOf(req), params.teamId, "member.invite", { type: "invite", id: inv!.id }, { email: body.email, role: body.role });
    reply.code(201);
    return { invite: { id: inv!.id, email: inv!.email, role: inv!.role, expiresAt: inv!.expiresAt } };
  });

  route(app, { method: "DELETE", url: "/teams/:teamId/invites/:id", tags: ["members"], params: teamParam.extend({ id: z.string().uuid() }) }, async (req, _r, { params }) => {
    await teamAccess(req, params.teamId, "members:invite");
    const res = await getDb().update(teamInvites).set({ revokedAt: new Date() }).where(and(eq(teamInvites.id, params.id), eq(teamInvites.teamId, params.teamId))).returning();
    if (!res.length) throw notFound("Invitation");
    await audit(actorOf(req), params.teamId, "member.invite_revoked", { type: "invite", id: params.id });
    return { ok: true };
  });

  route(app, { method: "GET", url: "/invites/:token", tags: ["members"], params: z.object({ token: z.string().min(10).max(200) }) }, async (_req, _r, { params }) => {
    const db = getDb();
    const [inv] = await db.select({ inv: teamInvites, team: teams }).from(teamInvites).innerJoin(teams, eq(teams.id, teamInvites.teamId)).where(eq(teamInvites.tokenHash, sha256(params.token)));
    if (!inv || inv.inv.revokedAt || inv.inv.acceptedAt || inv.inv.declinedAt || inv.inv.expiresAt < new Date()) throw notFound("Invitation");
    return { invite: { teamName: inv.team.name, role: inv.inv.role, email: inv.inv.email, expiresAt: inv.inv.expiresAt } };
  });

  route(app, { method: "POST", url: "/invites/:token/:action", tags: ["members"], params: z.object({ token: z.string().min(10).max(200), action: z.enum(["accept", "decline"]) }) }, async (req, _r, { params }) => {
    const db = getDb();
    const user = req.auth.user!;
    const [inv] = await db.select().from(teamInvites).where(eq(teamInvites.tokenHash, sha256(params.token)));
    if (!inv || inv.revokedAt || inv.acceptedAt || inv.declinedAt || inv.expiresAt < new Date()) throw notFound("Invitation");
    if (inv.email !== user.email) throw forbidden(`This invitation was sent to ${inv.email}. Sign in with that address.`);
    if (params.action === "decline") {
      await db.update(teamInvites).set({ declinedAt: new Date() }).where(eq(teamInvites.id, inv.id));
      await audit(actorOf(req), inv.teamId, "member.invite_declined", { type: "invite", id: inv.id });
      return { ok: true };
    }
    await db.insert(teamMembers).values({ teamId: inv.teamId, userId: user.id, role: inv.role }).onConflictDoNothing();
    await db.update(teamInvites).set({ acceptedAt: new Date() }).where(eq(teamInvites.id, inv.id));
    await audit(actorOf(req), inv.teamId, "member.join", { type: "user", id: user.id }, { role: inv.role });
    return { ok: true, teamId: inv.teamId };
  });

  route(app, { method: "PATCH", url: "/teams/:teamId/members/:userId", tags: ["members"], params: teamParam.extend({ userId: z.string().uuid() }), body: z.object({ role: roleSchema }) }, async (req, _r, { params, body }) => {
    const a = await teamAccess(req, params.teamId, "members:role");
    const db = getDb();
    if (body.role === "owner") throw badRequest("Use ownership transfer to make someone the owner");
    if (params.userId === a.team.ownerId) throw forbidden("The owner's role cannot be changed");
    if (ROLE_RANK[body.role] > ROLE_RANK[a.role]) throw forbidden("You cannot grant a role higher than yours");
    const [m] = await db.select().from(teamMembers).where(and(eq(teamMembers.teamId, params.teamId), eq(teamMembers.userId, params.userId)));
    if (!m) throw notFound("Member");
    if (a.role !== "owner" && ROLE_RANK[m.role as keyof typeof ROLE_RANK] >= ROLE_RANK[a.role]) throw forbidden("You cannot change the role of someone at or above your level");
    await db.update(teamMembers).set({ role: body.role }).where(and(eq(teamMembers.teamId, params.teamId), eq(teamMembers.userId, params.userId)));
    await audit(actorOf(req), params.teamId, "member.role_changed", { type: "user", id: params.userId }, { from: m.role, to: body.role });
    return { ok: true };
  });

  route(app, { method: "DELETE", url: "/teams/:teamId/members/:userId", tags: ["members"], params: teamParam.extend({ userId: z.string().uuid() }) }, async (req, _r, { params }) => {
    const self = params.userId === req.auth.user!.id;
    const a = await teamAccess(req, params.teamId, self ? "team:read" : "members:remove");
    const db = getDb();
    if (params.userId === a.team.ownerId) throw forbidden(self ? "Transfer ownership before leaving the team" : "The owner cannot be removed");
    const [m] = await db.select().from(teamMembers).where(and(eq(teamMembers.teamId, params.teamId), eq(teamMembers.userId, params.userId)));
    if (!m) throw notFound("Member");
    if (!self && a.role !== "owner" && ROLE_RANK[m.role as keyof typeof ROLE_RANK] >= ROLE_RANK[a.role]) throw forbidden("You cannot remove someone at or above your level");
    await db.delete(teamMembers).where(and(eq(teamMembers.teamId, params.teamId), eq(teamMembers.userId, params.userId)));
    // Keys of a removed member stop working for this team immediately.
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.teamId, params.teamId), eq(apiKeys.userId, params.userId), isNull(apiKeys.revokedAt)));
    await audit(actorOf(req), params.teamId, self ? "member.leave" : "member.remove", { type: "user", id: params.userId });
    return { ok: true };
  });

  route(app, { method: "POST", url: "/teams/:teamId/transfer", tags: ["members"], params: teamParam, body: z.object({ userId: z.string().uuid() }) }, async (req, _r, { params, body }) => {
    const a = await teamAccess(req, params.teamId, "team:transfer");
    const db = getDb();
    const [m] = await db.select().from(teamMembers).where(and(eq(teamMembers.teamId, params.teamId), eq(teamMembers.userId, body.userId)));
    if (!m) throw badRequest("The new owner must already be a member");
    await db.transaction(async (tx) => {
      await tx.update(teamMembers).set({ role: "owner" }).where(and(eq(teamMembers.teamId, params.teamId), eq(teamMembers.userId, body.userId)));
      await tx.update(teamMembers).set({ role: "admin" }).where(and(eq(teamMembers.teamId, params.teamId), eq(teamMembers.userId, a.team.ownerId)));
      await tx.update(teams).set({ ownerId: body.userId, personal: false }).where(eq(teams.id, params.teamId));
    });
    await audit(actorOf(req), params.teamId, "team.ownership_transferred", { type: "team", id: params.teamId }, { from: a.team.ownerId, to: body.userId });
    await notify({ teamId: params.teamId, userIds: [body.userId], event: "invitation.received", title: `You now own ${a.team.name}`, body: `${req.auth.user!.name} transferred the ownership of ${a.team.name} to you.`, link: "/settings" });
    return { ok: true };
  });

  // ------------------------------------------------------------------------------------------- Audit log
  route(
    app,
    {
      method: "GET",
      url: "/teams/:teamId/audit-logs",
      tags: ["audit"],
      params: teamParam,
      query: z.object({ action: z.string().max(64).optional(), actorUserId: z.string().uuid().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
    },
    async (req, _r, { params, query }) => {
      await teamAccess(req, params.teamId, "audit:read");
      const db = getDb();
      const rows = await db
        .select({ log: auditLogs, actorName: users.name, actorEmail: users.email })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.actorUserId))
        .where(
          and(
            eq(auditLogs.teamId, params.teamId),
            query.action ? sql`${auditLogs.action} like ${query.action.replace(/[%_]/g, "") + "%"}` : undefined,
            query.actorUserId ? eq(auditLogs.actorUserId, query.actorUserId) : undefined,
            query.from ? gte(auditLogs.createdAt, query.from) : undefined,
            query.to ? lte(auditLogs.createdAt, query.to) : undefined,
            query.before ? lt(auditLogs.id, query.before) : undefined,
          ),
        )
        .orderBy(desc(auditLogs.id))
        .limit(query.limit);
      return { logs: rows.map((r) => ({ ...r.log, actor: r.log.actorUserId ? { name: r.actorName, email: r.actorEmail } : null })), nextCursor: rows.length === query.limit ? rows.at(-1)!.log.id : null };
    },
  );

  route(app, { method: "GET", url: "/teams/:teamId/members/:userId/projects", tags: ["members"], params: teamParam.extend({ userId: z.string().uuid() }) }, async (req, _r, { params }) => {
    await teamAccess(req, params.teamId, "members:read");
    const rows = await getDb()
      .select({ projectId: projectMembers.projectId, role: projectMembers.role })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(and(eq(projectMembers.userId, params.userId), eq(projects.teamId, params.teamId)));
    return { projectRoles: rows };
  });

  route(
    app,
    { method: "PUT", url: "/projects/:id/members/:userId", tags: ["members"], params: idParam.extend({ userId: z.string().uuid() }), body: z.object({ role: roleSchema.nullable() }) },
    async (req, _r, { params, body }) => {
      const a = await projectAccess(req, params.id, "members:role");
        const db = getDb();
      const [m] = await db.select().from(teamMembers).where(and(eq(teamMembers.teamId, a.team.id), eq(teamMembers.userId, params.userId)));
      if (!m) throw badRequest("This person is not a member of the team");
      if (body.role === "owner") throw badRequest("Project roles cannot be owner");
      if (body.role === null) await db.delete(projectMembers).where(and(eq(projectMembers.projectId, params.id), eq(projectMembers.userId, params.userId)));
      else await db.insert(projectMembers).values({ projectId: params.id, userId: params.userId, role: body.role }).onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { role: body.role } });
      await audit(actorOf(req), a.team.id, "member.project_role_changed", { type: "project", id: params.id }, { userId: params.userId, role: body.role });
      return { ok: true };
    },
  );

}
