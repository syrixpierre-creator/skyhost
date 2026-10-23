import { and, count, desc, eq, sql } from "drizzle-orm";
import {
  billingEvents, creditTransactions, getDb, invoices, payments, paymentMethods, plans, serviceInstances, services, projects, subscriptions, taxRates, teams,
} from "@skyhost/db";
import { audit } from "../audit";
import { notify } from "../notify";
import { getSetting } from "../settings";
import { onPaymentRefunded, onPaymentSucceeded } from "../referral";
import { publish } from "../realtime";

export type Provider = "stripe" | "paypal" | "flutterwave" | "credits" | "manual";

/**
 * Stores a verified provider event. Returns false when the event was already processed (idempotency):
 * providers retry deliveries, and the same event must never be applied twice.
 */
export async function recordBillingEvent(provider: Provider, eventId: string, type: string, payload: unknown, teamId?: string | null): Promise<string | null> {
  const [row] = await getDb()
    .insert(billingEvents)
    .values({ provider, eventId, type, payload: payload as object, teamId: teamId ?? null })
    .onConflictDoNothing()
    .returning({ id: billingEvents.id });
  return row?.id ?? null;
}

export async function markBillingEventProcessed(id: string, error?: string) {
  await getDb().update(billingEvents).set({ processedAt: new Date(), error: error ?? null }).where(eq(billingEvents.id, id));
}

export async function taxFor(teamId: string, subtotalCents: number): Promise<{ taxCents: number; percent: number; name: string | null }> {
  const db = getDb();
  const [team] = await db.select({ country: teams.billingCountry, taxId: teams.taxId }).from(teams).where(eq(teams.id, teamId));
  const settings = await getSetting("billing");
  let percent = settings.defaultTaxPercent;
  let name: string | null = percent ? "Tax" : null;
  if (team?.country) {
    const [rate] = await db.select().from(taxRates).where(eq(taxRates.country, team.country.toUpperCase()));
    if (rate) {
      percent = rate.reverseCharge && team.taxId ? 0 : rate.percent;
      name = rate.name;
    }
  }
  return { taxCents: Math.round((subtotalCents * percent) / (100 + percent)), percent, name };
}

async function nextInvoiceNumber() {
  const year = new Date().getUTCFullYear();
  const [r] = await getDb().select({ c: count() }).from(invoices).where(sql`extract(year from ${invoices.createdAt}) = ${year}`);
  return `SKY-${year}-${String(Number(r?.c ?? 0) + 1).padStart(6, "0")}`;
}

export interface PaymentInput {
  teamId: string;
  userId?: string | null;
  provider: Provider;
  providerPaymentId: string;
  kind: "subscription" | "credits";
  amountCents: number;
  currency: string;
  description: string;
  subscriptionId?: string | null;
  paymentMethodFingerprint?: string | null;
  providerInvoiceId?: string | null;
  hostedUrl?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}

