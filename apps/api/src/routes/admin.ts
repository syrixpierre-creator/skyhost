import type { FastifyInstance } from "fastify";
import { and, count, desc, eq, gte, ilike, inArray, isNull, or, sql, sum } from "drizzle-orm";
import { z } from "zod";
import {
  abuseDecisions, abuseReports, announcements, deployments, discounts, featureFlags, getDb, nodes, payments, plans, projects, referralRewards, referrals, regions,
  serviceInstances, services, sessions, taxRates, teams, users,
} from "@skyhost/db";
import { PLAN_FEATURE_KEYS, PLAN_LIMIT_KEYS } from "@skyhost/shared";
import { audit, badRequest, enqueue, getQueue, getSetting, notFound, notify, QUEUES, refundPaypalCapture, refundStripePayment, setSetting } from "@skyhost/core";
import { actorOf, createSession } from "../lib/auth";
import { requireAdmin } from "../lib/authz";
import { idParam, route } from "../lib/http";

const limitsSchema = z.object(Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, z.number().min(0)])) as Record<(typeof PLAN_LIMIT_KEYS)[number], z.ZodNumber>);
const featuresSchema = z.object(Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, z.boolean()])) as Record<(typeof PLAN_FEATURE_KEYS)[number], z.ZodBoolean>);
const planBody = z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,32}$/),
  name: z.string().min(1).max(60),
  priceCents: z.number().int().min(0),
  currency: z.string().length(3).default("usd"),
  limits: limitsSchema,
  features: featuresSchema,
  overage: z.record(z.number().min(0)).default({}),
  isPublic: z.boolean().default(true),
  isContactSales: z.boolean().default(false),
  isFree: z.boolean().default(false),
  trialDays: z.number().int().min(0).max(90).default(0),
  stripePriceId: z.string().max(100).nullable().optional(),
  paypalPlanId: z.string().max(100).nullable().optional(),
  sort: z.number().int().default(0),
  archived: z.boolean().default(false),
});

