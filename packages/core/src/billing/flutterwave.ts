import { safeEqual } from "@skyhost/shared/node";
import { serverConfig } from "../config";
import { unavailable } from "../errors";

/**
 * Local payment methods (Mobile Money: M-Pesa, MTN, Orange, Airtel...) through the Flutterwave aggregator.
 * Used for prepaid credit top-ups. Every webhook is verified, then the transaction is re-verified via the API.
 */
export function flutterwaveConfigured() {
  const c = serverConfig();
  return !!c.FLUTTERWAVE_SECRET_KEY && c.SKYHOST_PAYMENTS_ENABLED;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const c = serverConfig();
  if (!c.FLUTTERWAVE_SECRET_KEY) throw unavailable("Mobile Money payments are not configured");
  if (!c.SKYHOST_PAYMENTS_ENABLED) throw unavailable("Payments are disabled in this environment");
  const res = await fetch(`${c.FLUTTERWAVE_API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${c.FLUTTERWAVE_SECRET_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = (await res.json()) as T & { status?: string; message?: string };
  if (!res.ok || j.status === "error") throw new Error(`Flutterwave ${path} failed: ${j.message ?? res.status}`);
  return j;
}

export async function createMobileMoneyPayment(o: { txRef: string; amountCents: number; currency: string; email: string; name: string; redirectUrl: string; teamId: string }) {
  const r = await call<{ data: { link: string } }>("POST", "/payments", {
    tx_ref: o.txRef,
    amount: (o.amountCents / 100).toFixed(2),
    currency: o.currency.toUpperCase(),
    redirect_url: o.redirectUrl,
    payment_options: "mobilemoneyghana,mobilemoneyuganda,mobilemoneyrwanda,mobilemoneyzambia,mobilemoneyfranco,mpesa,card",
    customer: { email: o.email, name: o.name },
    meta: { teamId: o.teamId, kind: "credits" },
    customizations: { title: "SKYHOST credits" },
  });
  return r.data.link;
}

/** The webhook carries a static secret hash in the verif-hash header. */
export function verifyFlutterwaveHash(header: string | undefined): boolean {
  const expected = serverConfig().FLUTTERWAVE_WEBHOOK_HASH;
  if (!expected) throw unavailable("FLUTTERWAVE_WEBHOOK_HASH is not configured");
  return !!header && safeEqual(header, expected);
}

export async function verifyFlutterwaveTransaction(id: string | number) {
  return call<{ data: { id: number; tx_ref: string; status: string; amount: number; currency: string; meta?: Record<string, string>; card?: { first_6digits?: string; last_4digits?: string } } }>(
    "GET",
    `/transactions/${encodeURIComponent(String(id))}/verify`,
  );
}
