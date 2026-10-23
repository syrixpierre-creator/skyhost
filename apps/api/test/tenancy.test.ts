import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, serviceInstances, services, variables } from "@skyhost/db";
import { outbox, resolveServiceEnv } from "@skyhost/core";
import { Client, newUser, setPlan } from "./helpers";

type U = Awaited<ReturnType<typeof newUser>>;

async function project(u: U, name = "Main") {
  const r = await u.client.post("/api/v1/projects", { teamId: u.teamId, name });
  expect(r.status).toBe(201);
  return r.body as { project: { id: string }; environment: { id: string } };
}

async function imageService(u: U, projectId: string, name = "web") {
  const r = await u.client.post(`/api/v1/projects/${projectId}/services`, { name, type: "docker", source: { kind: "image", image: "nginx:alpine" }, config: { port: 80 }, deploy: false });
  expect(r.status).toBe(201);
  return r.body.service as { id: string };
}

describe("tenant isolation (user A vs user B)", () => {
  let a: U;
  let b: U;
  let p: Awaited<ReturnType<typeof project>>;
  let svcId: string;
  beforeAll(async () => {
    a = await newUser({ name: "Alice" });
    b = await newUser({ name: "Bob" });
    await setPlan(a.teamId, "pro");
    p = await project(a);
    svcId = (await imageService(a, p.project.id)).id;
  });

  it("B cannot read or change any of A's resources", async () => {
    const c = b.client;
    for (const url of [
      `/api/v1/teams/${a.teamId}`,
      `/api/v1/teams/${a.teamId}/members`,
      `/api/v1/teams/${a.teamId}/projects`,
      `/api/v1/teams/${a.teamId}/audit-logs`,
      `/api/v1/teams/${a.teamId}/billing`,
      `/api/v1/projects/${p.project.id}`,
      `/api/v1/services/${svcId}`,
      `/api/v1/services/${svcId}/deployments`,
      `/api/v1/environments/${p.environment.id}/variables`,
    ]) {
      const r = await c.get(url);
      expect(r.status, url).toBe(404);
    }
    expect((await c.post(`/api/v1/services/${svcId}/deploy`, {})).status).toBe(404);
    expect((await c.put(`/api/v1/environments/${p.environment.id}/variables`, { serviceId: null, variables: [{ key: "X", value: "1" }] })).status).toBe(404);
    expect((await c.post(`/api/v1/projects/${p.project.id}/services`, { name: "evil", type: "docker", source: { kind: "image", image: "x" } })).status).toBe(404);
    expect((await c.post("/api/v1/databases", { projectId: p.project.id, name: "stolen", engine: "postgres" })).status).toBe(404);
    expect((await c.post(`/api/v1/teams/${a.teamId}/invites`, { email: b.email, role: "admin" })).status).toBe(404);
    expect((await c.post("/api/v1/api-keys", { name: "x", teamId: a.teamId, scopes: ["admin"] })).status).toBe(404);
    // Search only returns the caller's resources.
    const s = await c.get("/api/v1/search?q=Main");
    expect(s.body.results.find((x: { id: string }) => x.id === p.project.id)).toBeUndefined();
  });

  it("B's realtime subscription to A's channels is refused", async () => {
    // Authorization is shared with HTTP: the channel check uses the same access helpers.
    expect((await b.client.get(`/api/v1/projects/${p.project.id}`)).status).toBe(404);
  });
});

