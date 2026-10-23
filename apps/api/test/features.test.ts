import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { creditTransactions, deployments, getDb, teams, users } from "@skyhost/db";
import { EMAIL_BY_DEFAULT, getQueue, githubAppJwt, notify, QUEUES, resetServerConfig } from "@skyhost/core";
import { Client, newUser, setPlan } from "./helpers";
import { TEST_ENV } from "./env";

async function adminUser() {
  const a = await newUser({ name: "Admin" });
  await getDb().update(users).set({ isAdmin: true }).where(eq(users.id, a.user.id));
  return a;
}

async function imageService(u: Awaited<ReturnType<typeof newUser>>) {
  const p = await u.client.post("/api/v1/projects", { teamId: u.teamId, name: `Hooks ${Date.now()}` });
  const s = await u.client.post(`/api/v1/projects/${p.body.project.id}/services`, { name: "web", type: "web", source: { kind: "image", image: "nginx:alpine" }, config: { port: 80 }, deploy: false });
  expect(s.status, s.raw).toBe(201);
  return { projectId: p.body.project.id as string, environmentId: p.body.environment.id as string, serviceId: s.body.service.id as string };
}

describe("capabilities: unconfigured features are reported, not failed", () => {
  it("lists what the installation can do", async () => {
    const r = await new Client().get("/api/v1/capabilities");
    expect(r.status).toBe(200);
    expect(r.body.auth).toMatchObject({ password: true, google: false, github: false, gitlab: false });
    expect(r.body.git).toMatchObject({ github: false, gitlab: false, bitbucket: false });
    // The test environment has no SMTP: verification cannot be required.
    expect(r.body.email).toEqual({ delivery: false, verificationRequired: false });
    expect(r.body.maintenance).toEqual({ enabled: false });
  });

  it("an unconfigured sign-in provider sends the user back to the sign-in page with a message", async () => {
    const r = await new Client().get("/api/v1/auth/oauth/google/start");
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain(`${TEST_ENV.SKYHOST_DASHBOARD_URL}/login?error=`);
    expect(decodeURIComponent(String(r.headers.location))).toContain("not available yet");
  });
});

describe("promo codes", () => {
  it("fixed-amount codes become credits once per team; limits and expiry are enforced", async () => {
    const admin = await adminUser();
    const code = `WELCOME${Date.now() % 100000}`;
    expect((await admin.client.post("/api/v1/admin/discounts", { code, amountOffCents: 1500, maxRedemptions: 2 })).status).toBe(201);

    const a = await newUser();
    const r = await a.client.post(`/api/v1/teams/${a.teamId}/billing/promo`, { code: code.toLowerCase() });
    expect(r.status, r.raw).toBe(200);
    expect(r.body.promo).toMatchObject({ kind: "credits", amountCents: 1500 });
    const [t] = await getDb().select().from(teams).where(eq(teams.id, a.teamId));
    expect(t!.creditBalanceCents).toBe(1500);
    expect((await getDb().select().from(creditTransactions).where(eq(creditTransactions.teamId, a.teamId))).map((x) => x.reason)).toEqual(["promo"]);
    // Same team again
    expect((await a.client.post(`/api/v1/teams/${a.teamId}/billing/promo`, { code })).status).toBe(409);
    // Second team uses the last redemption, third is refused
    const b = await newUser();
    expect((await b.client.post(`/api/v1/teams/${b.teamId}/billing/promo`, { code })).status).toBe(200);
    const c = await newUser();
    const over = await c.client.post(`/api/v1/teams/${c.teamId}/billing/promo`, { code });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toContain("usage limit");
    // Unknown and expired codes
    expect((await c.client.post(`/api/v1/teams/${c.teamId}/billing/promo`, { code: "NOPE-NOPE" })).status).toBe(404);
    const expired = `OLD${Date.now() % 100000}`;
    await admin.client.post("/api/v1/admin/discounts", { code: expired, amountOffCents: 100, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await c.client.post(`/api/v1/teams/${c.teamId}/billing/promo`, { code: expired })).status).toBe(400);
    // Another team cannot redeem for a team it does not belong to
    expect((await c.client.post(`/api/v1/teams/${a.teamId}/billing/promo`, { code })).status).toBe(404);
  });

  it("percentage codes apply once to the next plan payment", async () => {
    const admin = await adminUser();
    const code = `HALF${Date.now() % 100000}`;
    await admin.client.post("/api/v1/admin/discounts", { code, percentOff: 50 });
    const u = await newUser();
    await getDb().update(teams).set({ creditBalanceCents: 10_000 }).where(eq(teams.id, u.teamId));
    const r = await u.client.post(`/api/v1/teams/${u.teamId}/billing/promo`, { code });
    expect(r.body.promo).toMatchObject({ kind: "percent", percentOff: 50 });
    const overview = await u.client.get(`/api/v1/teams/${u.teamId}/billing`);
    expect(overview.body.pendingDiscount).toMatchObject({ code, percentOff: 50 });
    const usage = await u.client.get(`/api/v1/teams/${u.teamId}/billing/usage`);
    expect(usage.status).toBe(200);
    expect(usage.body.estimate.promo).toMatchObject({ percentOff: 50 });

    const plans = await new Client().get("/api/v1/plans");
    const starter = plans.body.plans.find((p: { slug: string }) => p.slug === "starter");
    const pay = await u.client.post(`/api/v1/teams/${u.teamId}/billing/pay-with-credits`, { planId: starter.id });
    expect(pay.status, pay.raw).toBe(200);
    const [t] = await getDb().select().from(teams).where(eq(teams.id, u.teamId));
    expect(t!.creditBalanceCents).toBe(10_000 - Math.round(starter.priceCents / 2));
    expect(t!.pendingDiscountId).toBeNull();
    const after = await u.client.get(`/api/v1/teams/${u.teamId}/billing`);
    expect(after.body.pendingDiscount).toBeNull();
    expect(after.body.promoCodes[0]).toMatchObject({ code, status: "applied" });
  });
});

