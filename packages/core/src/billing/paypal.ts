import { serverConfig } from "../config";
import { unavailable } from "../errors";

let token: { value: string; expiresAt: number } | null = null;

export function paypalConfigured() {
  const c = serverConfig();
  return !!c.PAYPAL_CLIENT_ID && !!c.PAYPAL_CLIENT_SECRET && c.SKYHOST_PAYMENTS_ENABLED;
}

async function accessToken(): Promise<string> {
  const c = serverConfig();
  if (!c.PAYPAL_CLIENT_ID || !c.PAYPAL_CLIENT_SECRET) throw unavailable("PayPal is not configured");
  if (!c.SKYHOST_PAYMENTS_ENABLED) throw unavailable("Payments are disabled in this environment");
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const res = await fetch(`${c.PAYPAL_API_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${c.PAYPAL_CLIENT_ID}:${c.PAYPAL_CLIENT_SECRET}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw unavailable(`PayPal authentication failed (${res.status})`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  return token.value;
}

async function call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const res = await fetch(`${serverConfig().PAYPAL_API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", ...(idempotencyKey ? { "PayPal-Request-Id": idempotencyKey } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PayPal ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export async function createPaypalSubscription(o: { planId: string; teamId: string; returnUrl: string; cancelUrl: string }) {
  const r = await call<{ id: string; links: Array<{ rel: string; href: string }> }>(
    "POST",
    "/v1/billing/subscriptions",
    { plan_id: o.planId, custom_id: o.teamId, application_context: { brand_name: "SKYHOST", return_url: o.returnUrl, cancel_url: o.cancelUrl, user_action: "SUBSCRIBE_NOW" } },
    `sub-${o.teamId}-${o.planId}-${Date.now()}`,
  );
  return { id: r.id, approveUrl: r.links.find((l) => l.rel === "approve")?.href ?? "" };
}

export async function createPaypalOrder(o: { teamId: string; amountCents: number; currency: string; returnUrl: string; cancelUrl: string }) {
  const r = await call<{ id: string; links: Array<{ rel: string; href: string }> }>("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{ custom_id: `credits:${o.teamId}`, amount: { currency_code: o.currency.toUpperCase(), value: (o.amountCents / 100).toFixed(2) }, description: "SKYHOST prepaid credits" }],
    application_context: { brand_name: "SKYHOST", return_url: o.returnUrl, cancel_url: o.cancelUrl },
  });
  return { id: r.id, approveUrl: r.links.find((l) => l.rel === "approve")?.href ?? "" };
}

export async function capturePaypalOrder(orderId: string) {
  return call<{ status: string; purchase_units: Array<{ custom_id?: string; payments?: { captures?: Array<{ id: string; amount: { value: string; currency_code: string } }> } }> }>(
    "POST",
    `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    {},
    `capture-${orderId}`,
  );
}

export async function cancelPaypalSubscription(id: string, reason = "Cancelled by customer") {
  await call("POST", `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { reason });
}

export async function refundPaypalCapture(captureId: string, amountCents?: number, currency = "USD") {
  return call("POST", `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, amountCents ? { amount: { value: (amountCents / 100).toFixed(2), currency_code: currency.toUpperCase() } } : {});
}

/** Verifies a PayPal webhook through PayPal's verification API (the officially supported method). */
export async function verifyPaypalWebhook(headers: Record<string, string | string[] | undefined>, event: unknown): Promise<boolean> {
  const c = serverConfig();
  if (!c.PAYPAL_WEBHOOK_ID) throw unavailable("PAYPAL_WEBHOOK_ID is not configured");
  const h = (k: string) => String(headers[k] ?? "");
  const r = await call<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: h("paypal-auth-algo"),
    cert_url: h("paypal-cert-url"),
    transmission_id: h("paypal-transmission-id"),
    transmission_sig: h("paypal-transmission-sig"),
    transmission_time: h("paypal-transmission-time"),
    webhook_id: c.PAYPAL_WEBHOOK_ID,
    webhook_event: event,
  });
  return r.verification_status === "SUCCESS";
}

export async function paypalPayout(email: string, amountCents: number, currency: string, reference: string) {
  return call<{ batch_header: { payout_batch_id: string } }>("POST", "/v1/payments/payouts", {
    sender_batch_header: { sender_batch_id: reference, email_subject: "Your SKYHOST referral payout" },
    items: [{ recipient_type: "EMAIL", amount: { value: (amountCents / 100).toFixed(2), currency: currency.toUpperCase() }, receiver: email, note: "SKYHOST referral rewards", sender_item_id: reference }],
  }, `payout-${reference}`);
}