/** Records a successful payment exactly once (unique provider id), creates the invoice and runs side effects. */
export async function recordPayment(p: PaymentInput) {
  const db = getDb();
  const { taxCents } = await taxFor(p.teamId, p.amountCents);
  const [payment] = await db
    .insert(payments)
    .values({
      teamId: p.teamId,
      userId: p.userId ?? null,
      provider: p.provider,
      providerPaymentId: p.providerPaymentId,
      kind: p.kind,
      amountCents: p.amountCents,
      taxCents,
      currency: p.currency,
      status: "succeeded",
      paymentMethodFingerprint: p.paymentMethodFingerprint ?? null,
      subscriptionId: p.subscriptionId ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!payment) return null; // already recorded
  const [invoice] = await db
    .insert(invoices)
    .values({
      teamId: p.teamId,
      number: await nextInvoiceNumber(),
      provider: p.provider,
      providerInvoiceId: p.providerInvoiceId ?? null,
      status: "paid",
      subtotalCents: p.amountCents - taxCents,
      taxCents,
      totalCents: p.amountCents,
      currency: p.currency,
      lines: [{ description: p.description, amountCents: p.amountCents - taxCents, quantity: 1 }],
      periodStart: p.periodStart ?? null,
      periodEnd: p.periodEnd ?? null,
      hostedUrl: p.hostedUrl ?? null,
      paidAt: new Date(),
    })
    .returning();
  await db.update(payments).set({ invoiceId: invoice!.id }).where(eq(payments.id, payment.id));

  if (p.kind === "credits") await addCredits(p.teamId, p.amountCents - taxCents, "topup", payment.id);
  await reactivateIfSuspended(p.teamId);
  await audit({ userId: p.userId ?? null }, p.teamId, "billing.payment_succeeded", { type: "payment", id: payment.id }, { provider: p.provider, amountCents: p.amountCents, kind: p.kind });
  await notify({ teamId: p.teamId, event: "billing.payment_succeeded", title: "Payment received", body: `We received your payment of ${(p.amountCents / 100).toFixed(2)} ${p.currency.toUpperCase()}. Invoice ${invoice!.number}.`, link: "/billing" });
  await onPaymentSucceeded(payment);
  return payment;
}

export async function addCredits(teamId: string, amountCents: number, reason: string, reference: string) {
  const db = getDb();
  const [tx] = await db.insert(creditTransactions).values({ teamId, amountCents, reason, reference }).onConflictDoNothing().returning();
  if (!tx) return false;
  await db.update(teams).set({ creditBalanceCents: sql`${teams.creditBalanceCents} + ${amountCents}` }).where(eq(teams.id, teamId));
  return true;
}

export async function activateSubscription(o: {
  teamId: string;
  planId: string;
  provider: Provider;
  providerSubscriptionId: string;
  status: string;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
}) {
  const db = getDb();
  const [plan] = await db.select().from(plans).where(eq(plans.id, o.planId));
  if (!plan) throw new Error(`Unknown plan ${o.planId}`);
  const values = {
    teamId: o.teamId,
    planId: o.planId,
    provider: o.provider,
    providerSubscriptionId: o.providerSubscriptionId,
    status: o.status,
    currentPeriodStart: o.currentPeriodStart ?? null,
    currentPeriodEnd: o.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: o.cancelAtPeriodEnd ?? false,
    updatedAt: new Date(),
  };
  await db
    .insert(subscriptions)
    .values(values)
    .onConflictDoUpdate({ target: [subscriptions.provider, subscriptions.providerSubscriptionId], set: values });
  const active = o.status === "active" || o.status === "trialing";
  if (active) {
    await db.update(teams).set({ planId: o.planId, billingStatus: o.status, graceEndsAt: null, updatedAt: new Date() }).where(eq(teams.id, o.teamId));
    await publish(`team:${o.teamId}`, { type: "billing.updated", plan: plan.slug });
  }
  await audit(null, o.teamId, "billing.subscription_updated", { type: "subscription", id: o.providerSubscriptionId }, { status: o.status, plan: plan.slug, provider: o.provider });
}

export async function subscriptionEnded(provider: Provider, providerSubscriptionId: string) {
  const db = getDb();
  const [sub] = await db.select().from(subscriptions).where(and(eq(subscriptions.provider, provider), eq(subscriptions.providerSubscriptionId, providerSubscriptionId)));
  if (!sub) return;
  await db.update(subscriptions).set({ status: "cancelled", updatedAt: new Date() }).where(eq(subscriptions.id, sub.id));
  const trial = (await getSetting("billing")).trialPlan;
  const [free] = await db.select().from(plans).where(eq(plans.slug, trial));
  await db.update(teams).set({ planId: free?.id ?? null, billingStatus: "cancelled", updatedAt: new Date() }).where(eq(teams.id, sub.teamId));
  await audit(null, sub.teamId, "billing.subscription_cancelled", { type: "subscription", id: providerSubscriptionId });
}

/** A failed renewal starts the grace period; services are suspended when it ends without payment. */
export async function paymentFailed(provider: Provider, providerSubscriptionId: string | null, teamId: string, reason: string) {
  const db = getDb();
  const settings = await getSetting("billing");
  if (providerSubscriptionId) {
    await db
      .update(subscriptions)
      .set({ status: "past_due", failedPaymentCount: sql`${subscriptions.failedPaymentCount} + 1`, updatedAt: new Date() })
      .where(and(eq(subscriptions.provider, provider), eq(subscriptions.providerSubscriptionId, providerSubscriptionId)));
  }
  const graceEndsAt = new Date(Date.now() + settings.graceDays * 24 * 3600 * 1000);
  await db.update(teams).set({ billingStatus: "past_due", graceEndsAt: sql`coalesce(${teams.graceEndsAt}, ${graceEndsAt.toISOString()}::timestamptz)` }).where(eq(teams.id, teamId));
  await notify({
    teamId,
    event: "billing.payment_failed",
    title: "Payment failed",
    body: `We could not charge your payment method (${reason}). Update it before ${graceEndsAt.toDateString()} to avoid service suspension.`,
    link: "/billing",
  });
  await audit(null, teamId, "billing.payment_failed", null, { provider, reason });
}

export async function paymentRefunded(provider: Provider, providerPaymentId: string, refundedCents: number, disputed = false) {
  const db = getDb();
  const [p] = await db.select().from(payments).where(and(eq(payments.provider, provider), eq(payments.providerPaymentId, providerPaymentId)));
  if (!p) return null;
  const full = refundedCents >= p.amountCents;
  await db
    .update(payments)
    .set({ refundedCents, status: disputed ? "disputed" : full ? "refunded" : "partially_refunded" })
    .where(eq(payments.id, p.id));
  if (p.invoiceId && full) await db.update(invoices).set({ status: "refunded" }).where(eq(invoices.id, p.invoiceId));
  if (p.kind === "credits") await addCredits(p.teamId, -Math.min(refundedCents, p.amountCents - p.taxCents), "refund", `refund:${p.id}:${refundedCents}`);
  await onPaymentRefunded(p.id, disputed ? "chargeback" : "refund");
  await audit(null, p.teamId, disputed ? "billing.chargeback" : "billing.refund", { type: "payment", id: p.id }, { refundedCents });
  return p;
}

async function reactivateIfSuspended(teamId: string) {
  const db = getDb();
  const [t] = await db.select().from(teams).where(eq(teams.id, teamId));
  if (!t || (t.billingStatus !== "suspended" && t.billingStatus !== "past_due")) return;
  await db.update(teams).set({ billingStatus: "active", graceEndsAt: null }).where(eq(teams.id, teamId));
  if (t.billingStatus === "suspended") {
    const svc = await db.select({ id: serviceInstances.id }).from(serviceInstances).innerJoin(services, eq(services.id, serviceInstances.serviceId)).innerJoin(projects, eq(projects.id, services.projectId)).where(and(eq(projects.teamId, teamId), eq(serviceInstances.pausedReason, "billing")));
    for (const s of svc) await db.update(serviceInstances).set({ status: "running", pausedReason: null }).where(eq(serviceInstances.id, s.id));
    await audit(null, teamId, "billing.reactivated", null);
  }
}

export async function upsertPaymentMethod(teamId: string, provider: Provider, pm: { id: string; brand?: string | null; last4?: string | null; expMonth?: number | null; expYear?: number | null; fingerprint?: string | null }) {
  const db = getDb();
  const [existing] = await db.select().from(paymentMethods).where(and(eq(paymentMethods.teamId, teamId), eq(paymentMethods.providerPaymentMethodId, pm.id)));
  if (existing) return;
  await db.update(paymentMethods).set({ isDefault: false }).where(eq(paymentMethods.teamId, teamId));
  await db.insert(paymentMethods).values({ teamId, provider, providerPaymentMethodId: pm.id, brand: pm.brand ?? null, last4: pm.last4 ?? null, expMonth: pm.expMonth ?? null, expYear: pm.expYear ?? null, fingerprint: pm.fingerprint ?? null, isDefault: true });
}

export async function teamBillingOverview(teamId: string) {
  const db = getDb();
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  const subs = await db.select().from(subscriptions).where(eq(subscriptions.teamId, teamId)).orderBy(desc(subscriptions.createdAt)).limit(5);
  const inv = await db.select().from(invoices).where(eq(invoices.teamId, teamId)).orderBy(desc(invoices.createdAt)).limit(50);
  const methods = await db.select().from(paymentMethods).where(eq(paymentMethods.teamId, teamId));
  const credits = await db.select().from(creditTransactions).where(eq(creditTransactions.teamId, teamId)).orderBy(desc(creditTransactions.createdAt)).limit(50);
  return {
    status: team?.billingStatus,
    creditBalanceCents: team?.creditBalanceCents ?? 0,
    graceEndsAt: team?.graceEndsAt,
    spendCapCents: team?.spendCapCents,
    spendCapAction: team?.spendCapAction,
    subscription: subs[0] ?? null,
    invoices: inv,
    paymentMethods: methods.map((m) => ({ id: m.id, provider: m.provider, brand: m.brand, last4: m.last4, expMonth: m.expMonth, expYear: m.expYear, isDefault: m.isDefault })),
    credits,
  };
}