/** Pauses (or resumes) every running service of a team; used for abuse and billing suspensions. */
async function setTeamServicesPaused(teamId: string, paused: boolean, reason: string) {
  const db = getDb();
  const insts = await db
    .select({ id: serviceInstances.id, serviceId: serviceInstances.serviceId, environmentId: serviceInstances.environmentId })
    .from(serviceInstances)
    .innerJoin(services, eq(services.id, serviceInstances.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .where(eq(projects.teamId, teamId));
  for (const i of insts) {
    await db.update(serviceInstances).set(paused ? { status: "paused", pausedReason: reason } : { status: "running", pausedReason: null }).where(eq(serviceInstances.id, i.id));
    await enqueue("maintenance", { task: `${paused ? "stop" : "start"}:${i.serviceId}:${i.environmentId}` });
  }
  await enqueue("maintenance", { task: "reconcile-proxy" });
}
export { setTeamServicesPaused };

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req) => {
    if (req.url.startsWith("/api/v1/admin")) requireAdmin(req);
  });

  route(app, { method: "GET", url: "/admin/overview", tags: ["admin"] }, async () => {
    const db = getDb();
    const since = new Date(Date.now() - 30 * 86400_000);
    const n = async (q: Promise<Array<{ c: unknown }>>) => Number((await q)[0]?.c ?? 0);
    const [usersN, teamsN, servicesN, running, queued, building, revenue, openAbuse, flaggedRefs] = await Promise.all([
      n(db.select({ c: count() }).from(users).where(isNull(users.deletedAt))),
      n(db.select({ c: count() }).from(teams).where(isNull(teams.deletedAt))),
      n(db.select({ c: count() }).from(services).where(isNull(services.deletedAt))),
      n(db.select({ c: count() }).from(serviceInstances).where(eq(serviceInstances.status, "running"))),
      n(db.select({ c: count() }).from(deployments).where(eq(deployments.status, "queued"))),
      n(db.select({ c: count() }).from(deployments).where(inArray(deployments.status, ["building", "deploying"]))),
      n(db.select({ c: sum(payments.amountCents) }).from(payments).where(and(eq(payments.status, "succeeded"), gte(payments.createdAt, since)))),
      n(db.select({ c: count() }).from(abuseReports).where(eq(abuseReports.status, "open"))),
      n(db.select({ c: count() }).from(referrals).where(eq(referrals.status, "flagged"))),
    ]);
    const queues: Record<string, unknown> = {};
    for (const q of Object.values(QUEUES)) queues[q] = await getQueue(q).getJobCounts("waiting", "active", "delayed", "failed");
    const workerNodes = await db.select().from(nodes);
    return { users: usersN, teams: teamsN, services: servicesN, runningInstances: running, deployments: { queued, building }, revenue30dCents: revenue, openAbuseReports: openAbuse, flaggedReferrals: flaggedRefs, queues, nodes: workerNodes };
  });

  // ---------------------------------------------------------------------------------- Users
  route(app, { method: "GET", url: "/admin/users", tags: ["admin"], query: z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) }, async (_req, _r, { query }) => {
    const like = query.q ? `%${query.q.replace(/[%_]/g, "")}%` : null;
    const rows = await getDb()
      .select()
      .from(users)
      .where(like ? or(ilike(users.email, like), ilike(users.name, like)) : undefined)
      .orderBy(desc(users.createdAt))
      .limit(query.limit);
    return { users: rows.map((u) => ({ id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, emailVerified: !!u.emailVerifiedAt, twoFactor: !!u.totpEnabledAt, suspendedAt: u.suspendedAt, deletedAt: u.deletedAt, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt })) };
  });

  route(app, { method: "POST", url: "/admin/users/:id/:action", tags: ["admin"], params: idParam.extend({ action: z.enum(["suspend", "unsuspend"]) }), body: z.object({ reason: z.string().min(3).max(500) }) }, async (req, _r, { params, body }) => {
    const db = getDb();
    if (params.id === req.auth.user!.id) throw badRequest("You cannot suspend yourself");
    const suspend = params.action === "suspend";
    const res = await db.update(users).set({ suspendedAt: suspend ? new Date() : null, suspendedReason: suspend ? body.reason : null }).where(eq(users.id, params.id)).returning();
    if (!res.length) throw notFound("User");
    if (suspend) await db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, params.id), isNull(sessions.revokedAt)));
    await db.insert(abuseDecisions).values({ userId: params.id, action: params.action, reason: body.reason, decidedBy: req.auth.user!.id });
    await audit(actorOf(req), null, `admin.user_${params.action}`, { type: "user", id: params.id }, { reason: body.reason });
    return { ok: true };
  });

  /**
   * Impersonation for support: requires a reason, is time limited (1h), marked on the session, shown as a banner,
   * notified to the user and audited on both sides. Admin powers are not available while impersonating.
   */
  route(app, { method: "POST", url: "/admin/users/:id/impersonate", tags: ["admin"], params: idParam, body: z.object({ reason: z.string().min(10).max(500) }) }, async (req, reply, { params, body }) => {
    const db = getDb();
    const [target] = await db.select().from(users).where(and(eq(users.id, params.id), isNull(users.deletedAt)));
    if (!target) throw notFound("User");
    if (target.isAdmin) throw badRequest("Administrators cannot be impersonated");
    const admin = req.auth.user!;
    await createSession(req, reply, target, { impersonatorId: admin.id, impersonationReason: body.reason, ttlHours: 1 });
    await audit(actorOf(req), null, "admin.impersonation_started", { type: "user", id: target.id }, { reason: body.reason });
    await audit({ userId: target.id, impersonatorId: admin.id, ip: req.ip }, null, "account.impersonated", { type: "user", id: target.id }, { by: admin.email, reason: body.reason });
    const { teamMembers } = await import("@skyhost/db");
    const [m] = await db.select().from(teamMembers).where(eq(teamMembers.userId, target.id)).limit(1);
    if (m) await notify({ teamId: m.teamId, userIds: [target.id], event: "alert.triggered", title: "A SKYHOST administrator accessed your account", body: `Reason: ${body.reason}. Contact support if you did not request help.` });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------------- Teams
  route(app, { method: "GET", url: "/admin/teams", tags: ["admin"], query: z.object({ q: z.string().max(100).optional() }) }, async (_req, _r, { query }) => {
    const like = query.q ? `%${query.q.replace(/[%_]/g, "")}%` : null;
    const rows = await getDb().select({ t: teams, plan: plans.slug }).from(teams).leftJoin(plans, eq(plans.id, teams.planId)).where(like ? or(ilike(teams.name, like), ilike(teams.slug, like)) : undefined).orderBy(desc(teams.createdAt)).limit(100);
    return { teams: rows.map(({ t, plan }) => ({ id: t.id, name: t.name, slug: t.slug, plan, billingStatus: t.billingStatus, creditBalanceCents: t.creditBalanceCents, suspendedAt: t.suspendedAt, suspendedReason: t.suspendedReason, createdAt: t.createdAt })) };
  });

  route(app, { method: "POST", url: "/admin/teams/:id/:action", tags: ["admin"], params: idParam.extend({ action: z.enum(["suspend", "unsuspend"]) }), body: z.object({ reason: z.string().min(3).max(500), reportId: z.string().uuid().optional() }) }, async (req, _r, { params, body }) => {
    const db = getDb();
    const suspend = params.action === "suspend";
    const res = await db.update(teams).set({ suspendedAt: suspend ? new Date() : null, suspendedReason: suspend ? body.reason : null }).where(eq(teams.id, params.id)).returning();
    if (!res.length) throw notFound("Team");
    await setTeamServicesPaused(params.id, suspend, "abuse");
    await db.insert(abuseDecisions).values({ teamId: params.id, reportId: body.reportId ?? null, action: params.action, reason: body.reason, decidedBy: req.auth.user!.id });
    if (body.reportId) await db.update(abuseReports).set({ status: "actioned" }).where(eq(abuseReports.id, body.reportId));
    await audit(actorOf(req), params.id, `admin.team_${params.action}`, { type: "team", id: params.id }, { reason: body.reason });
    return { ok: true };
  });

  route(app, { method: "POST", url: "/admin/teams/:id/credits", tags: ["admin"], params: idParam, body: z.object({ amountCents: z.number().int().min(-1_000_000).max(1_000_000), reason: z.string().min(3).max(200) }) }, async (req, _r, { params, body }) => {
    const { addCredits } = await import("@skyhost/core");
    await addCredits(params.id, body.amountCents, "adjustment", `admin:${req.auth.user!.id}:${Date.now()}`);
    await audit(actorOf(req), params.id, "admin.credits_adjusted", { type: "team", id: params.id }, body);
    return { ok: true };
  });

  // ---------------------------------------------------------------------------------- Plans, settings, taxes, discounts
  route(app, { method: "GET", url: "/admin/plans", tags: ["admin"] }, async () => ({ plans: await getDb().select().from(plans).orderBy(plans.sort) }));

  route(app, { method: "POST", url: "/admin/plans", tags: ["admin"], body: planBody }, async (req, reply, { body }) => {
    const [p] = await getDb().insert(plans).values(body).returning();
    await audit(actorOf(req), null, "admin.plan_created", { type: "plan", id: p!.id }, { slug: body.slug });
    reply.code(201);
    return { plan: p };
  });

  route(app, { method: "PATCH", url: "/admin/plans/:id", tags: ["admin"], params: idParam, body: planBody.partial() }, async (req, _r, { params, body }) => {
    const [p] = await getDb().update(plans).set({ ...body, updatedAt: new Date() }).where(eq(plans.id, params.id)).returning();
    if (!p) throw notFound("Plan");
    await audit(actorOf(req), null, "admin.plan_updated", { type: "plan", id: p.id }, { fields: Object.keys(body) });
    return { plan: p };
  });

  route(app, { method: "GET", url: "/admin/settings", tags: ["admin"] }, async () => ({ referral: await getSetting("referral"), billing: await getSetting("billing"), signup: await getSetting("signup"), maintenance: await getSetting("maintenance") }));

  route(app, { method: "PUT", url: "/admin/settings/:key", tags: ["admin"], params: z.object({ key: z.enum(["referral", "billing", "signup", "maintenance"]) }), body: z.record(z.unknown()) }, async (req, _r, { params, body }) => {
    const schemas = {
      referral: z.object({ enabled: z.boolean(), rewardType: z.enum(["percent", "fixed"]), percent: z.number().min(0).max(100), recurringMonths: z.number().int().min(1).max(120), fixedCents: z.number().int().min(0), refereeBonusCents: z.number().int().min(0), refundWindowDays: z.number().int().min(0).max(180), minPayoutCents: z.number().int().min(0), maxRewardsPerReferrerPerMonth: z.number().int().min(1), payoutMethods: z.array(z.enum(["credit", "stripe_connect", "paypal"])) }).partial(),
      billing: z.object({ graceDays: z.number().int().min(0).max(60), dunningDays: z.array(z.number().int().min(0).max(60)).max(10), defaultTaxPercent: z.number().min(0).max(50), trialPlan: z.string().max(32) }).partial(),
      signup: z.object({ enabled: z.boolean(), maxAccountsPerIpPerDay: z.number().int().min(1).max(1000) }).partial(),
      maintenance: z.object({ enabled: z.boolean(), message: z.string().max(500), blockDeploys: z.boolean(), endsAt: z.string().datetime().nullable() }).partial(),
    };
    const parsed = schemas[params.key].parse(body);
    const value = await setSetting(params.key, parsed as never);
    await audit(actorOf(req), null, "admin.settings_updated", { type: "settings", id: params.key }, parsed);
    return { value };
  });

  route(app, { method: "GET", url: "/admin/tax-rates", tags: ["admin"] }, async () => ({ taxRates: await getDb().select().from(taxRates) }));
  route(app, { method: "PUT", url: "/admin/tax-rates", tags: ["admin"], body: z.object({ country: z.string().length(2), name: z.string().max(40), percent: z.number().min(0).max(50), reverseCharge: z.boolean().default(false) }) }, async (req, _r, { body }) => {
    const v = { ...body, country: body.country.toUpperCase() };
    await getDb().insert(taxRates).values(v).onConflictDoUpdate({ target: taxRates.country, set: v });
    await audit(actorOf(req), null, "admin.tax_rate_updated", { type: "tax_rate", id: v.country }, v);
    return { ok: true };
  });

  route(app, { method: "GET", url: "/admin/discounts", tags: ["admin"] }, async () => ({ discounts: await getDb().select().from(discounts) }));
  route(app, { method: "POST", url: "/admin/discounts", tags: ["admin"], body: z.object({ code: z.string().regex(/^[A-Z0-9-]{3,32}$/), percentOff: z.number().int().min(1).max(100).optional(), amountOffCents: z.number().int().min(1).optional(), maxRedemptions: z.number().int().min(1).optional(), expiresAt: z.coerce.date().optional() }) }, async (req, reply, { body }) => {
    if (!body.percentOff === !body.amountOffCents) throw badRequest("Set either percentOff or amountOffCents");
    const [d] = await getDb().insert(discounts).values(body).returning();
    await audit(actorOf(req), null, "admin.discount_created", { type: "discount", id: d!.id }, { code: body.code });
    reply.code(201);
    return { discount: d };
  });

  // ---------------------------------------------------------------------------------- Feature flags & announcements
  route(app, { method: "GET", url: "/admin/feature-flags", tags: ["admin"] }, async () => ({ flags: await getDb().select().from(featureFlags) }));
  route(app, { method: "PUT", url: "/admin/feature-flags/:key", tags: ["admin"], params: z.object({ key: z.string().regex(/^[a-z0-9_.-]{2,64}$/) }), body: z.object({ enabled: z.boolean(), description: z.string().max(300).optional(), teamIds: z.array(z.string().uuid()).default([]) }) }, async (req, _r, { params, body }) => {
    await getDb().insert(featureFlags).values({ key: params.key, ...body }).onConflictDoUpdate({ target: featureFlags.key, set: { ...body, updatedAt: new Date() } });
    await audit(actorOf(req), null, "admin.feature_flag", { type: "feature_flag", id: params.key }, body);
    return { ok: true };
  });

  route(app, { method: "POST", url: "/admin/announcements", tags: ["admin"], body: z.object({ kind: z.enum(["info", "maintenance", "incident"]), title: z.string().min(1).max(200), body: z.string().max(5000).default(""), startsAt: z.coerce.date().optional(), endsAt: z.coerce.date().optional() }) }, async (req, reply, { body }) => {
    const [a] = await getDb().insert(announcements).values({ ...body, startsAt: body.startsAt ?? new Date() }).returning();
    await audit(actorOf(req), null, "admin.announcement", { type: "announcement", id: a!.id }, { kind: body.kind, title: body.title });
    reply.code(201);
    return { announcement: a };
  });
  route(app, { method: "DELETE", url: "/admin/announcements/:id", tags: ["admin"], params: idParam }, async (_req, _r, { params }) => {
    await getDb().update(announcements).set({ endsAt: new Date() }).where(eq(announcements.id, params.id));
    return { ok: true };
  });

  // ---------------------------------------------------------------------------------- Abuse
  route(app, { method: "GET", url: "/admin/abuse", tags: ["admin"], query: z.object({ status: z.enum(["open", "investigating", "actioned", "dismissed"]).optional() }) }, async (_req, _r, { query }) => {
    const db = getDb();
    return {
      reports: await db.select().from(abuseReports).where(query.status ? eq(abuseReports.status, query.status) : undefined).orderBy(desc(abuseReports.createdAt)).limit(200),
      decisions: await db.select().from(abuseDecisions).orderBy(desc(abuseDecisions.createdAt)).limit(200),
    };
  });

  route(app, { method: "PATCH", url: "/admin/abuse/:id", tags: ["admin"], params: idParam, body: z.object({ status: z.enum(["open", "investigating", "actioned", "dismissed"]), note: z.string().max(1000).optional() }) }, async (req, _r, { params, body }) => {
    const [r] = await getDb().update(abuseReports).set({ status: body.status }).where(eq(abuseReports.id, params.id)).returning();
    if (!r) throw notFound("Report");
    if (body.status === "dismissed") await getDb().insert(abuseDecisions).values({ reportId: r.id, teamId: r.teamId, action: "dismiss", reason: body.note ?? "Dismissed", decidedBy: req.auth.user!.id });
    await audit(actorOf(req), r.teamId, "admin.abuse_report_updated", { type: "abuse_report", id: r.id }, body);
    return { ok: true };
  });

  // ---------------------------------------------------------------------------------- Referral review
  route(app, { method: "GET", url: "/admin/referrals", tags: ["admin"], query: z.object({ status: z.string().max(20).optional() }) }, async (_req, _r, { query }) => {
    const db = getDb();
    const refs = await db.select().from(referrals).where(query.status ? eq(referrals.status, query.status) : undefined).orderBy(desc(referrals.createdAt)).limit(200);
    const rewards = refs.length ? await db.select().from(referralRewards).where(inArray(referralRewards.referralId, refs.map((r) => r.id))) : [];
    return { referrals: refs.map((r) => ({ ...r, rewards: rewards.filter((w) => w.referralId === r.id) })) };
  });

  route(app, { method: "POST", url: "/admin/referrals/:id/review", tags: ["admin"], params: idParam, body: z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(500).optional() }) }, async (req, _r, { params, body }) => {
    const db = getDb();
    const [r] = await db.select().from(referrals).where(eq(referrals.id, params.id));
    if (!r) throw notFound("Referral");
    await db.update(referrals).set({ status: body.decision === "approve" ? (r.convertedAt ? "converted" : "signed_up") : "rejected", reviewedBy: req.auth.user!.id, reviewedAt: new Date() }).where(eq(referrals.id, r.id));
    // Approved: held rewards go back to the normal refund-window flow. Rejected: cancelled.
    await db
      .update(referralRewards)
      .set(body.decision === "approve" ? { status: "pending" } : { status: "cancelled", cancelledAt: new Date(), cancelReason: "rejected_by_review" })
      .where(and(eq(referralRewards.referralId, r.id), inArray(referralRewards.status, ["held", "pending"])));
    await audit(actorOf(req), null, `admin.referral_${body.decision}`, { type: "referral", id: r.id }, { note: body.note });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------------- Payments & refunds
  route(app, { method: "GET", url: "/admin/payments", tags: ["admin"] }, async () => ({ payments: await getDb().select().from(payments).orderBy(desc(payments.createdAt)).limit(200) }));

  route(app, { method: "POST", url: "/admin/payments/:id/refund", tags: ["admin"], params: idParam, body: z.object({ amountCents: z.number().int().min(1).optional(), reason: z.string().min(3).max(300) }) }, async (req, _r, { params, body }) => {
    const [p] = await getDb().select().from(payments).where(eq(payments.id, params.id));
    if (!p) throw notFound("Payment");
    if (p.provider === "stripe") await refundStripePayment(p.providerPaymentId, body.amountCents);
    else if (p.provider === "paypal") await refundPaypalCapture(p.providerPaymentId, body.amountCents, p.currency);
    else throw badRequest(`Refunds for ${p.provider} payments are handled manually`);
    // The refund is applied when the provider's verified refund webhook arrives.
    await audit(actorOf(req), p.teamId, "admin.refund_requested", { type: "payment", id: p.id }, body);
    return { ok: true, message: "Refund requested. It will be applied when the provider confirms it." };
  });

  route(app, { method: "GET", url: "/admin/regions", tags: ["admin"] }, async () => ({ regions: await getDb().select().from(regions), nodes: await getDb().select().from(nodes) }));

  void sql;
}
