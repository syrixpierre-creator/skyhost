import { and, eq } from "drizzle-orm";
import { getDb, payments, plans, subscriptions, teams } from "@skyhost/db";
import { activateSubscription, addCredits, markBillingEventProcessed, paymentFailed, paymentRefunded, recordBillingEvent, recordPayment, subscriptionEnded, upsertPaymentMethod } from "./service";
import { recheckRewardCard } from "../referral-card";
import { consumePendingDiscount } from "./promo";

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Reads the first defined value among dotted paths (Stripe moved fields between API versions). */
function pick(obj: Any, ...paths: string[]): any {
  for (const p of paths) {
    let cur: any = obj;
    for (const k of p.split(".")) cur = cur?.[k];
    if (cur !== undefined && cur !== null) return cur;
  }
  return undefined;
}

const toDate = (s?: number | null) => (s ? new Date(s * 1000) : null);

async function teamForSubscription(provider: string, subId: string | undefined, meta?: Any): Promise<{ teamId: string; planId?: string } | null> {
  if (meta?.teamId) return { teamId: meta.teamId, planId: meta.planId };
  if (!subId) return null;
  const [s] = await getDb().select().from(subscriptions).where(and(eq(subscriptions.provider, provider), eq(subscriptions.providerSubscriptionId, subId)));
  return s ? { teamId: s.teamId, planId: s.planId } : null;
}

async function planByStripePrice(priceId?: string) {
  if (!priceId) return null;
  const [p] = await getDb().select().from(plans).where(eq(plans.stripePriceId, priceId));
  return p ?? null;
}

