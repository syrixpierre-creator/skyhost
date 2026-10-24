import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { creditTransactions, getDb, invoices, plans, subscriptions, teams, users } from "@skyhost/db";
import type { PlanLimitKey, PlanLimits } from "@skyhost/shared";
import { randomToken } from "@skyhost/shared/node";
import {
  activateSubscription, audit, badRequest, billingPortalUrl, cancelPaypalSubscription, cancelStripeSubscription, capturePaypalOrder, changeStripePlan, conflict, createCreditsCheckout,
  createMobileMoneyPayment, createPaypalOrder, createPaypalSubscription, createSubscriptionCheckout, ensureStripeCustomer, flutterwaveConfigured, getUsage, notFound, paypalConfigured,
  recordPayment, renderInvoicePdf, serverConfig, stripeConfigured, teamBillingOverview, usageSummary, labelOf,
  consumePendingDiscount, discountedCents, listRedemptions, pendingDiscount, redeemPromoCode, getTeamPlan, usageCharge,
} from "@skyhost/core";
import { actorOf } from "../lib/auth";
import { teamAccess } from "../lib/authz";
import { idParam, route } from "../lib/http";

const teamParam = z.object({ teamId: z.string().uuid() });

function planView(p: typeof plans.$inferSelect) {
  return { id: p.id, slug: p.slug, name: p.name, priceCents: p.priceCents, currency: p.currency, interval: p.interval, limits: p.limits, features: p.features, isContactSales: p.isContactSales, isFree: p.isFree, trialDays: p.trialDays, providers: { stripe: !!p.stripePriceId, paypal: !!p.paypalPlanId } };
}

/** A downgrade is refused when current usage exceeds the target plan, so nothing is deleted silently. */
async function assertFits(teamId: string, plan: typeof plans.$inferSelect) {
  const usage = await getUsage(teamId);
  const limits = plan.limits as PlanLimits;
  const over = (Object.keys(limits) as PlanLimitKey[]).filter((k) => !["deploysPerDay", "buildMinutes", "screenshotsPerMonth", "bandwidthGb", "logRetentionDays", "backupRetentionDays"].includes(k) && usage[k] > limits[k]);
  if (over.length) throw conflict(`Your usage exceeds the ${plan.name} plan: ${over.map((k) => `${usage[k]}/${limits[k]} ${labelOf(k)}`).join(", ")}. Reduce it before switching.`);
}

