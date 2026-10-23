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
    return { ...(await teamBillingOverview(params.teamId)), usage: await usageSummary(params.teamId) };
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
        const url = await createSubscriptionCheckout({ customerId: customer, teamId: params.teamId, userId: req.auth.user!.id, priceId: plan.stripePriceId, planId: plan.id, successUrl: `${dash}/billing?checkout=success`, cancelUrl: `${dash}/billing?checkout=cancelled`, trialDays: plan.trialDays || undefined });
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
      const txRef = `sky-${params.teamId.slice(0, 8)}-${randomToken(8)}`;
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
    const debited = await db.update(teams).set({ creditBalanceCents: sql`${teams.creditBalanceCents} - ${plan.priceCents}` }).where(and(eq(teams.id, params.teamId), sql`${teams.creditBalanceCents} >= ${plan.priceCents}`)).returning();
    if (!debited.length) throw badRequest("Not enough credits");
    const ref = `credits-${randomToken(10)}`;
    await db.insert(creditTransactions).values({ teamId: params.teamId, amountCents: -plan.priceCents, reason: "subscription", reference: ref });
    const now = new Date();
    const end = new Date(now);
    end.setUTCMonth(end.getUTCMonth() + 1);
    await activateSubscription({ teamId: params.teamId, planId: plan.id, provider: "credits", providerSubscriptionId: ref, status: "active", currentPeriodStart: now, currentPeriodEnd: end });
    await recordPayment({ teamId: params.teamId, userId: req.auth.user!.id, provider: "credits", providerPaymentId: ref, kind: "subscription", amountCents: plan.priceCents, currency: plan.currency, description: `${plan.name} plan (paid with credits)`, periodStart: now, periodEnd: end });
    return { ok: true, currentPeriodEnd: end };
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