/** Applies a verified Stripe event. Idempotent: replays of the same event id are ignored. */
export async function handleStripeEvent(event: { id: string; type: string; data: { object: Any } }): Promise<"processed" | "duplicate" | "ignored"> {
  const obj = event.data.object;
  const eventRow = await recordBillingEvent("stripe", event.id, event.type, event, pick(obj, "metadata.teamId") ?? null);
  if (!eventRow) return "duplicate";
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        if (obj.mode === "payment" && obj.metadata?.kind === "credits" && obj.payment_status === "paid") {
          await recordPayment({
            teamId: obj.metadata.teamId,
            userId: obj.metadata.userId ?? null,
            provider: "stripe",
            providerPaymentId: String(obj.payment_intent ?? obj.id),
            kind: "credits",
            amountCents: obj.amount_total,
            currency: obj.currency,
            description: "Prepaid credits",
          });
        }
        if (obj.mode === "subscription" && obj.customer && obj.metadata?.teamId) {
          await getDb().update(teams).set({ stripeCustomerId: String(obj.customer) }).where(eq(teams.id, obj.metadata.teamId));
          if (obj.metadata.promoRedemptionId) await consumePendingDiscount(obj.metadata.teamId, obj.metadata.promoRedemptionId);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const priceId = pick(obj, "items.data.0.price.id");
        const byPrice = await planByStripePrice(priceId);
        const owner = await teamForSubscription("stripe", obj.id, obj.metadata);
        if (!owner) return "ignored";
        const planId = byPrice?.id ?? owner.planId;
        if (!planId) return "ignored";
        await activateSubscription({
          teamId: owner.teamId,
          planId,
          provider: "stripe",
          providerSubscriptionId: obj.id,
          status: obj.status === "canceled" ? "cancelled" : obj.status,
          currentPeriodStart: toDate(pick(obj, "current_period_start", "items.data.0.current_period_start")),
          currentPeriodEnd: toDate(pick(obj, "current_period_end", "items.data.0.current_period_end")),
          cancelAtPeriodEnd: !!obj.cancel_at_period_end,
        });
        break;
      }
      case "customer.subscription.deleted":
        await subscriptionEnded("stripe", obj.id);
        break;
      case "invoice.paid": {
        if (!obj.amount_paid) break;
        const subId = pick(obj, "subscription", "parent.subscription_details.subscription");
        const owner = await teamForSubscription("stripe", subId, pick(obj, "subscription_details.metadata", "parent.subscription_details.metadata"));
        if (!owner) return "ignored";
        const [sub] = subId ? await getDb().select().from(subscriptions).where(and(eq(subscriptions.provider, "stripe"), eq(subscriptions.providerSubscriptionId, subId))) : [];
        await recordPayment({
          teamId: owner.teamId,
          provider: "stripe",
          providerPaymentId: String(pick(obj, "payment_intent", "payments.data.0.payment.payment_intent", "charge") ?? obj.id),
          kind: "subscription",
          amountCents: obj.amount_paid,
          currency: obj.currency,
          description: pick(obj, "lines.data.0.description") ?? "Subscription",
          subscriptionId: sub?.id ?? null,
          providerInvoiceId: obj.id,
          hostedUrl: obj.hosted_invoice_url ?? null,
          periodStart: toDate(pick(obj, "lines.data.0.period.start", "period_start")),
          periodEnd: toDate(pick(obj, "lines.data.0.period.end", "period_end")),
        });
        break;
      }
      case "invoice.payment_failed": {
        const subId = pick(obj, "subscription", "parent.subscription_details.subscription");
        const owner = await teamForSubscription("stripe", subId, pick(obj, "subscription_details.metadata", "parent.subscription_details.metadata"));
        if (!owner) return "ignored";
        await paymentFailed("stripe", subId ?? null, owner.teamId, pick(obj, "last_finalization_error.message") ?? "card declined");
        break;
      }
      case "charge.succeeded": {
        const card = pick(obj, "payment_method_details.card");
        const teamId = pick(obj, "metadata.teamId") ?? (await teamByCustomer(String(obj.customer ?? "")));
        if (card && teamId) {
          await upsertPaymentMethod(teamId, "stripe", { id: String(obj.payment_method ?? obj.id), brand: card.brand, last4: card.last4, expMonth: card.exp_month, expYear: card.exp_year, fingerprint: card.fingerprint });
          const pi = String(obj.payment_intent ?? obj.id);
          await getDb().update(payments).set({ paymentMethodFingerprint: card.fingerprint }).where(and(eq(payments.provider, "stripe"), eq(payments.providerPaymentId, pi)));
          await recheckRewardCard("stripe", pi, card.fingerprint);
        }
        break;
      }
      case "charge.refunded":
        await paymentRefunded("stripe", String(obj.payment_intent ?? obj.id), obj.amount_refunded);
        break;
      case "charge.dispute.created":
        await paymentRefunded("stripe", String(obj.payment_intent ?? obj.charge), obj.amount, true);
        break;
      default:
        await markBillingEventProcessed(eventRow);
        return "ignored";
    }
    await markBillingEventProcessed(eventRow);
    return "processed";
  } catch (e) {
    await markBillingEventProcessed(eventRow, (e as Error).message);
    throw e;
  }
}

async function teamByCustomer(customerId: string) {
  if (!customerId) return null;
  const [t] = await getDb().select({ id: teams.id }).from(teams).where(eq(teams.stripeCustomerId, customerId));
  return t?.id ?? null;
}

