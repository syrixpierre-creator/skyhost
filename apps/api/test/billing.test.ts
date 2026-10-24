import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { creditTransactions, deployments, getDb, gitInstallations, invoices, payments, plans, referralRewards, referrals, services, subscriptions, teams, users } from "@skyhost/db";
import { approveDueRewards, serverConfig } from "@skyhost/core";
import { hmacSha256 } from "@skyhost/shared/node";
import { Client, newUser, setPlan } from "./helpers";
import { TEST_ENV } from "./env";

let seq = 0;
function stripeEvent(type: string, object: Record<string, unknown>) {
  return { id: `evt_test_${Date.now()}_${seq++}`, object: "event", type, data: { object }, api_version: "2025-01-27", created: Math.floor(Date.now() / 1000), livemode: false };
}

async function sendStripe(event: object, secret = TEST_ENV.STRIPE_WEBHOOK_SECRET!) {
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return new Client().post("/api/v1/webhooks/stripe", JSON.parse(payload), { "stripe-signature": header, "content-type": "application/json" });
}

async function plan(slug: string) {
  const [p] = await getDb().select().from(plans).where(eq(plans.slug, slug));
  return p!;
}

describe("Stripe sandbox webhooks -> subscription -> quota -> team", () => {
  it("rejects unsigned, forged and replayed events", async () => {
    const ev = stripeEvent("invoice.paid", {});
    expect((await new Client().post("/api/v1/webhooks/stripe", ev)).status).toBe(400);
    expect((await sendStripe(ev, "whsec_wrong_secret")).status).toBe(400);
    // A signature older than the tolerance window is refused (anti-replay).
    const payload = JSON.stringify(ev);
    const old = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_ENV.STRIPE_WEBHOOK_SECRET!, timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect((await new Client().post("/api/v1/webhooks/stripe", JSON.parse(payload), { "stripe-signature": old })).status).toBe(400);
  });

  it("activates the plan only from a verified webhook and applies its quotas", async () => {
    const u = await newUser();
    const pro = await plan("pro");
    // Before payment: free plan quotas
    expect((await u.client.post("/api/v1/projects", { teamId: u.teamId, name: "P1" })).status).toBe(201);
    expect((await u.client.post("/api/v1/projects", { teamId: u.teamId, name: "P2" })).status).toBe(402);

    const sub = { id: `sub_test_${Date.now()}`, object: "subscription", status: "active", customer: "cus_test_1", cancel_at_period_end: false, metadata: { teamId: u.teamId, planId: pro.id }, items: { data: [{ price: { id: "price_unknown" }, current_period_start: Math.floor(Date.now() / 1000), current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] } };
    const ev = stripeEvent("customer.subscription.created", sub);
    const r = await sendStripe(ev);
    expect(r.status).toBe(200);
    expect(r.body.result).toBe("processed");
    // Idempotency: the same event delivered twice is applied once.
    expect((await sendStripe(ev)).body.result).toBe("duplicate");
    const [team] = await getDb().select().from(teams).where(eq(teams.id, u.teamId));
    expect(team!.planId).toBe(pro.id);
    expect(team!.billingStatus).toBe("active");
    expect((await u.client.post("/api/v1/projects", { teamId: u.teamId, name: "P2" })).status).toBe(201);

    const inv = stripeEvent("invoice.paid", { id: `in_test_${Date.now()}`, object: "invoice", amount_paid: 1500, currency: "usd", payment_intent: `pi_test_${Date.now()}`, subscription: sub.id, hosted_invoice_url: "https://invoice.stripe.com/x", lines: { data: [{ description: "Pro", period: { start: 1, end: 2 } }] } });
    expect((await sendStripe(inv)).body.result).toBe("processed");
    const pays = await getDb().select().from(payments).where(eq(payments.teamId, u.teamId));
    expect(pays).toHaveLength(1);
    const invs = await getDb().select().from(invoices).where(eq(invoices.teamId, u.teamId));
    expect(invs[0]!.number).toMatch(/^SKY-\d{4}-\d{6}$/);
    const pdf = await u.client.get(`/api/v1/invoices/${invs[0]!.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.raw.slice(0, 5)).toBe("%PDF-");

    // Failed renewal -> past_due + grace period
    const failed = stripeEvent("invoice.payment_failed", { id: `in_f_${Date.now()}`, subscription: sub.id, amount_paid: 0 });
    const fr = await sendStripe(failed);
    expect(fr.body.result, JSON.stringify(fr.body)).toBe("processed");
    const [t2] = await getDb().select().from(teams).where(eq(teams.id, u.teamId));
    expect(t2!.billingStatus).toBe("past_due");
    expect(t2!.graceEndsAt).toBeTruthy();

    // Cancellation returns the team to the free plan
    expect((await sendStripe(stripeEvent("customer.subscription.deleted", { id: sub.id }))).body.result).toBe("processed");
    const [t3] = await getDb().select().from(teams).where(eq(teams.id, u.teamId));
    expect(t3!.planId).toBe((await plan("free")).id);
    const [s] = await getDb().select().from(subscriptions).where(eq(subscriptions.providerSubscriptionId, sub.id));
    expect(s!.status).toBe("cancelled");
  });

  it("never activates a subscription from the frontend", async () => {
    const u = await newUser();
    // No endpoint accepts "paid" from the client: checkout only returns a provider URL (or fails without keys).
    const r = await u.client.post(`/api/v1/teams/${u.teamId}/billing/checkout`, { planId: (await plan("pro")).id, provider: "stripe" });
    expect([400, 502, 503, 500]).toContain(r.status);
    const [team] = await getDb().select().from(teams).where(eq(teams.id, u.teamId));
    expect(team!.planId).toBe((await plan("free")).id);
  });

  it("credits top-ups via checkout.session.completed", async () => {
    const u = await newUser();
    const ev = stripeEvent("checkout.session.completed", { id: `cs_${Date.now()}`, mode: "payment", payment_status: "paid", payment_intent: `pi_c_${Date.now()}`, amount_total: 2000, currency: "usd", metadata: { teamId: u.teamId, userId: u.user.id, kind: "credits" } });
    expect((await sendStripe(ev)).body.result).toBe("processed");
    const [team] = await getDb().select().from(teams).where(eq(teams.id, u.teamId));
    expect(team!.creditBalanceCents).toBe(2000);
    const pay = await u.client.post(`/api/v1/teams/${u.teamId}/billing/pay-with-credits`, { planId: (await plan("starter")).id });
    expect(pay.status).toBe(200);
    const [after] = await getDb().select().from(teams).where(eq(teams.id, u.teamId));
    expect(after!.creditBalanceCents).toBe(1500);
    expect(after!.planId).toBe((await plan("starter")).id);
  });
});

describe("referral program", () => {
  it("link -> signup -> paid (sandbox) -> reward credited -> refund -> reward cancelled", async () => {
    const referrer = await newUser({ name: "Referrer" });
    const code = referrer.user.referralCode;
    expect((await new Client().post(`/api/v1/public/referrals/${code}/click`)).body.valid).toBe(true);
    const referee = await newUser({ name: "Referee", referralCode: code });
    const [ref] = await getDb().select().from(referrals).where(eq(referrals.referredUserId, referee.user.id));
    expect(ref!.status).toBe("signed_up");

    const pro = await plan("pro");
    const subId = `sub_ref_${Date.now()}`;
    await sendStripe(stripeEvent("customer.subscription.created", { id: subId, status: "active", metadata: { teamId: referee.teamId, planId: pro.id }, items: { data: [{ price: { id: "p" } }] } }));
    const pi = `pi_ref_${Date.now()}`;
    await sendStripe(stripeEvent("invoice.paid", { id: `in_ref_${Date.now()}`, amount_paid: 1500, currency: "usd", payment_intent: pi, subscription: subId, lines: { data: [] } }));
    const [reward] = await getDb().select().from(referralRewards).where(eq(referralRewards.referrerUserId, referrer.user.id));
    expect(reward).toMatchObject({ status: "pending", amountCents: 300 }); // 20% of 15.00
    // Not credited during the refund window
    expect(await approveDueRewards(new Date())).toBe(0);
    // After the window: approved and credited
    expect(await approveDueRewards(new Date(Date.now() + 15 * 86400_000))).toBe(1);
    const [r1] = await getDb().select().from(users).where(eq(users.id, referrer.user.id));
    expect(r1!.personalCreditCents).toBe(300);
    const dash = await referrer.client.get("/api/v1/referrals");
    expect(dash.body).toMatchObject({ signups: 1, conversions: 1, approvedCents: 300 });
    expect(dash.body.link).toContain(`/r/${code}`);

    // Refund -> reward cancelled and clawed back
    await sendStripe(stripeEvent("charge.refunded", { id: "ch_x", payment_intent: pi, amount_refunded: 1500 }));
    const [after] = await getDb().select().from(referralRewards).where(eq(referralRewards.id, reward!.id));
    expect(after!.status).toBe("cancelled");
    const [r2] = await getDb().select().from(users).where(eq(users.id, referrer.user.id));
    expect(r2!.personalCreditCents).toBe(0);
    const tx = await getDb().select().from(creditTransactions).where(eq(creditTransactions.userId, referrer.user.id));
    expect(tx.map((t) => t.amountCents).sort()).toEqual([-300, 300]);
  });

  it("blocks self-referral and flags same-device signups", async () => {
    const referrer = await newUser();
    const c = new Client();
    c.ip = referrer.client.ip; // same network as the referrer
    const res = await c.post("/api/v1/auth/signup", { email: `self-${Date.now()}@example.com`, password: "correct-horse-42", name: "Me again", acceptTerms: true, referralCode: referrer.user.referralCode });
    expect(res.status).toBe(201);
    const [ref] = await getDb().select().from(referrals).where(eq(referrals.referredUserId, res.body.user.id));
    expect(ref!.status).toBe("flagged");
    expect(ref!.fraudFlags).toContain("same_ip");
  });
});

describe("Git webhooks", () => {
  it("verifies signatures, deduplicates deliveries and auto-deploys the tracked branch", async () => {
    const u = await newUser();
    await setPlan(u.teamId, "pro");
    const p = await u.client.post("/api/v1/projects", { teamId: u.teamId, name: "Git" });
    const [inst] = await getDb().insert(gitInstallations).values({ teamId: u.teamId, provider: "github", externalId: "4242", accountLogin: "acme" }).returning();
    const svc = await u.client.post(`/api/v1/projects/${p.body.project.id}/services`, { name: "web", type: "docker", source: { kind: "image", image: "nginx:alpine" }, deploy: false });
    // Link the service to the repository (validateSource would call GitHub; set it directly).
    await getDb().update(services).set({ source: { kind: "github", repo: "acme/shop", branch: "main", installationId: inst!.id } }).where(eq(services.id, svc.body.service.id));

    const body = { ref: "refs/heads/main", after: "a".repeat(40), repository: { full_name: "acme/shop" }, installation: { id: 4242 }, head_commit: { message: "Add cart", author: { name: "Ada" } }, commits: [] };
    const raw = JSON.stringify(body);
    const sig = `sha256=${hmacSha256(serverConfig().GITHUB_WEBHOOK_SECRET, raw)}`;
    const send = (signature: string, delivery: string) => new Client().post("/api/v1/webhooks/github", JSON.parse(raw), { "x-hub-signature-256": signature, "x-github-event": "push", "x-github-delivery": delivery });
    expect((await send("sha256=deadbeef", "d-1")).status).toBe(401);
    expect((await send(sig, "d-2")).status).toBe(200);
    expect((await send(sig, "d-2")).body.duplicate).toBe(true);
    const deps = await getDb().select().from(deployments).where(eq(deployments.serviceId, svc.body.service.id));
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ trigger: "git", commitSha: "a".repeat(40), commitMessage: "Add cart", branch: "main" });
    // Push to another branch does nothing
    const other = JSON.stringify({ ...body, ref: "refs/heads/feature" });
    await new Client().post("/api/v1/webhooks/github", JSON.parse(other), { "x-hub-signature-256": `sha256=${hmacSha256(serverConfig().GITHUB_WEBHOOK_SECRET, other)}`, "x-github-event": "push", "x-github-delivery": "d-3" });
    expect(await getDb().select().from(deployments).where(and(eq(deployments.serviceId, svc.body.service.id)))).toHaveLength(1);
  });
});

describe("internal endpoints and screenshots sharing", () => {
  it("internal routes require the internal token", async () => {
    expect((await new Client().get("/internal/proxy/traefik")).status).toBe(404);
    const ok = await new Client().get("/internal/proxy/traefik", { "x-skyhost-token": TEST_ENV.SKYHOST_INTERNAL_TOKEN! });
    expect(ok.status).toBe(200);
    expect(ok.body.http).toBeTruthy();
  });

  it("share link -> visible -> revoked -> denied", async () => {
    const u = await newUser();
    const p = await u.client.post("/api/v1/projects", { teamId: u.teamId, name: "Shots" });
    const svc = await u.client.post(`/api/v1/projects/${p.body.project.id}/services`, { name: "web", type: "docker", source: { kind: "image", image: "nginx:alpine" }, deploy: false });
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
    const app = await (await import("./helpers")).getApp();
    const boundary = "----skyhost";
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nCart page\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await app.inject({ method: "POST", url: `/api/v1/services/${svc.body.service.id}/screenshots/upload`, payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}`, cookie: [...u.client.cookies].map(([k, v]) => `${k}=${v}`).join("; "), "x-csrf-token": u.client.cookies.get("sh_csrf")! } });
    expect(up.statusCode).toBe(201);
    const shot = JSON.parse(up.body).screenshot;
    expect(shot.title).toBe("Cart page");
    const share = await u.client.post(`/api/v1/screenshots/${shot.id}/share`, { expiresInDays: 7 });
    const token = share.body.url.split("/").pop();
    const pub = await new Client().get(`/api/v1/public/screenshots/${token}`);
    expect(pub.status).toBe(200);
    expect(pub.headers["content-type"]).toBe("image/png");
    expect((await u.client.del(`/api/v1/screenshots/${shot.id}/share`)).status).toBe(200);
    expect((await new Client().get(`/api/v1/public/screenshots/${token}`)).status).toBe(404);
  });
});