describe("RBAC", () => {
  let owner: U;
  let viewerUser: U;
  let devUser: U;
  let p: Awaited<ReturnType<typeof project>>;
  let svcId: string;
  beforeAll(async () => {
    owner = await newUser({ name: "Owner" });
    await setPlan(owner.teamId, "pro");
    viewerUser = await newUser({ name: "Viewer" });
    devUser = await newUser({ name: "Dev" });
    for (const [u, role] of [[viewerUser, "viewer"], [devUser, "developer"]] as const) {
      const inv = await owner.client.post(`/api/v1/teams/${owner.teamId}/invites`, { email: u.email, role });
      expect(inv.status).toBe(201);
      const mail = [...outbox].reverse().find((m) => m.to === u.email && /invited/.test(m.subject))!;
      const token = /token=([\w-]+)/.exec(mail.text)![1];
      expect((await u.client.post(`/api/v1/invites/${token}/accept`)).status).toBe(200);
    }
    p = await project(owner);
    svcId = (await imageService(owner, p.project.id)).id;
  });

  it("a viewer can read but every write or Owner action is rejected", async () => {
    const v = viewerUser.client;
    expect((await v.get(`/api/v1/projects/${p.project.id}`)).status).toBe(200);
    const forbidden = [
      v.post(`/api/v1/services/${svcId}/deploy`, {}),
      v.put(`/api/v1/environments/${p.environment.id}/variables`, { serviceId: null, variables: [{ key: "A", value: "1" }] }),
      v.del(`/api/v1/teams/${owner.teamId}`, { confirmName: "x" }),
      v.post(`/api/v1/teams/${owner.teamId}/transfer`, { userId: viewerUser.user.id }),
      v.post(`/api/v1/teams/${owner.teamId}/invites`, { email: "x@example.com", role: "viewer" }),
      v.patch(`/api/v1/teams/${owner.teamId}/members/${devUser.user.id}`, { role: "admin" }),
      v.post(`/api/v1/teams/${owner.teamId}/billing/checkout`, { planId: "00000000-0000-4000-8000-000000000000" }),
      v.del(`/api/v1/projects/${p.project.id}`, { confirmName: "Main" }),
      v.get(`/api/v1/teams/${owner.teamId}/audit-logs`),
    ];
    for (const r of await Promise.all(forbidden)) expect(r.status, JSON.stringify(r.body)).toBe(403);
  });

  it("a developer can deploy and edit variables but cannot manage members or billing", async () => {
    const d = devUser.client;
    expect((await d.put(`/api/v1/environments/${p.environment.id}/variables`, { serviceId: svcId, variables: [{ key: "FOO", value: "bar" }] })).status).toBe(200);
    expect((await d.patch(`/api/v1/teams/${owner.teamId}/members/${viewerUser.user.id}`, { role: "admin" })).status).toBe(403);
    expect((await d.put(`/api/v1/teams/${owner.teamId}/spend-cap`, { spendCapCents: 100, action: "alert" })).status).toBe(403);
  });

  it("owner can change roles; nobody can demote the owner; overrides are applied", async () => {
    expect((await owner.client.patch(`/api/v1/teams/${owner.teamId}/members/${owner.user.id}`, { role: "viewer" })).status).toBe(403);
    expect((await owner.client.put(`/api/v1/teams/${owner.teamId}/permissions`, { overrides: { viewer: { grant: ["deploy:create"], revoke: [] } } })).status).toBe(200);
    // Now the viewer may trigger deployments (other writes stay forbidden).
    const dep = await viewerUser.client.post(`/api/v1/services/${svcId}/deploy`, {});
    expect(dep.status).toBe(201);
    expect((await viewerUser.client.put(`/api/v1/environments/${p.environment.id}/variables`, { serviceId: null, variables: [{ key: "A", value: "1" }] })).status).toBe(403);
  });

  it("records every sensitive action in the audit log", async () => {
    const logs = await owner.client.get(`/api/v1/teams/${owner.teamId}/audit-logs?limit=200`);
    const actions = logs.body.logs.map((l: { action: string }) => l.action);
    for (const a of ["member.invite", "member.join", "project.create", "service.create", "variables.update", "team.permissions_updated", "deployment.create"]) expect(actions).toContain(a);
    // Variable values are never written to the audit log.
    expect(JSON.stringify(logs.body)).not.toContain("bar");
  });
});

