import Stripe from "stripe";
import { serverConfig } from "../config";
import { unavailable } from "../errors";

let client: Stripe | null = null;

export function stripeConfigured() {
  const c = serverConfig();
  return !!c.STRIPE_SECRET_KEY && c.SKYHOST_PAYMENTS_ENABLED;
}

export function stripe(): Stripe {
  const c = serverConfig();
  if (!c.STRIPE_SECRET_KEY) throw unavailable("Card payments are not available yet on this SKYHOST installation.");
  if (!c.SKYHOST_PAYMENTS_ENABLED) throw unavailable("Online payments are not available yet on this SKYHOST installation.");
  client ??= new Stripe(c.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, appInfo: { name: "SKYHOST" } });
  return client;
}

/**
 * Verifies the Stripe-Signature header against the raw body. Throws on invalid signature or a timestamp outside
 * the tolerance window (anti-replay). Does not need API keys.
 */
export function verifyStripeWebhook(rawBody: Buffer | string, signature: string | undefined): Stripe.Event {
  const secret = serverConfig().STRIPE_WEBHOOK_SECRET;
  if (!secret) throw unavailable("STRIPE_WEBHOOK_SECRET is not configured");
  if (!signature) throw new Error("Missing Stripe-Signature header");
  return Stripe.webhooks.constructEvent(rawBody, signature, secret, 300);
}

export async function ensureStripeCustomer(team: { id: string; name: string; billingEmail: string | null; stripeCustomerId: string | null }, email: string) {
  if (team.stripeCustomerId) {
    // A customer created with the test keys does not exist once the live keys are in place (and vice versa),
    // and a customer may have been deleted in Stripe: create a new one instead of failing every checkout.
    const existing = await stripe().customers.retrieve(team.stripeCustomerId).catch((e: { code?: string }) => {
      if (e?.code === "resource_missing") return null;
      throw e;
    });
    if (existing && !existing.deleted) return team.stripeCustomerId;
  }
  const key = team.stripeCustomerId ? `customer-${team.id}-replaces-${team.stripeCustomerId}` : `customer-${team.id}`;
  const customer = await stripe().customers.create({ name: team.name, email: team.billingEmail ?? email, metadata: { teamId: team.id } }, { idempotencyKey: key });
  return customer.id;
}

export async function createSubscriptionCheckout(o: { customerId: string; teamId: string; userId: string; priceId: string; planId: string; successUrl: string; cancelUrl: string; trialDays?: number; promo?: { redemptionId: string; code: string; percentOff: number } | null }) {
  // A SKYHOST promo code becomes a single-use Stripe coupon on the first invoice (Stripe codes are then disabled).
  const coupon = o.promo ? await stripe().coupons.create({ percent_off: o.promo.percentOff, duration: "once", max_redemptions: 1, name: `SKYHOST ${o.promo.code}`, metadata: { teamId: o.teamId, redemptionId: o.promo.redemptionId } }) : null;
  const promoMeta: Record<string, string> = o.promo ? { promoRedemptionId: o.promo.redemptionId } : {};
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer: o.customerId,
    line_items: [{ price: o.priceId, quantity: 1 }],
    success_url: o.successUrl,
    cancel_url: o.cancelUrl,
    client_reference_id: o.teamId,
    ...(coupon ? { discounts: [{ coupon: coupon.id }] } : { allow_promotion_codes: true }),
    automatic_tax: { enabled: false },
    subscription_data: { metadata: { teamId: o.teamId, planId: o.planId, userId: o.userId }, ...(o.trialDays ? { trial_period_days: o.trialDays } : {}) },
    metadata: { teamId: o.teamId, planId: o.planId, userId: o.userId, kind: "subscription", ...promoMeta },
  });
  return session.url!;
}

export async function createCreditsCheckout(o: { customerId: string; teamId: string; userId: string; amountCents: number; currency: string; successUrl: string; cancelUrl: string }) {
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    customer: o.customerId,
    line_items: [{ price_data: { currency: o.currency, unit_amount: o.amountCents, product_data: { name: "SKYHOST prepaid credits" } }, quantity: 1 }],
    success_url: o.successUrl,
    cancel_url: o.cancelUrl,
    client_reference_id: o.teamId,
    payment_intent_data: { metadata: { teamId: o.teamId, userId: o.userId, kind: "credits" } },
    metadata: { teamId: o.teamId, userId: o.userId, kind: "credits" },
  });
  return session.url!;
}

/** Changes the plan of an existing subscription with proration. */
export async function changeStripePlan(subscriptionId: string, priceId: string) {
  const sub = await stripe().subscriptions.retrieve(subscriptionId);
  const item = sub.items.data[0];
  return stripe().subscriptions.update(subscriptionId, { items: [{ id: item!.id, price: priceId }], proration_behavior: "create_prorations" });
}

export async function cancelStripeSubscription(subscriptionId: string, atPeriodEnd = true) {
  if (atPeriodEnd) return stripe().subscriptions.update(subscriptionId, { cancel_at_period_end: true });
  return stripe().subscriptions.cancel(subscriptionId);
}

export async function refundStripePayment(paymentIntentOrCharge: string, amountCents?: number) {
  const key = paymentIntentOrCharge.startsWith("pi_") ? { payment_intent: paymentIntentOrCharge } : { charge: paymentIntentOrCharge };
  return stripe().refunds.create({ ...key, ...(amountCents ? { amount: amountCents } : {}) });
}

export async function billingPortalUrl(customerId: string, returnUrl: string) {
  const s = await stripe().billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
  return s.url;
}

export async function stripeTransfer(accountId: string, amountCents: number, currency: string, reference: string) {
  return stripe().transfers.create({ amount: amountCents, currency, destination: accountId, metadata: { reference } }, { idempotencyKey: `payout-${reference}` });
}