/** PayPal events (already verified through PayPal's verification API). */
export async function handlePaypalEvent(event: { id: string; event_type: string; resource: Any }): Promise<"processed" | "duplicate" | "ignored"> {
  const r = event.resource;
  const eventRow = await recordBillingEvent("paypal", event.id, event.event_type, event, null);
  if (!eventRow) return "duplicate";
  try {
    switch (event.event_type) {
      case "BILLING.SUBSCRIPTION.ACTIVATED":
      case "BILLING.SUBSCRIPTION.UPDATED": {
        const teamId = r.custom_id;
        const [plan] = await getDb().select().from(plans).where(eq(plans.paypalPlanId, r.plan_id));
        if (!teamId || !plan) return "ignored";
        await activateSubscription({ teamId, planId: plan.id, provider: "paypal", providerSubscriptionId: r.id, status: "active", currentPeriodStart: r.start_time ? new Date(r.start_time) : null, currentPeriodEnd: r.billing_info?.next_billing_time ? new Date(r.billing_info.next_billing_time) : null });
        break;
      }
      case "BILLING.SUBSCRIPTION.CANCELLED":
      case "BILLING.SUBSCRIPTION.EXPIRED":
        await subscriptionEnded("paypal", r.id);
        break;
      case "BILLING.SUBSCRIPTION.PAYMENT.FAILED": {
        const owner = await teamForSubscription("paypal", r.id, { teamId: r.custom_id });
        if (owner) await paymentFailed("paypal", r.id, owner.teamId, "PayPal payment failed");
        break;
      }
      case "PAYMENT.SALE.COMPLETED": {
        const owner = await teamForSubscription("paypal", r.billing_agreement_id, undefined);
        if (!owner) return "ignored";
        await recordPayment({ teamId: owner.teamId, provider: "paypal", providerPaymentId: r.id, kind: "subscription", amountCents: Math.round(Number(r.amount?.total ?? 0) * 100), currency: String(r.amount?.currency ?? "USD").toLowerCase(), description: "Subscription (PayPal)" });
        break;
      }
      case "PAYMENT.CAPTURE.COMPLETED": {
        const custom = String(r.custom_id ?? "");
        if (!custom.startsWith("credits:")) return "ignored";
        await recordPayment({ teamId: custom.slice(8), provider: "paypal", providerPaymentId: r.id, kind: "credits", amountCents: Math.round(Number(r.amount?.value ?? 0) * 100), currency: String(r.amount?.currency_code ?? "USD").toLowerCase(), description: "Prepaid credits (PayPal)" });
        break;
      }
      case "PAYMENT.SALE.REFUNDED":
      case "PAYMENT.CAPTURE.REFUNDED": {
        const original = r.sale_id ?? r.links?.find((l: Any) => l.rel === "up")?.href?.split("/").pop();
        if (original) await paymentRefunded("paypal", original, Math.round(Number(r.amount?.total ?? r.amount?.value ?? 0) * 100));
        break;
      }
      case "CUSTOMER.DISPUTE.CREATED": {
        const tx = r.disputed_transactions?.[0]?.seller_transaction_id;
        if (tx) await paymentRefunded("paypal", tx, Math.round(Number(r.dispute_amount?.value ?? 0) * 100), true);
        break;
      }
      default:
        await markBillingEventProcessed(eventRow);
        return "ignored";
    }
    await markBillingEventProcessed(eventRow);
    return "processed";
  } catch (e) {
    await markBillingEventProcessed(eventRow, (e as Error).message);
    throw e;
  }
}

/** Flutterwave (Mobile Money) — called with the transaction re-verified from the API. */
export async function handleFlutterwaveTransaction(tx: { id: number; tx_ref: string; status: string; amount: number; currency: string; meta?: Record<string, string> }) {
  const eventRow = await recordBillingEvent("flutterwave", String(tx.id), `charge.${tx.status}`, tx, tx.meta?.teamId ?? null);
  if (!eventRow) return "duplicate" as const;
  if (tx.status !== "successful" || !tx.meta?.teamId) {
    await markBillingEventProcessed(eventRow);
    return "ignored" as const;
  }
  await recordPayment({ teamId: tx.meta.teamId, userId: tx.meta.userId ?? null, provider: "flutterwave", providerPaymentId: String(tx.id), kind: "credits", amountCents: Math.round(tx.amount * 100), currency: tx.currency.toLowerCase(), description: "Prepaid credits (Mobile Money)" });
  await markBillingEventProcessed(eventRow);
  return "processed" as const;
}

export { addCredits };