describe("deploy hooks", () => {
  it("a secret URL deploys the service; revoked hooks stop working", async () => {
    const u = await newUser();
    const s = await imageService(u);
    const created = await u.client.post(`/api/v1/services/${s.serviceId}/deploy-hooks`, { name: "CI", environmentId: s.environmentId });
    expect(created.status, created.raw).toBe(201);
    const url = new URL(created.body.url);
    const fire = await new Client().post(url.pathname, {});
    expect(fire.status, fire.raw).toBe(201);
    const [d] = await getDb().select().from(deployments).where(eq(deployments.id, fire.body.deployment.id));
    expect(d!.trigger).toBe("hook");
    expect(d!.serviceId).toBe(s.serviceId);
    const list = await u.client.get(`/api/v1/services/${s.serviceId}/deploy-hooks`);
    expect(list.body.hooks[0].lastUsedAt).toBeTruthy();
    expect(JSON.stringify(list.body)).not.toContain(url.pathname.split("/").pop());
    // Another team cannot see or revoke it
    const other = await newUser();
    expect((await other.client.get(`/api/v1/services/${s.serviceId}/deploy-hooks`)).status).toBe(404);
    expect((await other.client.del(`/api/v1/deploy-hooks/${created.body.hook.id}`)).status).toBe(404);
    expect((await u.client.del(`/api/v1/deploy-hooks/${created.body.hook.id}`)).status).toBe(200);
    expect((await new Client().post(url.pathname, {})).status).toBe(404);
  });
});

describe("maintenance", () => {
  it("platform maintenance is announced and pauses new deployments", async () => {
    const admin = await adminUser();
    const u = await newUser();
    await setPlan(u.teamId, "pro");
    const s = await imageService(u);
    try {
      const on = await admin.client.put("/api/v1/admin/settings/maintenance", { enabled: true, message: "Database upgrade", blockDeploys: true, endsAt: null });
      expect(on.status, on.raw).toBe(200);
      const caps = await new Client().get("/api/v1/capabilities");
      expect(caps.body.maintenance).toMatchObject({ enabled: true, message: "Database upgrade", blockDeploys: true });
      const dep = await u.client.post(`/api/v1/services/${s.serviceId}/deploy`, { environmentId: s.environmentId });
      expect(dep.status).toBe(503);
      expect(dep.body.error.message).toContain("Database upgrade");
      // Regular users cannot change it
      expect((await u.client.put("/api/v1/admin/settings/maintenance", { enabled: false })).status).toBe(404);
    } finally {
      await admin.client.put("/api/v1/admin/settings/maintenance", { enabled: false });
    }
    expect((await u.client.post(`/api/v1/services/${s.serviceId}/deploy`, { environmentId: s.environmentId })).status).toBe(201);
  });

  it("a service maintenance page answers 503 with the owner's message", async () => {
    const u = await newUser();
    const s = await imageService(u);
    const p = await u.client.patch(`/api/v1/services/${s.serviceId}`, { config: { maintenance: { enabled: true, message: "Back at <b>noon</b>" } } });
    expect(p.status, p.raw).toBe(200);
    const page = await new Client().get("/internal/maintenance/", { "x-skyhost-token": TEST_ENV.SKYHOST_INTERNAL_TOKEN!, "x-skyhost-service-id": s.serviceId });
    expect(page.status).toBe(503);
    expect(page.headers["retry-after"]).toBe("300");
    expect(page.raw).toContain("Back at &lt;b&gt;noon&lt;/b&gt;");
    // Without the internal token the page is not reachable directly
    expect((await new Client().get("/internal/maintenance/", { "x-skyhost-service-id": s.serviceId })).status).toBe(404);
  });
});