describe("Flutterwave Mobile Money credits", () => {
  it("credits the intended amount from the reference, never the gateway's amount, and rejects currency/amount mismatches", async () => {
    const { handleFlutterwaveTransaction } = await import("@skyhost/core");
    const db = getDb();
    const u = await newUser();
    const t8 = u.teamId.slice(0, 8);
    const balance = async () => (await db.select().from(teams).where(eq(teams.id, u.teamId)))[0]!.creditBalanceCents;
    let id = 7000;
    const tx = (over: Record<string, unknown>) => ({ id: id++, tx_ref: `sky-${t8}-c2000-usd-abcd1234`, status: "successful", amount: 20, currency: "usd", meta: { teamId: u.teamId }, ...over });

    // A legitimate top-up: reference says 2000 cents USD, paid 20 USD → credit exactly 2000.
    expect(await handleFlutterwaveTransaction(tx({}))).toBe("processed");
    expect(await balance()).toBe(2000);

    // Settled in a weaker currency with a huge amount: must NOT credit (currency mismatch).
    expect(await handleFlutterwaveTransaction(tx({ currency: "ngn", amount: 500000 }))).toBe("ignored");
    expect(await balance()).toBe(2000);

    // Paid less than intended: rejected.
    expect(await handleFlutterwaveTransaction(tx({ amount: 1 }))).toBe("ignored");
    expect(await balance()).toBe(2000);

    // Reference not generated by SKYHOST (forged/absent amount): rejected.
    expect(await handleFlutterwaveTransaction(tx({ tx_ref: `evil-${t8}-free-money` }))).toBe("ignored");
    expect(await balance()).toBe(2000);

    // Paying MORE than intended still only credits the intended amount (no inflation from gateway amount).
    expect(await handleFlutterwaveTransaction(tx({ amount: 9999 }))).toBe("processed");
    expect(await balance()).toBe(4000);

    // Replay of the same transaction id is deduplicated.
    const dup = tx({});
    expect(await handleFlutterwaveTransaction(dup)).toBe("processed");
    const b = await balance();
    expect(await handleFlutterwaveTransaction(dup)).toBe("duplicate");
    expect(await balance()).toBe(b);
  });
});