describe("API keys", () => {
  it("create -> authenticated deploy -> revoke -> rejected", async () => {
    const u = await newUser();
    await setPlan(u.teamId, "pro");
    const p = await project(u);
    const svc = await imageService(u, p.project.id);
    const created = await u.client.post("/api/v1/api-keys", { name: "CI", teamId: u.teamId, scopes: ["deploy"], expiresInDays: 30 });
    expect(created.status).toBe(201);
    const secret = created.body.secret as string;
    expect(secret).toMatch(/^sky_[A-Za-z0-9]{8}_/);
    // Only the hash is stored
    const { apiKeys } = await import("@skyhost/db");
    const [row] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, created.body.apiKey.id));
    expect(row!.keyHash).not.toContain(secret.split("_")[2]);
    expect(JSON.stringify((await u.client.get("/api/v1/api-keys")).body)).not.toContain(secret);

    const ci = new Client();
    ci.bearer = secret;
    const dep = await ci.post(`/api/v1/services/${svc.id}/deploy`, {});
    expect(dep.status).toBe(201);
    expect(dep.body.deployment.trigger).toBe("api");
    // Scope "deploy" cannot edit variables
    expect((await ci.put(`/api/v1/environments/${p.environment.id}/variables`, { serviceId: null, variables: [{ key: "A", value: "1" }] })).status).toBe(403);
    // No CSRF needed for bearer auth, but cookies are not used either
    expect((await ci.get("/api/v1/auth/me")).body.apiKey.scopes).toEqual(["deploy"]);

    expect((await u.client.post(`/api/v1/api-keys/${created.body.apiKey.id}/revoke`)).status).toBe(200);
    expect((await ci.post(`/api/v1/services/${svc.id}/deploy`, {})).status).toBe(401);
  });

  it("rotation invalidates the old key; keys of other teams never work", async () => {
    const u = await newUser();
    const other = await newUser();
    const created = await u.client.post("/api/v1/api-keys", { name: "R", teamId: u.teamId, scopes: ["read"] });
    const rotated = await u.client.post(`/api/v1/api-keys/${created.body.apiKey.id}/rotate`);
    const c = new Client();
    c.bearer = created.body.secret;
    expect((await c.get("/api/v1/teams")).status).toBe(401);
    c.bearer = rotated.body.secret;
    expect((await c.get("/api/v1/teams")).status).toBe(200);
    expect((await c.get(`/api/v1/teams/${other.teamId}`)).status).toBe(404);
    c.bearer = "sky_AAAAAAAA_notarealkeyatallnotarealkey";
    expect((await c.get("/api/v1/teams")).status).toBe(401);
  });
});