describe("alert emails", () => {
  it("a crash reaches every member's inbox with the diagnosis and the last log lines", async () => {
    const u = await newUser();
    const queue = getQueue(QUEUES.notify);
    const before = new Set((await queue.getJobs(["waiting", "delayed", "prioritized"])).map((j) => j.id));
    await notify({
      teamId: u.teamId,
      event: "service.crashed",
      title: "web crashed",
      body: "The process exited and was restarted (1 restart).",
      link: "/projects/p/services/s?tab=logs",
      details: [["Cause", "The application listens on port 3000 but the service expects 8080."]],
      logs: "Server listening on :3000\nError: <script>boom</script>",
    });
    const jobs = (await queue.getJobs(["waiting", "delayed", "prioritized"])).filter((j) => !before.has(j.id) && (j.data as { email?: string }).email === u.email);
    expect(jobs).toHaveLength(1);
    const mail = jobs[0]!.data as { subject: string; text: string; html: string };
    expect(mail.subject).toBe("[SKYHOST] web crashed");
    expect(mail.text).toContain("Cause: The application listens on port 3000");
    expect(mail.text).toContain("Last log lines:");
    expect(mail.html).toContain("&lt;script&gt;boom&lt;/script&gt;");
    expect(mail.html).not.toContain("<script>boom");
    expect(mail.html).toContain(`${TEST_ENV.SKYHOST_DASHBOARD_URL}/projects/p/services/s?tab=logs`);
    for (const j of jobs) await j.remove();
  });

  it("outages and failures are emailed by default; a member can opt out", async () => {
    expect(EMAIL_BY_DEFAULT).toEqual(expect.arrayContaining(["service.crashed", "service.unhealthy", "deployment.failed", "billing.payment_failed"]));
    const u = await newUser();
    const prefs = await u.client.get("/api/v1/account/notification-preferences");
    expect(prefs.body.emailDefaults).toContain("service.unhealthy");
    await u.client.put("/api/v1/account/notification-preferences", { preferences: { "service.unhealthy": { email: false } } });
    const queue = getQueue(QUEUES.notify);
    const before = new Set((await queue.getJobs(["waiting", "delayed", "prioritized"])).map((j) => j.id));
    await notify({ teamId: u.teamId, event: "service.unhealthy", title: "web is down", body: "No replica is running." });
    const mine = (await queue.getJobs(["waiting", "delayed", "prioritized"])).filter((j) => !before.has(j.id) && (j.data as { email?: string }).email === u.email);
    expect(mine).toHaveLength(0);
  });
});

describe("GitHub App", () => {
  it("signs its JWT with a numeric issuer, as GitHub requires for an App ID", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString().replace(/\n/g, "\\n");
    const saved = { id: process.env.GITHUB_APP_ID, key: process.env.GITHUB_APP_PRIVATE_KEY };
    process.env.GITHUB_APP_ID = " 1234567 ";
    process.env.GITHUB_APP_PRIVATE_KEY = pem;
    resetServerConfig();
    try {
      const claims = JSON.parse(Buffer.from((await githubAppJwt()).split(".")[1]!, "base64url").toString());
      expect(claims.iss).toBe(1234567);
      expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    } finally {
      process.env.GITHUB_APP_ID = saved.id ?? "";
      process.env.GITHUB_APP_PRIVATE_KEY = saved.key ?? "";
      resetServerConfig();
    }
  });
});

describe("deployment page", () => {
  it("returns the public URL of the service with the deployment", async () => {
    const u = await newUser();
    const s = await imageService(u);
    const dep = await u.client.post(`/api/v1/services/${s.serviceId}/deploy`, { environmentId: s.environmentId });
    expect(dep.status, dep.raw).toBe(201);
    const r = await u.client.get(`/api/v1/deployments/${dep.body.deployment.id}`);
    expect(r.status).toBe(200);
    expect(r.body.url).toMatch(new RegExp(`^https?://web-[a-z0-9]+\\.${TEST_ENV.SKYHOST_BASE_DOMAIN!.replace(/\./g, "\\.")}$`));
  });
});