export default async function billingRoutes(app: FastifyInstance) {
  route(app, { method: "GET", url: "/plans", public: true, tags: ["billing"] }, async () => {
    const rows = await getDb().select().from(plans).where(and(eq(plans.isPublic, true), eq(plans.archived, false))).orderBy(asc(plans.sort));
    return { plans: rows.map(planView), providers: { stripe: stripeConfigured(), paypal: paypalConfigured(), mobileMoney: flutterwaveConfigured() }, paymentsEnabled: serverConfig().SKYHOST_PAYMENTS_ENABLED };
  });

  route(app, { method: "GET", url: "/teams/:teamId/billing", tags: ["billing"], params: teamParam }, async (req, _r, { params }) => {
    await teamAccess(req, params.teamId, "billing:read");
    return { ...(await teamBillingOverview(params.teamId)), usage: await usageSummary(params.teamId), pendingDiscount: await pendingDiscount(params.teamId), promoCodes: await listRedemptions(params.teamId) };
  });

  route(
    app,
    { method: "POST", url: "/teams/:teamId/billing/checkout", tags: ["billing"], params: teamParam, body: z.object({ planId: z.string().uuid(), provider: z.enum(["stripe", "paypal"]).default("stripe") }) },
    async (req, _r, { params, body }) => {
      const a = await teamAccess(req, params.teamId, "billing:manage");
      const db = getDb();
      const [plan] = await db.select().from(plans).where(and(eq(plans.id, body.planId), eq(plans.archived, false)));
      if (!plan) throw notFound("Plan");
      if (plan.isContactSales) throw badRequest("Contact our sales team for this plan");
      await assertFits(params.teamId, plan);
      const dash = serverConfig().SKYHOST_DASHBOARD_URL;
      if (plan.isFree) {
        const [active] = await db.select().from(subscriptions).where(and(eq(subscriptions.teamId, params.teamId), eq(subscriptions.status, "active")));
        if (active) throw conflict("Cancel your current subscription to switch to the free plan");
        await db.update(teams).set({ planId: plan.id }).where(eq(teams.id, params.teamId));
        await audit(actorOf(req), params.teamId, "billing.plan_changed", { type: "team", id: params.teamId }, { plan: plan.slug });
        return { switched: true };
      }
      // Subscriptions are activated by verified provider webhooks only, never by this response.
      if (body.provider === "stripe") {
        if (!plan.stripePriceId) throw badRequest("This plan is not available with card payments yet");
        const customer = await ensureStripeCustomer(a.team, req.auth.user!.email);
        if (customer !== a.team.stripeCustomerId) await db.update(teams).set({ stripeCustomerId: customer }).where(eq(teams.id, params.teamId));
        const url = await createSubscriptionCheckout({ customerId: customer, teamId: params.teamId, userId: req.auth.user!.id, priceId: plan.stripePriceId, planId: plan.id, successUrl: `${dash}/billing?checkout=success`, cancelUrl: `${dash}/billing?checkout=cancelled`, trialDays: plan.trialDays || undefined, promo: await pendingDiscount(params.teamId) });
        await audit(actorOf(req), params.teamId, "billing.checkout_started", { type: "plan", id: plan.id }, { provider: "stripe" });
        return { url };
      }
      if (!plan.paypalPlanId) throw badRequest("This plan is not available with PayPal yet");
      const sub = await createPaypalSubscription({ planId: plan.paypalPlanId, teamId: params.teamId, returnUrl: `${dash}/billing?checkout=success`, cancelUrl: `${dash}/billing?checkout=cancelled` });
      await audit(actorOf(req), params.teamId, "billing.checkout_started", { type: "plan", id: plan.id }, { provider: "paypal" });
      return { url: sub.approveUrl };
    },
  );

  route(app, { method: "POST", url: "/teams/:teamId/billing/change-plan", tags: ["billing"], params: teamParam, body: z.object({ planId: z.string().uuid() }) }, async (req, _r, { params, body }) => {
    await teamAccess(req, params.teamId, "billing:manage");
    const db = getDb();
    const [plan] = await db.select().from(plans).where(eq(plans.id, body.planId));
    if (!plan || plan.isContactSales || plan.isFree) throw badRequest("Choose a paid plan");
    await assertFits(params.teamId, plan);
    const [sub] = await db.select().from(subscriptions).where(and(eq(subscriptions.teamId, params.teamId), eq(subscriptions.status, "active"))).orderBy(desc(subscriptions.createdAt));
    if (!sub) throw badRequest("No active subscription: use checkout instead");
    if (sub.provider !== "stripe") throw badRequest("Plan changes with proration are available for card subscriptions. Cancel and subscribe again for PayPal.");
    if (!plan.stripePriceId) throw badRequest("This plan is not available with card payments");
    await changeStripePlan(sub.providerSubscriptionId!, plan.stripePriceId);
    await audit(actorOf(req), params.teamId, "billing.plan_change_requested", { type: "plan", id: plan.id }, { proration: true });
    return { ok: true, message: "Your plan will update as soon as the payment provider confirms it." };
  });

  route(app, { method: "POST", url: "/teams/:teamId/billing/cancel", tags: ["billing"], params: teamParam }, async (req, _r, { params }) => {
    await teamAccess(req, params.teamId, "billing:manage");
    const db = getDb();
    const [sub] = await db.select().from(subscriptions).where(and(eq(subscriptions.teamId, params.teamId), eq(subscriptions.status, "active")));
    if (!sub) throw badRequest("No active subscription");
    if (sub.provider === "stripe") await cancelStripeSubscription(sub.providerSubscriptionId!, true);
    else if (sub.provider === "paypal") await cancelPaypalSubscription(sub.providerSubscriptionId!);
    await db.update(subscriptions).set({ cancelAtPeriodEnd: true, ...(sub.provider === "credits" ? { status: "cancelled" } : {}) }).where(eq(subscriptions.id, sub.id));
    await audit(actorOf(req), params.teamId, "billing.cancel_requested", { type: "subscription", id: sub.id });
    return { ok: true };
  });

  route(app, { method: "POST", url: "/teams/:teamId/billing/portal", tags: ["billing"], params: teamParam }, async (req, _r, { params }) => {
    const a = await teamAccess(req, params.teamId, "billing:manage");
    if (!a.team.stripeCustomerId) throw badRequest("No card payments yet");
    return { url: await billingPortalUrl(a.team.stripeCustomerId, `${serverConfig().SKYHOST_DASHBOARD_URL}/billing`) };
  });

  // ---------------------------------------------------------------------------------- Prepaid credits
  route(
    app,
    { method: "POST", url: "/teams/:teamId/billing/credits", tags: ["billing"], params: teamParam, body: z.object({ amountCents: z.number().int().min(500).max(1_000_000), provider: z.enum(["stripe", "paypal", "mobile_money"]) }) },
    async (req, _r, { params, body }) => {
      const a = await teamAccess(req, params.teamId, "billing:manage");
      const dash = serverConfig().SKYHOST_DASHBOARD_URL;
      const currency = serverConfig().BILLING_CURRENCY;
      if (body.provider === "stripe") {
        const customer = await ensureStripeCustomer(a.team, req.auth.user!.email);
        if (customer !== a.team.stripeCustomerId) await getDb().update(teams).set({ stripeCustomerId: customer }).where(eq(teams.id, params.teamId));
        return { url: await createCreditsCheckout({ customerId: customer, teamId: params.teamId, userId: req.auth.user!.id, amountCents: body.amountCents, currency, successUrl: `${dash}/billing?credits=success`, cancelUrl: `${dash}/billing` }) };
      }
      if (body.provider === "paypal") {
        const o = await createPaypalOrder({ teamId: params.teamId, amountCents: body.amountCents, currency, returnUrl: `${dash}/billing?paypal=return`, cancelUrl: `${dash}/billing` });
        return { url: o.approveUrl, orderId: o.id };
      }
      // The intended amount and currency are encoded in the reference: only the server creates these references
      // (with the Flutterwave secret key), and the webhook re-verifies the transaction through the API, so the
      // reference cannot be forged. The webhook credits this intended amount, never the amount the gateway returns.
      const txRef = `sky-${params.teamId.slice(0, 8)}-c${body.amountCents}-${currency.toLowerCase()}-${randomToken(8)}`;
      return { url: await createMobileMoneyPayment({ txRef, amountCents: body.amountCents, currency, email: req.auth.user!.email, name: req.auth.user!.name, redirectUrl: `${dash}/billing?credits=pending`, teamId: params.teamId }) };
    },
  );

  route(app, { method: "POST", url: "/teams/:teamId/billing/paypal/capture", tags: ["billing"], params: teamParam, body: z.object({ orderId: z.string().max(64) }) }, async (req, _r, { params, body }) => {
    await teamAccess(req, params.teamId, "billing:manage");
    const res = await capturePaypalOrder(body.orderId);
    const unit = res.purchase_units[0];
    if (res.status !== "COMPLETED" || unit?.custom_id !== `credits:${params.teamId}`) throw badRequest("The PayPal order is not completed for this team");
    const cap = unit.payments?.captures?.[0];
    if (cap) await recordPayment({ teamId: params.teamId, userId: req.auth.user!.id, provider: "paypal", providerPaymentId: cap.id, kind: "credits", amountCents: Math.round(Number(cap.amount.value) * 100), currency: cap.amount.currency_code.toLowerCase(), description: "Prepaid credits (PayPal)" });
    return { ok: true };
  });

  /** Pays one month of a plan from the prepaid credit balance. */
  route(app, { method: "POST", url: "/teams/:teamId/billing/pay-with-credits", tags: ["billing"], params: teamParam, body: z.object({ planId: z.string().uuid() }) }, async (req, _r, { params, body }) => {
    await teamAccess(req, params.teamId, "billing:manage");
    const db = getDb();
    const [plan] = await db.select().from(plans).where(eq(plans.id, body.planId));
    if (!plan || plan.isFree || plan.isContactSales) throw badRequest("Choose a paid plan");
    await assertFits(params.teamId, plan);
    const promo = await pendingDiscount(params.teamId);
    const price = discountedCents(plan.priceCents, promo);
    const debited = await db.update(teams).set({ creditBalanceCents: sql`${teams.creditBalanceCents} - ${price}` }).where(and(eq(teams.id, params.teamId), sql`${teams.creditBalanceCents} >= ${price}`)).returning();
    if (!debited.length) throw badRequest("Not enough credits");
    const ref = `credits-${randomToken(10)}`;
    if (promo) await consumePendingDiscount(params.teamId, promo.redemptionId);
    await db.insert(creditTransactions).values({ teamId: params.teamId, amountCents: -price, reason: "subscription", reference: ref });
    const now = new Date();
    const end = new Date(now);
    end.setUTCMonth(end.getUTCMonth() + 1);
    await activateSubscription({ teamId: params.teamId, planId: plan.id, provider: "credits", providerSubscriptionId: ref, status: "active", currentPeriodStart: now, currentPeriodEnd: end });
    await recordPayment({ teamId: params.teamId, userId: req.auth.user!.id, provider: "credits", providerPaymentId: ref, kind: "subscription", amountCents: price, currency: plan.currency, description: `${plan.name} plan (paid with credits${promo ? `, promo ${promo.code} -${promo.percentOff}%` : ""})`, periodStart: now, periodEnd: end });
    return { ok: true, currentPeriodEnd: end };
  });

  // ---------------------------------------------------------------------------------- Promo codes
  route(app, { method: "POST", url: "/teams/:teamId/billing/promo", tags: ["billing"], params: teamParam, body: z.object({ code: z.string().min(3).max(32) }), rateLimit: { max: 10, timeWindow: "10 minutes" } }, async (req, _r, { params, body }) => {
    await teamAccess(req, params.teamId, "billing:manage");
    return { promo: await redeemPromoCode(params.teamId, req.auth.user!.id, body.code) };
  });

  /**
   * Usage of the current period (calendar month), from the usage records written by the scheduler every minute,
   * and the plan cost attributed to each service by its share of CPU and memory.
   */
  route(app, { method: "GET", url: "/teams/:teamId/billing/usage", tags: ["billing"], params: teamParam }, async (req, _r, { params }) => {
    await teamAccess(req, params.teamId, "billing:read");
    const db = getDb();
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const daily = await db.execute(sql`
      select to_char(date_trunc('day', period_start), 'YYYY-MM-DD') as day, metric, sum(quantity)::float as q
      from usage_records where team_id = ${params.teamId} and period_start >= ${start.toISOString()}::timestamptz
      group by 1, 2 order by 1`);
    const perService = await db.execute(sql`
      select u.service_id, s.name as service, p.name as project, p.id as project_id, u.metric, sum(u.quantity)::float as q
      from usage_records u join services s on s.id = u.service_id join projects p on p.id = s.project_id
      where u.team_id = ${params.teamId} and u.period_start >= ${start.toISOString()}::timestamptz
      group by 1, 2, 3, 4, 5`);
    const builds = await db.execute(sql`
      select to_char(date_trunc('day', d.created_at), 'YYYY-MM-DD') as day, d.service_id, sum(coalesce(d.build_seconds, 0))::float as q
      from deployments d join services s on s.id = d.service_id join projects p on p.id = s.project_id
      where p.team_id = ${params.teamId} and d.created_at >= ${start.toISOString()}::timestamptz group by 1, 2`);
    type Row = Record<string, unknown>;
    const rows = (r: unknown) => ((r as { rows?: Row[] }).rows ?? (r as Row[]));
    const days = new Map<string, { day: string; cpuHours: number; memoryGbHours: number; egressGb: number; buildMinutes: number }>();
    for (let d = new Date(start); d < end && d <= now; d = new Date(d.getTime() + 86400_000)) {
      const k = d.toISOString().slice(0, 10);
      days.set(k, { day: k, cpuHours: 0, memoryGbHours: 0, egressGb: 0, buildMinutes: 0 });
    }
    const add = (o: { cpuHours: number; memoryGbHours: number; egressGb: number; buildMinutes: number }, metric: string, q: number) => {
      if (metric === "cpu_seconds") o.cpuHours += q / 3600;
      else if (metric === "memory_mb_seconds") o.memoryGbHours += q / 1024 / 3600;
      else if (metric === "bandwidth_bytes") o.egressGb += q / 1024 ** 3;
    };
    for (const r of rows(daily)) { const d = days.get(String(r.day)); if (d) add(d, String(r.metric), Number(r.q)); }
    for (const r of rows(builds)) { const d = days.get(String(r.day)); if (d) d.buildMinutes += Number(r.q) / 60; }
    const services = new Map<string, { serviceId: string; service: string; project: string; projectId: string; cpuHours: number; memoryGbHours: number; egressGb: number; buildMinutes: number }>();
    for (const r of rows(perService)) {
      const id = String(r.service_id);
      const s = services.get(id) ?? { serviceId: id, service: String(r.service), project: String(r.project), projectId: String(r.project_id), cpuHours: 0, memoryGbHours: 0, egressGb: 0, buildMinutes: 0 };
      add(s, String(r.metric), Number(r.q));
      services.set(id, s);
    }
    for (const r of rows(builds)) { const s = services.get(String(r.service_id)); if (s) s.buildMinutes += Number(r.q) / 60; }
    const plan = await getTeamPlan(params.teamId);
    const promo = await pendingDiscount(params.teamId);
    const charge = await usageCharge(params.teamId, start, end);
    const list = [...services.values()];
    // Attribution weight: CPU hours and memory GB-hours, each normalised by the team total.
    const tot = list.reduce((a, s) => ({ cpu: a.cpu + s.cpuHours, mem: a.mem + s.memoryGbHours }), { cpu: 0, mem: 0 });
    const weighted = list.map((s) => ({ ...s, share: (tot.cpu ? s.cpuHours / tot.cpu : 0) / 2 + (tot.mem ? s.memoryGbHours / tot.mem : 0) / 2 }));
    return {
      period: { start, end },
      plan: { slug: plan.slug, name: plan.name, priceCents: plan.priceCents, currency: plan.currency },
      estimate: { planCents: plan.priceCents, discountCents: plan.priceCents - discountedCents(plan.priceCents, promo), usage: charge, totalCents: discountedCents(plan.priceCents, promo) + charge.billableCents, promo },
      daily: [...days.values()],
      services: weighted.sort((a, b) => b.share - a.share).map((s) => ({ ...s, share: Math.round(s.share * 1000) / 10, attributedCents: Math.round(plan.priceCents * s.share) })),
    };
  });

  route(app, { method: "GET", url: "/invoices/:id/pdf", tags: ["billing"], params: idParam }, async (req, reply, { params }) => {
    const db = getDb();
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, params.id));
    if (!inv) throw notFound("Invoice");
    const a = await teamAccess(req, inv.teamId, "billing:read");
    const pdf = await renderInvoicePdf(inv, a.team);
    reply.header("Content-Type", "application/pdf").header("Content-Disposition", `attachment; filename="${inv.number}.pdf"`);
    return reply.send(pdf);
  });

  void users;
}