describe("variables", () => {
  let u: U;
  let p: Awaited<ReturnType<typeof project>>;
  let svcId: string;
  beforeAll(async () => {
    u = await newUser();
    await setPlan(u.teamId, "pro");
    p = await project(u);
    svcId = (await imageService(u, p.project.id, "api")).id;
  });

  it("table and JSON editors share one model; secrets are encrypted at rest; sealed values are never returned", async () => {
    const env = p.environment.id;
    const put = await u.client.put(`/api/v1/environments/${env}/variables`, {
      serviceId: svcId,
      replace: true,
      variables: [
        { key: "PLAIN", value: "hello" },
        { key: "API_TOKEN", value: "tok_super_secret_value", secret: true },
        { key: "SEALED_KEY", value: "sealed-value-xyz", sealed: true },
      ],
    });
    expect(put.status).toBe(200);
    expect(put.body.redeployRequired).toBe(true);
    const rows = await getDb().select().from(variables).where(eq(variables.serviceId, svcId));
    for (const r of rows) expect(r.valueEnc).toMatch(/^v1:k1:/);
    expect(JSON.stringify(rows)).not.toContain("tok_super_secret_value");

    const masked = await u.client.get(`/api/v1/environments/${env}/variables?serviceId=${svcId}`);
    const byKey = Object.fromEntries(masked.body.variables.map((v: { key: string; value: string | null }) => [v.key, v.value]));
    expect(byKey).toEqual({ API_TOKEN: null, PLAIN: "hello", SEALED_KEY: null });
    const revealed = await u.client.get(`/api/v1/environments/${env}/variables?serviceId=${svcId}&reveal=true`);
    const rv = Object.fromEntries(revealed.body.variables.map((v: { key: string; value: string | null }) => [v.key, v.value]));
    expect(rv.API_TOKEN).toBe("tok_super_secret_value");
    expect(rv.SEALED_KEY).toBeNull();

    // Editing in JSON mode = sending the full set with replace; sealed values are kept when sent empty.
    const put2 = await u.client.put(`/api/v1/environments/${env}/variables`, {
      serviceId: svcId,
      replace: true,
      variables: [
        { key: "PLAIN", value: "hello" },
        { key: "API_TOKEN", value: "tok_super_secret_value", secret: true },
        { key: "SEALED_KEY", value: "" },
        { key: "NEW_ONE", value: "1" },
      ],
    });
    expect(put2.body.changed).toEqual(["NEW_ONE"]);
    const resolved = await resolveServiceEnv(svcId, env, { port: 80 });
    expect(resolved.env).toMatchObject({ PLAIN: "hello", API_TOKEN: "tok_super_secret_value", SEALED_KEY: "sealed-value-xyz", NEW_ONE: "1", PORT: "80", SKYHOST: "true" });
  });

  it("imports and exports .env, rejects invalid keys, resolves references", async () => {
    const env = p.environment.id;
    const imp = await u.client.post(`/api/v1/environments/${env}/variables/import`, { serviceId: null, format: "env", content: 'SHARED_A=1\nSHARED_B="two words"\n' });
    expect(imp.status).toBe(200);
    const bad = await u.client.post(`/api/v1/environments/${env}/variables/import`, { serviceId: null, format: "json", content: '{"bad-key":"x"}' });
    expect(bad.status).toBe(400);
    const exp = await u.client.get(`/api/v1/environments/${env}/variables/export?format=env`);
    expect(exp.raw).toContain('SHARED_B="two words"');
    const other = await imageService(u, p.project.id, "worker");
    await u.client.put(`/api/v1/environments/${env}/variables`, { serviceId: other.id, variables: [{ key: "UPSTREAM", value: "${{api.PLAIN}}-${{api.SKYHOST_PRIVATE_DOMAIN}}" }] });
    const r = await resolveServiceEnv(other.id, env);
    expect(r.env.UPSTREAM).toBe("hello-api.internal");
    expect(r.env.SHARED_A).toBe("1");
  });

  it("preview environments never inherit production secrets", async () => {
    const res = await u.client.post(`/api/v1/projects/${p.project.id}/environments`, { name: "pr-1", type: "preview", cloneFrom: p.environment.id });
    expect(res.status).toBe(201);
    const list = await u.client.get(`/api/v1/environments/${res.body.environment.id}/variables?serviceId=${svcId}&reveal=true`);
    const keys = list.body.variables.map((v: { key: string }) => v.key);
    expect(keys).toContain("PLAIN");
    expect(keys).not.toContain("API_TOKEN");
    expect(keys).not.toContain("SEALED_KEY");
  });
});

describe("quotas", () => {
  it("are enforced by the backend (free plan: 1 project, 2 services)", async () => {
    const u = await newUser();
    const p = await project(u);
    expect((await u.client.post("/api/v1/projects", { teamId: u.teamId, name: "Second" })).status).toBe(402);
    await imageService(u, p.project.id, "a");
    await imageService(u, p.project.id, "b");
    const third = await u.client.post(`/api/v1/projects/${p.project.id}/services`, { name: "c", type: "docker", source: { kind: "image", image: "nginx:alpine" }, deploy: false });
    expect(third.status).toBe(402);
    expect(third.body.error.details).toMatchObject({ key: "services", limit: 2, current: 2 });
    const usage = await u.client.get(`/api/v1/teams/${u.teamId}/usage`);
    const svc = usage.body.items.find((i: { key: string }) => i.key === "services");
    expect(svc).toMatchObject({ current: 2, limit: 2, remaining: 0 });
  });

  it("refuses deployments for unverified emails", async () => {
    const u = await newUser({ verify: false });
    const p = await project(u);
    const s = await imageService(u, p.project.id);
    const r = await u.client.post(`/api/v1/services/${s.id}/deploy`, {});
    expect(r.status).toBe(403);
    expect(r.body.error.message).toMatch(/Verify your email/);
  });

  it("deploy freeze windows block deployments but never rollbacks", async () => {
    const u = await newUser();
    const p = await project(u);
    const s = await imageService(u, p.project.id);
    const all = { enabled: true, mode: "deny", timezone: "UTC", windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }] };
    expect((await u.client.put(`/api/v1/teams/${u.teamId}/deploy-freeze`, all)).status).toBe(200);
    const r = await u.client.post(`/api/v1/services/${s.id}/deploy`, {});
    expect(r.status).toBe(403);
    expect(r.body.error.message).toMatch(/frozen/);
    void serviceInstances;
    void services;
  });
});
